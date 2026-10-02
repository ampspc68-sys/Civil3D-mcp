// Regression harness for the stuck host-operation bug: an operation Civil 3D
// never starts (modal dialog) must not hold the queue forever.
// Run: dotnet run --project ./tests/HostQueueHarness/HostQueueHarness.csproj
using Civil3DMcpPlugin;
using Autodesk.AutoCAD.ApplicationServices;

public static class Program
{
  static int failures;
  static void Check(bool ok, string what) { Console.WriteLine($"{(ok ? "PASS" : "FAIL")} {what}"); if (!ok) failures++; }

  public static async Task<int> Main()
  {
    // Must be set before CivilExecution's static initializer reads it.
    Environment.SetEnvironmentVariable("CIVIL3D_HOST_START_TIMEOUT_MS", "700");
    Check(CivilExecution.HostStartTimeoutMs == 700, "start timeout is read from CIVIL3D_HOST_START_TIMEOUT_MS");

    // 1. Normal operation completes.
    FakeHost.Blocked = false;
    var normal = await CivilExecution.ReadAsync((d, c, db, tr) => 42);
    Check(normal == 42, "normal read completes");

    // 2. Modal dialog: host never starts the callback -> HOST_BUSY after the start timeout, queue freed.
    FakeHost.Blocked = true;
    var ranLate = false;
    var sw = System.Diagnostics.Stopwatch.StartNew();
    var stuck = CivilExecution.ReadAsync((d, c, db, tr) => { ranLate = true; return 1; });
    var queuedBehind = CivilExecution.ReadAsync((d, c, db, tr) => 2);
    await Task.Delay(100);
    Check(CivilExecution.GetHostOperations().Select(o => o.State).SequenceEqual(new[] { "waiting_for_host", "queued" }), "health shows waiting_for_host + queued: " + string.Join(",", CivilExecution.GetHostOperations().Select(o => o.State)));
    var error = await Capture(stuck);
    Check(error is JsonRpcDispatchException { Code: "CIVIL3D.HOST_BUSY" } && sw.ElapsedMilliseconds < 2000, $"stuck op abandoned with HOST_BUSY after {sw.ElapsedMilliseconds} ms");
    // The op queued behind it now waits for the host (it will also time out unless the dialog closes).
    FakeHost.Blocked = false; FakeHost.Pump();
    Check(await queuedBehind == 2, "operation queued behind the stuck one runs once the host is free");
    await Task.Delay(100);
    Check(!ranLate, "late host callback for the abandoned operation is a no-op");
    Check(CivilExecution.GetHostOperations().Count == 0 && !PluginRuntime.GetStatus().OperationInProgress, "queue empty and operationInProgress=false");

    // 3. Caller disconnect (server-side timeout closes the socket) frees the queue immediately.
    FakeHost.Blocked = true;
    using (var cts = new CancellationTokenSource())
    {
      PluginRuntime.RequestToken.Value = cts.Token;
      var cancelled = CivilExecution.ReadAsync((d, c, db, tr) => 3);
      PluginRuntime.RequestToken.Value = default;
      await Task.Delay(50);
      sw.Restart(); cts.Cancel();
      var cancelError = await Capture(cancelled);
      Check(cancelError is OperationCanceledException && sw.ElapsedMilliseconds < 300, $"client disconnect abandons the waiting op ({cancelError?.GetType().Name}, {sw.ElapsedMilliseconds} ms)");
    }
    FakeHost.Pump();

    // 4. Reset abandons pending operations (waiting + queued) and reports none running.
    FakeHost.Blocked = true;
    var a = CivilExecution.ReadAsync((d, c, db, tr) => 4);
    var b = CivilExecution.ReadAsync((d, c, db, tr) => 5);
    await Task.Delay(50);
    var reset = CivilExecution.ResetHostQueue();
    Check(reset.Abandoned == 2 && reset.StillRunning.Count == 0, $"reset abandoned {reset.Abandoned} pending op(s)");
    Check(await Capture(a) is OperationCanceledException && await Capture(b) is OperationCanceledException, "abandoned ops end with cancellation");
    FakeHost.Blocked = false; FakeHost.Pump();
    Check(await CivilExecution.ReadAsync((d, c, db, tr) => 6) == 6, "queue usable after reset");

    // 5. Work already running on the main thread is reported, not interrupted.
    var release = new TaskCompletionSource();
    var running = CivilExecution.ExecuteInTransactionAsync(async (d, c, db, tr) => { await release.Task; return 7; });
    await Task.Delay(100);
    var resetWhileRunning = CivilExecution.ResetHostQueue();
    Check(resetWhileRunning.Abandoned == 0 && resetWhileRunning.StillRunning.Count == 1 && resetWhileRunning.StillRunning[0].State == "running", "reset reports a running op and leaves it alone");
    await Task.Delay(800);
    Check(!running.IsCompleted, "running op is not cut off by the start timeout");
    release.SetResult();
    Check(await running == 7, "running op completes normally");

    // 6. Exceptions inside the host callback still propagate unchanged.
    var thrown = await Capture(CivilExecution.ReadAsync<int>((d, c, db, tr) => throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", "nope")));
    Check(thrown is JsonRpcDispatchException { Code: "CIVIL3D.OBJECT_NOT_FOUND" }, "dispatch exceptions propagate");

    // 7. Application-context path shares the same protection.
    FakeHost.Blocked = false;
    var appContext = CivilExecution.ExecuteInApplicationContextAsync(() => 8);
    Check(await Capture(appContext) is JsonRpcDispatchException { Code: "CIVIL3D.HOST_BUSY" }, "application-context op times out when Idle never fires");

    // 8. execute_code preflight: refuse while a modal dialog or command is active.
    FakeHost.CommandActive = 8;
    var busy = Capture(() => CivilExecution.EnsureHostIdle("execute_code"));
    Check(busy is JsonRpcDispatchException { Code: "CIVIL3D.HOST_BUSY" } && busy.Message.Contains("modal dialog") && busy.Message.Contains("CMDACTIVE=8"), $"preflight refuses during a modal dialog: {busy?.Message}");
    FakeHost.CommandActive = 1;
    Check(Capture(() => CivilExecution.EnsureHostIdle("execute_code")) is JsonRpcDispatchException { Code: "CIVIL3D.HOST_BUSY" }, "preflight refuses during an active command");
    FakeHost.CommandActive = 0;
    Check(Capture(() => CivilExecution.EnsureHostIdle("execute_code")) is null, "preflight passes when Civil 3D is idle");
    var hold = new TaskCompletionSource();
    var inProgress = CivilExecution.ExecuteInTransactionAsync(async (d, c, db, tr) => { await hold.Task; return 0; });
    await Task.Delay(100);
    FakeHost.CommandActive = 8;
    Check(Capture(() => CivilExecution.EnsureHostIdle("execute_code")) is null, "preflight defers to the queue while another MCP operation holds the command context");
    FakeHost.CommandActive = 0;
    hold.SetResult();
    await inProgress;

    Console.WriteLine(failures == 0 ? "ALL PASSED" : $"{failures} FAILED");
    return failures == 0 ? 0 : 1;
  }

  static Exception? Capture(Action action)
  {
    try { action(); return null; } catch (Exception e) { return e; }
  }

  static async Task<Exception?> Capture(Task task)
  {
    try { await task; return null; } catch (Exception e) { return e; }
  }
}
