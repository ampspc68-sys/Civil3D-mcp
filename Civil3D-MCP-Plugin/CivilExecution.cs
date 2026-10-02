using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace Civil3DMcpPlugin;

public static class CivilExecution
{
  private static readonly SemaphoreSlim HostExecutionGate = new(1, 1);

  public static async Task<T> ExecuteAsync<T>(Func<Document, CivilDocument, Database, Transaction, T> action, bool write)
  {
    return await ExecuteSerializedAsync(async () =>
    {
      T? result = default;
      Exception? capturedException = null;

      await App.DocumentManager.ExecuteInCommandContextAsync(async _ =>
      {
        try
        {
          var (doc, civilDoc) = ResolveActiveDocuments();
          var database = doc.Database;

          using var documentLock = doc.LockDocument();
          using var transaction = database.TransactionManager.StartTransaction();

          result = action(doc, civilDoc, database, transaction);

          if (write)
          {
            transaction.Commit();
          }
        }
        catch (Exception ex)
        {
          capturedException = ex;
        }

        await Task.CompletedTask;
      }, null);

      if (capturedException != null)
      {
        throw capturedException;
      }

      return result!;
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

  public static async Task<T> ExecuteInCommandContextAsync<T>(Func<Task<T>> action)
  {
    return await ExecuteSerializedAsync(async () =>
    {
      T? result = default;
      Exception? capturedException = null;

      await App.DocumentManager.ExecuteInCommandContextAsync(async _ =>
      {
        try
        {
          result = await action();
        }
        catch (Exception ex)
        {
          capturedException = ex;
        }
      }, null);

      if (capturedException != null)
      {
        throw capturedException;
      }

      return result!;
    });
  }

  public static Task<T> ReadAsync<T>(Func<Document, CivilDocument, Database, Transaction, T> action)
  {
    return ExecuteAsync(action, false);
  }

  public static Task<T> WriteAsync<T>(Func<Document, CivilDocument, Database, Transaction, T> action)
  {
    return ExecuteAsync(action, true);
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

  private static async Task<T> ExecuteSerializedAsync<T>(Func<Task<T>> action)
  {
    var cancellationToken = PluginRuntime.GetCurrentRequestCancellationToken();
    PluginRuntime.QueueHostOperation();
    var started = false;

    try
    {
      await HostExecutionGate.WaitAsync(cancellationToken);
      started = true;
      PluginRuntime.StartHostOperation();
      cancellationToken.ThrowIfCancellationRequested();
      return await action();
    }
    finally
    {
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
}
