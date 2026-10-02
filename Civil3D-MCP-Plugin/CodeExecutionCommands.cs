using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using DisposableWrapper = Autodesk.AutoCAD.Runtime.DisposableWrapper;

namespace Civil3DMcpPlugin;

/// <summary>
/// Globals visible to execute_code scripts. Members are referenced by name in
/// caller code (Doc, Db, Ed, CivilDoc, Tr, Log), so they must stay public and stable.
/// </summary>
public sealed class CodeExecutionGlobals
{
  private readonly ScriptOutputBuffer _output;

  internal CodeExecutionGlobals(
    Document doc,
    Database db,
    Editor ed,
    CivilDocument civilDoc,
    Transaction tr,
    ScriptOutputBuffer output,
    CancellationToken cancellationToken)
  {
    Doc = doc;
    Db = db;
    Ed = ed;
    CivilDoc = civilDoc;
    Tr = tr;
    _output = output;
    CancellationToken = cancellationToken;
  }

  public Document Doc { get; }

  public Database Db { get; }

  public Editor Ed { get; }

  public CivilDocument CivilDoc { get; }

  /// <summary>The single transaction the plugin opened for this execution.</summary>
  public Transaction Tr { get; }

  /// <summary>Signalled when timeoutMs elapses or the caller disconnects.</summary>
  public CancellationToken CancellationToken { get; }

  /// <summary>Appends a line to the captured output and honours cancellation.</summary>
  public void Log(string? message)
  {
    CancellationToken.ThrowIfCancellationRequested();
    _output.AppendLine(message);
  }

  public void Log(object? value) => Log(value?.ToString());
}

public static class CodeExecutionCommands
{
  public const int DefaultTimeoutMs = 60_000;
  public const int MinTimeoutMs = 1_000;
  public const int MaxTimeoutMs = 300_000;
  public const int MaxCodeLength = 200_000;

  private static readonly string[] AutodeskReferenceNames =
  [
    "AcDbMgd",
    "acmgd",
    "accoremgd",
    "AecBaseMgd",
    "AeccDbMgd",
    "AeccPressurePipesMgd",
  ];

  private static readonly string[] ScriptImports =
  [
    "System",
    "System.Linq",
    "System.Collections.Generic",
    "System.Text",
    "Autodesk.AutoCAD.ApplicationServices",
    "Autodesk.AutoCAD.DatabaseServices",
    "Autodesk.AutoCAD.EditorInput",
    "Autodesk.AutoCAD.Geometry",
    "Autodesk.AutoCAD.Colors",
    "Autodesk.Civil",
    "Autodesk.Civil.ApplicationServices",
    "Autodesk.Civil.DatabaseServices",
    "Autodesk.Civil.DatabaseServices.Styles",
    "Autodesk.Civil.Settings",
  ];

  // Resolve names that exist in both the AutoCAD and Civil 3D DatabaseServices
  // namespaces. #line 1 keeps compile error positions relative to caller code.
  private const string ScriptPrelude =
    "using Surface = Autodesk.Civil.DatabaseServices.Surface;\n" +
    "using Section = Autodesk.Civil.DatabaseServices.Section;\n" +
    "using Entity = Autodesk.AutoCAD.DatabaseServices.Entity;\n" +
    "#line 1\n";

  private static readonly Lazy<CodeScriptEngine> Engine = new(
    () => new CodeScriptEngine(ResolveReferencePaths(), ScriptImports, typeof(CodeExecutionGlobals), ScriptPrelude),
    LazyThreadSafetyMode.PublicationOnly);

  private static readonly JsonSerializerOptions ReturnValueOptions = new()
  {
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    ReferenceHandler = ReferenceHandler.IgnoreCycles,
    MaxDepth = 32,
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
    Converters = { new AutodeskValueConverterFactory() },
  };

  public static async Task<object?> ExecuteCodeAsync(JsonObject? parameters)
  {
    var code = PluginRuntime.GetRequiredString(parameters, "code");
    if (code.Length > MaxCodeLength)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", $"Parameter 'code' exceeds {MaxCodeLength} characters.");
    }

    var mode = (PluginRuntime.GetOptionalString(parameters, "mode") ?? "write").Trim().ToLowerInvariant();
    if (mode is not ("write" or "read"))
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "Parameter 'mode' must be 'write' or 'read'.");
    }

    var timeoutMs = PluginRuntime.GetOptionalInt(parameters, "timeoutMs") ?? DefaultTimeoutMs;
    if (timeoutMs < MinTimeoutMs || timeoutMs > MaxTimeoutMs)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        $"Parameter 'timeoutMs' must be between {MinTimeoutMs} and {MaxTimeoutMs}.");
    }

    // Refuse instead of queueing behind a modal dialog or user command.
    CivilExecution.EnsureHostIdle("execute_code");

    var stopwatch = Stopwatch.StartNew();
    var codeHash = CodeScriptEngine.HashCode(code)[..12];
    var requestToken = PluginRuntime.GetCurrentRequestCancellationToken();
    using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(requestToken);
    timeoutSource.CancelAfter(timeoutMs);

    CodeScriptEngine engine;
    try
    {
      engine = Engine.Value;
    }
    catch (Exception exception)
    {
      PluginLog.Error("CodeExecution", "Unable to initialize the C# script engine", exception);
      throw new JsonRpcDispatchException("CIVIL3D.API_ERROR", $"Unable to initialize the C# script engine: {exception.Message}");
    }

    // Compile on the RPC thread so Civil 3D's main thread is never blocked by Roslyn.
    ScriptCompilation compilation;
    try
    {
      compilation = await Task.Run(() => engine.Compile(code, timeoutSource.Token), timeoutSource.Token);
    }
    catch (OperationCanceledException) when (!requestToken.IsCancellationRequested)
    {
      return BuildResult(mode, false, null, new ScriptOutputBuffer(0), [], TimeoutError(timeoutMs, "compilation"), stopwatch, false, false);
    }

    if (compilation.Script == null)
    {
      PluginLog.Info("CodeExecution", $"hash={codeHash} mode={mode} compile errors={compilation.Errors.Count}");
      return BuildResult(mode, false, null, new ScriptOutputBuffer(0), compilation.Errors, null, stopwatch, false, false);
    }

    var script = compilation.Script;
    var output = new ScriptOutputBuffer(CodeScriptEngine.MaxOutputChars);
    var result = await CivilExecution.ExecuteInTransactionAsync<object?>(async (doc, civilDoc, database, transaction) =>
    {
      var globals = new CodeExecutionGlobals(doc, database, doc.Editor, civilDoc, transaction, output, timeoutSource.Token);
      var outcome = await CodeScriptEngine.RunAsync(script, globals, timeoutSource.Token);
      requestToken.ThrowIfCancellationRequested();

      var runtimeError = outcome.Error;
      if (timeoutSource.IsCancellationRequested || stopwatch.ElapsedMilliseconds > timeoutMs)
      {
        // Scripts run synchronously on Civil 3D's main thread and cannot be
        // pre-empted; a late finish is still never committed.
        runtimeError = TimeoutError(timeoutMs, "execution");
      }

      JsonNode? returnValue = null;
      var valueTruncated = false;
      if (runtimeError == null)
      {
        (returnValue, valueTruncated) = CodeScriptEngine.SerializeReturnValue(outcome.ReturnValue, ReturnValueOptions);
      }

      var committed = false;
      if (runtimeError == null && mode == "write")
      {
        try
        {
          transaction.Commit();
          committed = true;
        }
        catch (Exception exception)
        {
          runtimeError = CodeScriptEngine.Describe(exception);
        }
      }

      if (!committed)
      {
        try
        {
          transaction.Abort();
        }
        catch (Exception)
        {
          // Dispose aborts any transaction that is still open.
        }
      }

      return BuildResult(mode, runtimeError == null, returnValue, output, [], runtimeError, stopwatch, valueTruncated, committed);
    });

    PluginLog.Info("CodeExecution", $"hash={codeHash} mode={mode} cached={compilation.FromCache} durationMs={stopwatch.ElapsedMilliseconds}");
    return result;
  }

  private static Dictionary<string, object?> BuildResult(
    string mode,
    bool success,
    JsonNode? returnValue,
    ScriptOutputBuffer output,
    IReadOnlyList<ScriptCompileError> compileErrors,
    ScriptRuntimeError? runtimeError,
    Stopwatch stopwatch,
    bool valueTruncated,
    bool committed)
  {
    return new Dictionary<string, object?>
    {
      ["success"] = success,
      ["mode"] = mode,
      ["returnValue"] = returnValue,
      ["output"] = output.ToString(),
      ["compileErrors"] = compileErrors.Select(error => new Dictionary<string, object?>
      {
        ["line"] = error.Line,
        ["column"] = error.Column,
        ["id"] = error.Id,
        ["message"] = error.Message,
      }).ToList(),
      ["runtimeError"] = runtimeError == null
        ? null
        : new Dictionary<string, object?>
        {
          ["type"] = runtimeError.Type,
          ["message"] = runtimeError.Message,
          ["stackTrace"] = runtimeError.StackTrace,
        },
      ["durationMs"] = stopwatch.ElapsedMilliseconds,
      ["truncated"] = valueTruncated || output.Truncated,
      ["committed"] = committed,
    };
  }

  private static ScriptRuntimeError TimeoutError(int timeoutMs, string phase) => new(
    "System.TimeoutException",
    $"Code {phase} exceeded timeoutMs={timeoutMs}. The transaction was aborted and no drawing changes were committed.",
    null);

  private static List<string> ResolveReferencePaths()
  {
    var byName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    // Framework assemblies the host runtime trusts, whether or not they are loaded yet.
    if (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") is string trustedPlatformAssemblies)
    {
      foreach (var path in trustedPlatformAssemblies.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
      {
        var name = Path.GetFileNameWithoutExtension(path);
        if (IsFrameworkReference(name))
        {
          byName.TryAdd(name, path);
        }
      }
    }

    var pluginAssemblyPath = typeof(CodeExecutionGlobals).Assembly.Location;
    var pluginAssemblyName = Path.GetFileNameWithoutExtension(pluginAssemblyPath);
    foreach (var (name, location) in Civil3DCompatibility.GetLoadedAssemblyFiles())
    {
      if (IsFrameworkReference(name)
        || AutodeskReferenceNames.Contains(name, StringComparer.OrdinalIgnoreCase)
        || string.Equals(name, pluginAssemblyName, StringComparison.OrdinalIgnoreCase))
      {
        byName[name] = location;
      }
    }

    if (!string.IsNullOrWhiteSpace(pluginAssemblyPath))
    {
      byName[pluginAssemblyName] = pluginAssemblyPath;
    }

    // Autodesk assemblies load lazily; find any not yet loaded next to the ones that are.
    var probeDirectories = byName
      .Where(entry => AutodeskReferenceNames.Contains(entry.Key, StringComparer.OrdinalIgnoreCase))
      .Select(entry => Path.GetDirectoryName(entry.Value))
      .Where(directory => !string.IsNullOrWhiteSpace(directory))
      .Select(directory => directory!)
      .Distinct(StringComparer.OrdinalIgnoreCase)
      .ToList();
    foreach (var name in AutodeskReferenceNames.Where(name => !byName.ContainsKey(name)))
    {
      var candidate = probeDirectories
        .Select(directory => Path.Combine(directory, $"{name}.dll"))
        .FirstOrDefault(File.Exists);
      if (candidate != null)
      {
        byName[name] = candidate;
      }
      else
      {
        PluginLog.Info("CodeExecution", $"Reference assembly '{name}' was not found; scripts cannot use its types.");
      }
    }

    return byName.Values.ToList();
  }

  private static bool IsFrameworkReference(string name) =>
    name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
    || name is "System" or "mscorlib" or "netstandard" or "Microsoft.CSharp" or "Microsoft.Win32.Primitives";

  /// <summary>
  /// Keeps return-value serialization bounded: Autodesk wrappers are summarized
  /// instead of walking native object graphs through their public properties.
  /// </summary>
  private sealed class AutodeskValueConverterFactory : JsonConverterFactory
  {
    public override bool CanConvert(Type typeToConvert) =>
      typeToConvert == typeof(ObjectId)
      || typeToConvert == typeof(Handle)
      || typeToConvert == typeof(Point3d)
      || typeToConvert == typeof(Point2d)
      || typeToConvert == typeof(Vector3d)
      || typeToConvert == typeof(Vector2d)
      || typeof(ObjectIdCollection).IsAssignableFrom(typeToConvert)
      || typeof(DisposableWrapper).IsAssignableFrom(typeToConvert);

    public override JsonConverter CreateConverter(Type typeToConvert, JsonSerializerOptions options) =>
      (JsonConverter)Activator.CreateInstance(typeof(AutodeskValueConverter<>).MakeGenericType(typeToConvert))!;
  }

  private sealed class AutodeskValueConverter<T> : JsonConverter<T>
  {
    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
      throw new NotSupportedException("Autodesk values are serialized for output only.");

    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options)
    {
      switch (value)
      {
        case null:
          writer.WriteNullValue();
          break;
        case ObjectId objectId:
          WriteObjectId(writer, objectId);
          break;
        case Handle handle:
          writer.WriteStringValue(handle.ToString());
          break;
        case Point3d point:
          writer.WriteStartObject();
          writer.WriteNumber("x", point.X);
          writer.WriteNumber("y", point.Y);
          writer.WriteNumber("z", point.Z);
          writer.WriteEndObject();
          break;
        case Point2d point:
          writer.WriteStartObject();
          writer.WriteNumber("x", point.X);
          writer.WriteNumber("y", point.Y);
          writer.WriteEndObject();
          break;
        case Vector3d vector:
          writer.WriteStartObject();
          writer.WriteNumber("x", vector.X);
          writer.WriteNumber("y", vector.Y);
          writer.WriteNumber("z", vector.Z);
          writer.WriteEndObject();
          break;
        case Vector2d vector:
          writer.WriteStartObject();
          writer.WriteNumber("x", vector.X);
          writer.WriteNumber("y", vector.Y);
          writer.WriteEndObject();
          break;
        case ObjectIdCollection objectIds:
          writer.WriteStartArray();
          foreach (ObjectId objectId in objectIds)
          {
            WriteObjectId(writer, objectId);
          }
          writer.WriteEndArray();
          break;
        case DBObject dbObject:
          writer.WriteStartObject();
          writer.WriteString("type", dbObject.GetType().Name);
          writer.WriteString("handle", dbObject.Handle.ToString());
          writer.WriteString("name", CivilObjectUtils.GetName(dbObject));
          writer.WriteEndObject();
          break;
        default:
          writer.WriteStartObject();
          writer.WriteString("type", value.GetType().Name);
          writer.WriteString("value", CodeScriptEngine.SafeToString(value));
          writer.WriteEndObject();
          break;
      }
    }

    private static void WriteObjectId(Utf8JsonWriter writer, ObjectId objectId)
    {
      if (objectId.IsNull)
      {
        writer.WriteNullValue();
        return;
      }

      writer.WriteStartObject();
      writer.WriteString("handle", objectId.Handle.ToString());
      writer.WriteString("objectClass", objectId.ObjectClass?.Name);
      writer.WriteEndObject();
    }
  }
}
