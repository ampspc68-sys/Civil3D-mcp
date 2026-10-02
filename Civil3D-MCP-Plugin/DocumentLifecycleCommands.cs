using Autodesk.AutoCAD.ApplicationServices;
using System.Text.Json.Nodes;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace Civil3DMcpPlugin;

/// <summary>
/// Open, close, list, and activate drawings. Document-collection changes run in
/// application context (CivilExecution.ExecuteInApplicationContextAsync), never
/// inside a document lock or command.
/// </summary>
public static class DocumentLifecycleCommands
{
  public static async Task<object?> OpenDrawingAsync(JsonObject? parameters)
  {
    var rawPath = PluginRuntime.GetRequiredString(parameters, "path");
    var readOnly = PluginRuntime.GetOptionalBool(parameters, "readOnly") ?? false;
    var activate = PluginRuntime.GetOptionalBool(parameters, "activate") ?? true;
    var path = FileBoundary.ResolveImportPath(rawPath, ".dwg", ".dwt");

    return await CivilExecution.ExecuteInApplicationContextAsync<object?>(() =>
    {
      var documents = App.DocumentManager;
      var alreadyOpen = FindDocumentByPath(path);
      if (alreadyOpen != null)
      {
        if (activate)
        {
          documents.MdiActiveDocument = alreadyOpen;
        }

        return Describe(alreadyOpen, ("alreadyOpen", true));
      }

      var previous = documents.MdiActiveDocument;
      var opened = DocumentCollectionExtension.Open(documents, path, readOnly);
      if (activate)
      {
        documents.MdiActiveDocument = opened;
      }
      else if (previous != null && documents.MdiActiveDocument != previous)
      {
        documents.MdiActiveDocument = previous;
      }

      return Describe(opened, ("alreadyOpen", false));
    });
  }

  public static async Task<object?> CloseDrawingAsync(JsonObject? parameters)
  {
    var name = PluginRuntime.GetOptionalString(parameters, "name");
    var save = PluginRuntime.GetOptionalBool(parameters, "save");
    var rawSaveAs = PluginRuntime.GetOptionalString(parameters, "saveAs");
    var overwrite = PluginRuntime.GetOptionalBool(parameters, "overwrite") ?? false;
    if (!string.IsNullOrWhiteSpace(rawSaveAs))
    {
      if (save == false)
      {
        throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "'saveAs' cannot be combined with save=false.");
      }

      save = true;
    }

    var saveAsPath = string.IsNullOrWhiteSpace(rawSaveAs)
      ? null
      : FileBoundary.ResolveExportPath(rawSaveAs, overwrite, ".dwg");

    return await CivilExecution.ExecuteInApplicationContextAsync<object?>(() =>
    {
      var doc = ResolveDocument(name);
      var description = Describe(doc);
      var modified = IsModified(doc);

      if (save == null && modified != false)
      {
        throw new JsonRpcDispatchException(
          "CIVIL3D.CONFLICT",
          $"Drawing '{description["name"]}' has unsaved changes{(modified == null ? " (or its state could not be read)" : string.Empty)}. " +
          "Pass save=true (optionally with saveAs) to keep them, or save=false to discard them explicitly.");
      }

      string? savedTo = null;
      if (save == true)
      {
        if (saveAsPath == null && doc.IsReadOnly)
        {
          throw new JsonRpcDispatchException(
            "CIVIL3D.CONFLICT",
            $"Drawing '{description["name"]}' is open read-only. Provide saveAs to save a copy, or close with save=false.");
        }

        savedTo = saveAsPath ?? (doc.IsNamedDrawing ? doc.Name : null)
          ?? throw new JsonRpcDispatchException(
            "CIVIL3D.INVALID_INPUT",
            $"Drawing '{description["name"]}' has never been saved. Provide saveAs to save it before closing.");
        doc.CloseAndSave(savedTo);
      }
      else
      {
        doc.CloseAndDiscard();
      }

      return new Dictionary<string, object?>
      {
        ["closed"] = true,
        ["name"] = description["name"],
        ["path"] = description["path"],
        ["saved"] = savedTo != null,
        ["savedTo"] = savedTo,
        ["discardedChanges"] = savedTo == null && modified == true,
      };
    });
  }

  public static Task<object?> ListOpenDrawingsAsync()
  {
    return CivilExecution.ExecuteInApplicationContextAsync<object?>(() =>
      OpenDocuments().Select(document => Describe(document)).ToList());
  }

  public static async Task<object?> ActivateDrawingAsync(JsonObject? parameters)
  {
    var name = PluginRuntime.GetRequiredString(parameters, "name");
    return await CivilExecution.ExecuteInApplicationContextAsync<object?>(() =>
    {
      var doc = ResolveDocument(name);
      App.DocumentManager.MdiActiveDocument = doc;
      return Describe(doc);
    });
  }

  private static List<Document> OpenDocuments()
  {
    var documents = new List<Document>();
    foreach (Document document in App.DocumentManager)
    {
      documents.Add(document);
    }

    return documents;
  }

  private static Document ResolveDocument(string? name)
  {
    if (string.IsNullOrWhiteSpace(name))
    {
      return App.DocumentManager.MdiActiveDocument
        ?? throw new JsonRpcDispatchException("CIVIL3D.NO_DRAWING", "No active drawing is open in Civil 3D.");
    }

    var matches = OpenDocuments().Where(document => MatchesName(document, name)).ToList();
    return matches.Count switch
    {
      1 => matches[0],
      0 => throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"No open drawing matches '{name}'."),
      _ => throw new JsonRpcDispatchException(
        "CIVIL3D.CONFLICT",
        $"{matches.Count} open drawings match '{name}'. Use the full path from list_open."),
    };
  }

  private static bool MatchesName(Document document, string name)
  {
    var path = DocumentPath(document);
    return string.Equals(document.Name, name, StringComparison.OrdinalIgnoreCase)
      || string.Equals(Path.GetFileName(document.Name), name, StringComparison.OrdinalIgnoreCase)
      || (path != null && string.Equals(path, name, StringComparison.OrdinalIgnoreCase));
  }

  private static Document? FindDocumentByPath(string path) =>
    OpenDocuments().FirstOrDefault(document =>
      string.Equals(DocumentPath(document), path, StringComparison.OrdinalIgnoreCase));

  private static string? DocumentPath(Document document)
  {
    if (!document.IsNamedDrawing)
    {
      return null;
    }

    try
    {
      return Path.GetFullPath(document.Name);
    }
    catch (Exception)
    {
      return document.Name;
    }
  }

  /// <summary>
  /// True/false when the modification state can be read; null when it cannot.
  /// The active drawing uses DBMOD; other drawings use the COM document's Saved flag.
  /// </summary>
  private static bool? IsModified(Document document)
  {
    try
    {
      if (document == App.DocumentManager.MdiActiveDocument)
      {
        return Convert.ToInt32(App.GetSystemVariable("DBMOD") ?? 0) != 0;
      }
    }
    catch (Exception)
    {
      // Fall through to the COM document state.
    }

    try
    {
      var acadDocument = DocumentExtension.GetAcadDocument(document);
      if (Civil3DCompatibility.TryGetComProperty(acadDocument, "Saved", out var saved) && saved is bool isSaved)
      {
        return !isSaved;
      }
    }
    catch (Exception)
    {
      // Unknown state is reported as null.
    }

    return null;
  }

  private static Dictionary<string, object?> Describe(Document document, params (string Key, object? Value)[] extra)
  {
    var description = new Dictionary<string, object?>
    {
      ["name"] = Path.GetFileName(document.Name),
      ["path"] = DocumentPath(document),
      ["isActive"] = document == App.DocumentManager.MdiActiveDocument,
      ["isModified"] = IsModified(document),
      ["isReadOnly"] = document.IsReadOnly,
    };
    foreach (var (key, value) in extra)
    {
      description[key] = value;
    }

    return description;
  }
}
