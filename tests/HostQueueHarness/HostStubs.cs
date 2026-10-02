// Minimal stand-ins for the Autodesk and plugin types CivilExecution.cs uses,
// so its host-queue recovery logic can run without Civil 3D. FakeHost holds
// command-context callbacks the way Civil 3D does while a modal dialog is open.
namespace Autodesk.AutoCAD.DatabaseServices
{
  public class Transaction : IDisposable { public void Commit() { } public void Abort() { } public void Dispose() { } }
  public class TransactionManager { public Transaction StartTransaction() => new(); }
  public class Database { public string Filename => "harness.dwg"; public TransactionManager TransactionManager { get; } = new(); }
}

namespace Autodesk.AutoCAD.EditorInput
{
  public class Editor { public bool IsQuiescent => true; }
}

namespace Autodesk.Civil.ApplicationServices
{
  public class CivilDocument { }
  public static class CivilApplication { public static CivilDocument? ActiveDocument { get; } = new(); }
}

namespace Autodesk.AutoCAD.ApplicationServices
{
  using Autodesk.AutoCAD.DatabaseServices;

  public enum DocumentLockMode { NotLocked, Write, Read }
  public sealed class DocumentLock : IDisposable { public void Dispose() { } }

  public class Document
  {
    public string Name => "harness.dwg";
    public Database Database { get; } = new();
    public Autodesk.AutoCAD.EditorInput.Editor Editor { get; } = new();
    public DocumentLock LockDocument() => new();
    public DocumentLockMode LockMode() => DocumentLockMode.NotLocked;
  }

  public class DocumentCollection
  {
    public Document? MdiActiveDocument { get; set; } = new();
    public Task ExecuteInCommandContextAsync(Func<object, Task> callback, object? data) => FakeHost.Enqueue(() => callback(new object()));
  }

  public static class Application
  {
    public static DocumentCollection DocumentManager { get; } = new();
    public static object? GetSystemVariable(string name) => name == "CMDACTIVE" ? FakeHost.CommandActive : 0;
    // Never raised: simulates Civil 3D not reaching an idle state.
    public static event EventHandler? Idle;
  }

  public static class FakeHost
  {
    private static readonly System.Collections.Concurrent.ConcurrentQueue<(Func<Task> Work, TaskCompletionSource Done)> Pending = new();

    public static bool Blocked { get; set; }

    /// <summary>Simulated CMDACTIVE value (8 = modal dialog).</summary>
    public static int CommandActive { get; set; }

    public static Task Enqueue(Func<Task> work)
    {
      var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
      Pending.Enqueue((work, done));
      if (!Blocked) Pump();
      return done.Task;
    }

    public static void Pump()
    {
      while (Pending.TryDequeue(out var item))
      {
        var (work, done) = item;
        _ = Task.Run(async () =>
        {
          try { await work(); done.TrySetResult(); }
          catch (Exception exception) { done.TrySetException(exception); }
        });
      }
    }
  }
}

namespace Civil3DMcpPlugin
{
  public sealed record PluginStatus(bool OperationInProgress);

  public sealed class JsonRpcDispatchException(string code, string message) : Exception(message)
  {
    public string Code { get; } = code;
  }

  public static class PluginLog
  {
    public static void Info(string component, string message) { }
    public static void Debug(string component, string message) { }
  }

  public static class PluginRuntime
  {
    public static readonly AsyncLocal<CancellationToken> RequestToken = new();
    private static int _active;

    internal static CancellationToken GetCurrentRequestCancellationToken() => RequestToken.Value;
    internal static string GetCurrentRequestOperation() => "harness-op";
    internal static string? GetCurrentRequestId() => null;
    internal static string? GetExpectedDrawingIdentity() => null;
    internal static string? GetDrawingIdentity(Autodesk.AutoCAD.ApplicationServices.Document? document) => document?.Name;
    public static PluginStatus GetStatus() => new(Volatile.Read(ref _active) > 0);
    internal static void QueueHostOperation() { }
    internal static void StartHostOperation() => Interlocked.Increment(ref _active);
    internal static void CancelQueuedHostOperation() { }
    internal static void CompleteHostOperation() => Interlocked.Decrement(ref _active);
  }
}
