using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.CodeAnalysis.CSharp.Scripting;
using Microsoft.CodeAnalysis.Scripting;
using RoslynDiagnostic = Microsoft.CodeAnalysis.Diagnostic;
using RoslynDiagnosticSeverity = Microsoft.CodeAnalysis.DiagnosticSeverity;
using RoslynMetadataReference = Microsoft.CodeAnalysis.MetadataReference;
using RoslynOptimizationLevel = Microsoft.CodeAnalysis.OptimizationLevel;

namespace Civil3DMcpPlugin;

internal sealed record ScriptCompileError(int Line, int Column, string Id, string Message);

internal sealed record ScriptRuntimeError(string Type, string Message, string? StackTrace);

internal sealed record ScriptCompilation(Script<object>? Script, IReadOnlyList<ScriptCompileError> Errors, bool FromCache);

internal sealed record ScriptRunOutcome(object? ReturnValue, ScriptRuntimeError? Error);

/// <summary>
/// Autodesk-independent Roslyn scripting core for execute_code: compilation with
/// a bounded LRU cache keyed by code hash, diagnostic mapping, exception capture,
/// and size-capped JSON serialization of return values. Host-specific globals,
/// references, and transaction handling live in CodeExecutionCommands.
/// </summary>
internal sealed class CodeScriptEngine
{
  public const int MaxOutputChars = 100 * 1024;
  private const string ScriptFileName = "execute_code.csx";

  private readonly ScriptOptions _options;
  private readonly Type _globalsType;
  private readonly string _prelude;
  private readonly int _cacheCapacity;
  private readonly object _cacheSync = new();
  private readonly Dictionary<string, LinkedListNode<KeyValuePair<string, Script<object>>>> _cacheIndex = new(StringComparer.Ordinal);
  private readonly LinkedList<KeyValuePair<string, Script<object>>> _cacheOrder = new();

  /// <param name="prelude">
  /// Source placed before the caller's code (for example using aliases). It must
  /// end with a <c>#line 1</c> directive so diagnostics map to caller line numbers.
  /// </param>
  public CodeScriptEngine(
    IEnumerable<string> referencePaths,
    IEnumerable<string> imports,
    Type globalsType,
    string prelude = "",
    int cacheCapacity = 32)
  {
    _options = ScriptOptions.Default
      .WithReferences(referencePaths.Select(path => RoslynMetadataReference.CreateFromFile(path)))
      .WithImports(imports)
      .WithOptimizationLevel(RoslynOptimizationLevel.Release)
      .WithAllowUnsafe(false)
      .WithEmitDebugInformation(true)
      .WithFilePath(ScriptFileName)
      .WithFileEncoding(Encoding.UTF8);
    _globalsType = globalsType;
    _prelude = prelude;
    _cacheCapacity = Math.Max(1, cacheCapacity);
  }

  public int CachedScriptCount
  {
    get
    {
      lock (_cacheSync)
      {
        return _cacheOrder.Count;
      }
    }
  }

  public static string HashCode(string code) =>
    Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(code)));

  public ScriptCompilation Compile(string code, CancellationToken cancellationToken)
  {
    var key = HashCode(code);
    lock (_cacheSync)
    {
      if (_cacheIndex.TryGetValue(key, out var cached))
      {
        _cacheOrder.Remove(cached);
        _cacheOrder.AddFirst(cached);
        return new ScriptCompilation(cached.Value.Value, [], true);
      }
    }

    var script = CSharpScript.Create<object>(_prelude + code, _options, _globalsType);
    var errors = script.Compile(cancellationToken)
      .Where(diagnostic => diagnostic.Severity == RoslynDiagnosticSeverity.Error)
      .Select(ToCompileError)
      .ToList();
    if (errors.Count > 0)
    {
      return new ScriptCompilation(null, errors, false);
    }

    lock (_cacheSync)
    {
      if (!_cacheIndex.ContainsKey(key))
      {
        _cacheIndex[key] = _cacheOrder.AddFirst(new KeyValuePair<string, Script<object>>(key, script));
        while (_cacheOrder.Count > _cacheCapacity)
        {
          var oldest = _cacheOrder.Last!;
          _cacheOrder.RemoveLast();
          _cacheIndex.Remove(oldest.Value.Key);
        }
      }
    }

    return new ScriptCompilation(script, [], false);
  }

  public static async Task<ScriptRunOutcome> RunAsync(
    Script<object> script,
    object globals,
    CancellationToken cancellationToken)
  {
    try
    {
      var state = await script.RunAsync(globals, cancellationToken);
      return new ScriptRunOutcome(state.ReturnValue, null);
    }
    catch (Exception exception)
    {
      return new ScriptRunOutcome(null, Describe(exception));
    }
  }

  public static ScriptRuntimeError Describe(Exception exception)
  {
    var current = exception;
    while (true)
    {
      if (current is AggregateException aggregate && aggregate.InnerExceptions.Count == 1)
      {
        current = aggregate.InnerExceptions[0];
        continue;
      }

      if (current.InnerException != null && current.GetType().Name == "TargetInvocationException")
      {
        current = current.InnerException;
        continue;
      }

      break;
    }

    return new ScriptRuntimeError(current.GetType().FullName ?? current.GetType().Name, current.Message, current.StackTrace);
  }

  /// <summary>
  /// Serializes a script return value to JSON. Cycles are ignored, values that
  /// cannot be serialized fall back to ToString(), and results larger than
  /// <see cref="MaxOutputChars"/> are returned as a truncated JSON string.
  /// </summary>
  public static (JsonNode? Value, bool Truncated) SerializeReturnValue(object? value, JsonSerializerOptions options)
  {
    if (value == null)
    {
      return (null, false);
    }

    string json;
    try
    {
      json = JsonSerializer.Serialize(value, value.GetType(), options);
    }
    catch (Exception)
    {
      json = JsonSerializer.Serialize(SafeToString(value));
    }

    if (json.Length > MaxOutputChars)
    {
      return (JsonValue.Create(json[..MaxOutputChars]), true);
    }

    return (JsonNode.Parse(json), false);
  }

  public static string SafeToString(object value)
  {
    try
    {
      return value.ToString() ?? value.GetType().Name;
    }
    catch (Exception)
    {
      return value.GetType().Name;
    }
  }

  private static ScriptCompileError ToCompileError(RoslynDiagnostic diagnostic)
  {
    if (!diagnostic.Location.IsInSource)
    {
      return new ScriptCompileError(0, 0, diagnostic.Id, diagnostic.GetMessage());
    }

    var span = diagnostic.Location.GetMappedLineSpan();
    return new ScriptCompileError(
      span.StartLinePosition.Line + 1,
      span.StartLinePosition.Character + 1,
      diagnostic.Id,
      diagnostic.GetMessage());
  }
}

/// <summary>Thread-safe, size-capped text buffer behind the script Log() global.</summary>
internal sealed class ScriptOutputBuffer(int maxChars)
{
  private readonly StringBuilder _builder = new();
  private readonly object _sync = new();

  public bool Truncated { get; private set; }

  public void AppendLine(string? message)
  {
    lock (_sync)
    {
      if (Truncated)
      {
        return;
      }

      var text = (message ?? string.Empty) + Environment.NewLine;
      var remaining = maxChars - _builder.Length;
      if (text.Length > remaining)
      {
        _builder.Append(text, 0, Math.Max(0, remaining));
        Truncated = true;
        return;
      }

      _builder.Append(text);
    }
  }

  public override string ToString()
  {
    lock (_sync)
    {
      return _builder.ToString();
    }
  }
}
