using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using System.Collections.Concurrent;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace Civil3DMcpPlugin;

public sealed record HostOperationInfo(long Id, string Operation, string? RequestId, string State, long AgeMs);

public sealed record HostQueueResetResult(int Abandoned, IReadOnlyList<HostOperationInfo> StillRunning);

public static class CivilExecution
{
  private const string StartTimeoutVariable = "CIVIL3D_HOST_START_TIMEOUT_MS";
  private const int DefaultStartTimeoutMs = 90_000;

  private static readonly SemaphoreSlim HostExecutionGate = new(1, 1);
  private static readonly ConcurrentDictionary<long, HostOperation> Operations = new();
  private static long _nextOperationId;

  /// <summary>
  /// How long a host operation may wait for Civil 3D to start running it
  /// (for example while a modal dialog or a user command is active) before it
  /// is abandoned. 0 disables the limit.
  /// </summary>
  public static int HostStartTimeoutMs { get; } = LoadStartTimeoutMs();

  public static Task<T> ExecuteAsync<T>(Func<Document, CivilDocument, Database, Transaction, T> action, bool write)
  {
    return ExecuteInCommandContextAsync(() =>
    {
      var (doc, civilDoc) = ResolveActiveDocuments();
      var database = doc.Database;

      using var documentLock = doc.LockDocument();
      using var transaction = database.TransactionManager.StartTransaction();

      var result = action(doc, civilDoc, database, transaction);

      if (write)
      {
        transaction.Commit();
      }

      return Task.FromResult(result);
    });
  }

  /// <summary>
  /// Runs an asynchronous action inside the active document's lock and a single
  /// transaction. The action decides whether to commit; any transaction that is
  /// not committed when the action returns or throws is aborted on dispose.
  /// </summary>
  public static Task<T> ExecuteInTransactionAsync<T>(Func<Document, CivilDocument, Database, Transaction, Task<T>> action)
  {
    return ExecuteInCommandContextAsync(async () =>
    {
      var (doc, civilDoc) = ResolveActiveDocuments();
      var database = doc.Database;

      using var documentLock = doc.LockDocument();
      using var transaction = database.TransactionManager.StartTransaction();
      return await action(doc, civilDoc, database, transaction);
    });
  }

  /// <summary>
  /// Runs an action on the AutoCAD main thread in application (session) context,
  /// outside any document lock or command. Document open, close, and activation
  /// must run here. The action is dispatched from the next Application.Idle event,
  /// which also works when no drawing is open.
  /// </summary>
  public static Task<T> ExecuteInApplicationContextAsync<T>(Func<T> action)
  {
    return ExecuteSerializedAsync(operation => RunOnHostAsync(
      operation,
      body =>
      {
        void OnIdle(object? sender, EventArgs e)
        {
          App.Idle -= OnIdle;
          _ = body();
        }

        App.Idle += OnIdle;
        return Task.CompletedTask;
      },
      () => Task.FromResult(action())));
  }

  public static Task<T> ExecuteInCommandContextAsync<T>(Func<Task<T>> action)
  {
    return ExecuteSerializedAsync(operation => RunOnHostAsync(
      operation,
      body => App.DocumentManager.ExecuteInCommandContextAsync(async _ => await body(), null),
      action));
  }

  public static Task<T> ReadAsync<T>(Func<Document, CivilDocument, Database, Transaction, T> action)
  {
    return ExecuteAsync(action, false);
  }

  public static Task<T> WriteAsync<T>(Func<Document, CivilDocument, Database, Transaction, T> action)
  {
    return ExecuteAsync(action, true);
  }

  /// <summary>Snapshot of queued, waiting, and running host operations for health reporting.</summary>
  public static IReadOnlyList<HostOperationInfo> GetHostOperations()
  {
    return Operations.Values
      .OrderBy(operation => operation.Id)
      .Select(operation => operation.Describe())
      .ToList();
  }

  /// <summary>
  /// Abandons every host operation Civil 3D has not started yet (waiting for the
  /// queue or for the main thread), which frees the queue. An operation that is
  /// already executing on Civil 3D's main thread cannot be pre-empted and is
  /// reported instead.
  /// </summary>
  public static HostQueueResetResult ResetHostQueue()
  {
    var abandoned = 0;
    var stillRunning = new List<HostOperationInfo>();
    foreach (var operation in Operations.Values.OrderBy(operation => operation.Id))
    {
      if (operation.TryAbandon())
      {
        abandoned++;
      }
      else if (operation.IsRunning)
      {
        stillRunning.Add(operation.Describe());
      }
    }

    PluginLog.Info("HostQueue", $"Reset abandoned {abandoned} pending operation(s); {stillRunning.Count} still running on the main thread.");
    return new HostQueueResetResult(abandoned, stillRunning);
  }

  /// <summary>
  /// Fails fast with CIVIL3D.HOST_BUSY when the user has a command or modal
  /// dialog active in Civil 3D, instead of queueing work the host cannot start.
  /// Skipped while another MCP operation is in progress, because that operation
  /// legitimately holds the command context; the start timeout covers that case.
  /// </summary>
  public static void EnsureHostIdle(string operationName)
  {
    if (PluginRuntime.GetStatus().OperationInProgress)
    {
      return;
    }

    int commandActive;
    bool quiescent;
    DocumentLockMode lockMode;
    try
    {
      commandActive = Convert.ToInt32(App.GetSystemVariable("CMDACTIVE") ?? 0);
      var doc = App.DocumentManager.MdiActiveDocument;
      quiescent = doc?.Editor.IsQuiescent ?? true;
      lockMode = doc?.LockMode() ?? DocumentLockMode.NotLocked;
    }
    catch (Exception exception)
    {
      // State could not be read from this thread; the start timeout still applies.
      PluginLog.Debug("HostQueue", $"Unable to read host idle state before '{operationName}': {exception.Message}");
      return;
    }

    if (commandActive == 0 && quiescent && lockMode == DocumentLockMode.NotLocked)
    {
      return;
    }

    var reasons = new List<string>();
    if ((commandActive & 8) != 0) reasons.Add("a modal dialog is open");
    if ((commandActive & ~8) != 0 || !quiescent) reasons.Add("a command is active");
    if (lockMode != DocumentLockMode.NotLocked) reasons.Add($"the drawing is locked ({lockMode})");
    throw new JsonRpcDispatchException(
      "CIVIL3D.HOST_BUSY",
      $"Civil 3D is busy ({string.Join(", ", reasons)}; CMDACTIVE={commandActive}). " +
      $"Close the dialog or finish/cancel the command (Esc) in Civil 3D, then retry '{operationName}'.");
  }

  private static (Document Doc, CivilDocument CivilDoc) ResolveActiveDocuments()
  {
    var doc = App.DocumentManager.MdiActiveDocument ?? throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active drawing is open in Civil 3D.");
    var expectedDrawingIdentity = PluginRuntime.GetExpectedDrawingIdentity();
    var activeDrawingIdentity = PluginRuntime.GetDrawingIdentity(doc);
    if (!string.IsNullOrWhiteSpace(expectedDrawingIdentity) &&
        !string.Equals(expectedDrawingIdentity, activeDrawingIdentity, StringComparison.OrdinalIgnoreCase))
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.CONFLICT",
        $"The active drawing changed from '{expectedDrawingIdentity}' to '{activeDrawingIdentity}' while the operation was queued. No drawing changes were made.");
    }
    var civilDoc = CivilApplication.ActiveDocument ?? throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active Civil 3D document is available.");
    return (doc, civilDoc);
  }

  private static async Task<T> ExecuteSerializedAsync<T>(Func<HostOperation, Task<T>> action)
  {
    var cancellationToken = PluginRuntime.GetCurrentRequestCancellationToken();
    using var operation = new HostOperation(
      Interlocked.Increment(ref _nextOperationId),
      PluginRuntime.GetCurrentRequestOperation(),
      PluginRuntime.GetCurrentRequestId(),
      cancellationToken);
    PluginRuntime.QueueHostOperation();
    Operations[operation.Id] = operation;
    var started = false;

    try
    {
      await HostExecutionGate.WaitAsync(operation.AbandonToken);
      started = true;
      PluginRuntime.StartHostOperation();
      operation.AbandonToken.ThrowIfCancellationRequested();
      return await action(operation);
    }
    finally
    {
      Operations.TryRemove(operation.Id, out _);
      if (started)
      {
        PluginRuntime.CompleteHostOperation();
        HostExecutionGate.Release();
      }
      else
      {
        PluginRuntime.CancelQueuedHostOperation();
      }
    }
  }

  /// <summary>
  /// Schedules <paramref name="action"/> on Civil 3D's main thread and waits for
  /// it. If the caller disconnects, the queue is reset, or Civil 3D does not
  /// start the work within <see cref="HostStartTimeoutMs"/>, the operation is
  /// abandoned: the wait ends, the queue gate is released by the caller, and the
  /// late host callback becomes a no-op. Work already running on the main thread
  /// cannot be pre-empted and is awaited to completion.
  /// </summary>
  private static async Task<T> RunOnHostAsync<T>(
    HostOperation operation,
    Func<Func<Task>, Task> schedule,
    Func<Task<T>> action)
  {
    var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);

    async Task Body()
    {
      if (!operation.TryStart())
      {
        return;
      }

      try
      {
        completion.TrySetResult(await action());
      }
      catch (Exception exception)
      {
        completion.TrySetException(exception);
      }
    }

    operation.MarkWaitingForHost();
    try
    {
      var scheduled = schedule(Body);
      _ = scheduled.ContinueWith(
        task => completion.TrySetException(task.Exception!.InnerException ?? task.Exception),
        CancellationToken.None,
        TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
        TaskScheduler.Default);
    }
    catch (Exception exception)
    {
      operation.TryAbandon();
      throw new JsonRpcDispatchException("CIVIL3D.UNAVAILABLE", $"Civil 3D could not schedule '{operation.Name}': {exception.Message}");
    }

    using var startTimeout = new CancellationTokenSource();
    if (HostStartTimeoutMs > 0)
    {
      startTimeout.CancelAfter(HostStartTimeoutMs);
    }

    using var stopWaiting = CancellationTokenSource.CreateLinkedTokenSource(operation.AbandonToken, startTimeout.Token);
    var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    using (stopWaiting.Token.Register(() => stopped.TrySetResult()))
    {
      var first = await Task.WhenAny(completion.Task, stopped.Task);
      if (first == completion.Task)
      {
        return await completion.Task;
      }
    }

    // Read before TryAbandon, which itself cancels AbandonToken.
    var abandonedByCallerOrReset = operation.AbandonToken.IsCancellationRequested;
    if (!operation.TryAbandon() && operation.IsRunning)
    {
      // Civil 3D already started the work on its main thread; it cannot be
      // interrupted, so wait for it to finish.
      return await completion.Task;
    }

    if (abandonedByCallerOrReset)
    {
      throw new OperationCanceledException($"Operation '{operation.Name}' was abandoned before Civil 3D started it.", operation.AbandonToken);
    }

    PluginLog.Info("HostQueue", $"Abandoned '{operation.Name}' after {HostStartTimeoutMs} ms waiting for Civil 3D to start it.");
    throw new JsonRpcDispatchException(
      "CIVIL3D.HOST_BUSY",
      $"Civil 3D did not start '{operation.Name}' within {HostStartTimeoutMs / 1000} s; a modal dialog or an active command is probably blocking it. " +
      "The request was abandoned and will not run later. Close the dialog or finish the command in Civil 3D, then retry.");
  }

  private static int LoadStartTimeoutMs()
  {
    var configured = Environment.GetEnvironmentVariable(StartTimeoutVariable);
    return int.TryParse(configured, out var value) && value >= 0 ? value : DefaultStartTimeoutMs;
  }

  private sealed class HostOperation : IDisposable
  {
    private const int Queued = 0;
    private const int WaitingForHost = 1;
    private const int Running = 2;
    private const int Abandoned = 3;

    private readonly CancellationTokenSource _abandon;
    private readonly long _queuedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private int _state = Queued;

    public HostOperation(long id, string name, string? requestId, CancellationToken requestCancellation)
    {
      Id = id;
      Name = name;
      RequestId = requestId;
      _abandon = CancellationTokenSource.CreateLinkedTokenSource(requestCancellation);
    }

    public long Id { get; }

    public string Name { get; }

    public string? RequestId { get; }

    /// <summary>Signalled by the caller's cancellation or a queue reset.</summary>
    public CancellationToken AbandonToken => _abandon.Token;

    public bool IsRunning => Volatile.Read(ref _state) == Running;

    public void MarkWaitingForHost() => Interlocked.CompareExchange(ref _state, WaitingForHost, Queued);

    /// <summary>Called on the main thread; false when the operation was already abandoned.</summary>
    public bool TryStart()
    {
      Interlocked.CompareExchange(ref _state, WaitingForHost, Queued);
      return Interlocked.CompareExchange(ref _state, Running, WaitingForHost) == WaitingForHost;
    }

    /// <summary>Abandons the operation unless Civil 3D has already started running it.</summary>
    public bool TryAbandon()
    {
      while (true)
      {
        var current = Volatile.Read(ref _state);
        if (current is Running or Abandoned)
        {
          return false;
        }

        if (Interlocked.CompareExchange(ref _state, Abandoned, current) == current)
        {
          try
          {
            _abandon.Cancel();
          }
          catch (ObjectDisposedException)
          {
            // The operation already completed.
          }
          return true;
        }
      }
    }

    public HostOperationInfo Describe() => new(
      Id,
      Name,
      RequestId,
      Volatile.Read(ref _state) switch
      {
        Queued => "queued",
        WaitingForHost => "waiting_for_host",
        Running => "running",
        _ => "abandoned",
      },
      Math.Max(0, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _queuedAtUnixMs));

    public void Dispose() => _abandon.Dispose();
  }
}
