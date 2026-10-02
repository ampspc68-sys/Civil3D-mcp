// Exercises the Autodesk-independent Roslyn core behind civil3d_execute_code.
// Runs on any OS: dotnet run --project ./tests/CodeScriptEngineHarness/CodeScriptEngineHarness.csproj
using System.Text.Json;
using System.Text.Json.Serialization;
using Civil3DMcpPlugin;

public sealed class TestGlobals
{
  internal TestGlobals(ScriptOutputBuffer output, CancellationToken token) { _output = output; CancellationToken = token; }
  private readonly ScriptOutputBuffer _output;
  public CancellationToken CancellationToken { get; }
  public int Seed => 40;
  public void Log(string? message) { CancellationToken.ThrowIfCancellationRequested(); _output.AppendLine(message); }
}

public sealed class Node { public string Name { get; set; } = ""; public Node? Next { get; set; } }

public static class Program
{
  static int failures;
  static void Check(bool ok, string what) { Console.WriteLine($"{(ok ? "PASS" : "FAIL")} {what}"); if (!ok) failures++; }

  public static async Task<int> Main()
  {
    var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
      .Where(p => { var n = Path.GetFileNameWithoutExtension(p); return n.StartsWith("System.") || n is "System" or "mscorlib" or "netstandard"; })
      .Append(typeof(TestGlobals).Assembly.Location).ToList();
    var prelude = "using SB = System.Text.StringBuilder;\n#line 1\n";
    var engine = new CodeScriptEngine(refs, ["System", "System.Linq", "System.Collections.Generic", "System.Text"], typeof(TestGlobals), prelude, cacheCapacity: 2);
    var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, ReferenceHandler = ReferenceHandler.IgnoreCycles, MaxDepth = 32, NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals };

    // 1. return value + globals + prelude alias + Log
    var c1 = engine.Compile("var sb = new SB(\"x\");\nLog(\"hello\");\nreturn Seed + 2;", default);
    Check(c1.Errors.Count == 0 && c1.Script != null, "compiles with globals and prelude alias");
    var out1 = new ScriptOutputBuffer(CodeScriptEngine.MaxOutputChars);
    var r1 = await CodeScriptEngine.RunAsync(c1.Script!, new TestGlobals(out1, default), default);
    Check(r1.Error == null && Equals(r1.ReturnValue, 42), $"returns 42 (got {r1.ReturnValue})");
    Check(out1.ToString().Trim() == "hello", "captures Log output");

    // 2. cache hit / LRU eviction
    Check(engine.Compile("var sb = new SB(\"x\");\nLog(\"hello\");\nreturn Seed + 2;", default).FromCache, "second compile is served from cache");
    engine.Compile("return 1;", default); engine.Compile("return 2;", default);
    Check(engine.CachedScriptCount == 2, "LRU cache is bounded to capacity");
    Check(!engine.Compile("var sb = new SB(\"x\");\nLog(\"hello\");\nreturn Seed + 2;", default).FromCache, "least recently used script was evicted");

    // 3. compile error mapped to caller line/column (prelude hidden by #line 1)
    var c3 = engine.Compile("var a = 1;\nvar b = undefinedThing;\nreturn a;", default);
    Check(c3.Script == null && c3.Errors.Count == 1, "compile error reported, not thrown");
    Check(c3.Errors[0].Line == 2 && c3.Errors[0].Column == 9 && c3.Errors[0].Id == "CS0103", $"error at line 2 col 9 CS0103 (got {c3.Errors[0].Line}:{c3.Errors[0].Column} {c3.Errors[0].Id})");

    // 4. runtime exception captured with type and script line in stack trace
    var c4 = engine.Compile("var x = 1;\nthrow new InvalidOperationException(\"boom\");", default);
    var r4 = await CodeScriptEngine.RunAsync(c4.Script!, new TestGlobals(new ScriptOutputBuffer(100), default), default);
    Check(r4.Error?.Type == "System.InvalidOperationException" && r4.Error.Message == "boom", "runtime exception captured with type/message");
    Check(r4.Error?.StackTrace?.Contains("execute_code.csx:line 2") == true, $"stack trace points at script line 2: {r4.Error?.StackTrace?.Split('\n')[0]}");

    // 5. cooperative cancellation via Log()
    using var cts = new CancellationTokenSource(200);
    var c5 = engine.Compile("while (true) { Log(\"tick\"); System.Threading.Thread.Sleep(20); }", default);
    var out5 = new ScriptOutputBuffer(CodeScriptEngine.MaxOutputChars);
    var r5 = await CodeScriptEngine.RunAsync(c5.Script!, new TestGlobals(out5, cts.Token), cts.Token);
    Check(r5.Error?.Type == "System.OperationCanceledException", $"timeout cancels a cooperative loop ({r5.Error?.Type})");

    // 6. serialization: anonymous, cycles, NaN, truncation, ToString fallback
    var (v1, t1) = CodeScriptEngine.SerializeReturnValue(new { Name = "EG", Count = 3, Ratio = double.NaN }, options);
    Check(!t1 && v1!["name"]!.GetValue<string>() == "EG" && v1["count"]!.GetValue<int>() == 3, $"anonymous object serialized camelCase: {v1!.ToJsonString()}");
    var a = new Node { Name = "a" }; a.Next = new Node { Name = "b", Next = a };
    var (v2, _) = CodeScriptEngine.SerializeReturnValue(a, options);
    Check(v2!["next"]!["name"]!.GetValue<string>() == "b", $"cycle ignored: {v2.ToJsonString()}");
    var (v3, t3) = CodeScriptEngine.SerializeReturnValue(new string('x', 200_000), options);
    Check(t3 && v3!.GetValue<string>().Length == CodeScriptEngine.MaxOutputChars, "large return value truncated to 100 KB");
    var (v4, _) = CodeScriptEngine.SerializeReturnValue(new Throwing(), options);
    Check(v4!.GetValue<string>() == "throwing-to-string", $"unserializable value falls back to ToString: {v4.ToJsonString()}");

    // 7. output cap
    var buffer = new ScriptOutputBuffer(10);
    buffer.AppendLine("12345"); buffer.AppendLine("67890");
    Check(buffer.Truncated && buffer.ToString().Length == 10, "output buffer is capped");

    Console.WriteLine(failures == 0 ? "ALL PASSED" : $"{failures} FAILED");
    return failures == 0 ? 0 : 1;
  }
}

public sealed class Throwing { public int Bad => throw new InvalidOperationException("no"); public override string ToString() => "throwing-to-string"; }
