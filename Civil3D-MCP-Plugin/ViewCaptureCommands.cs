using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using System.Text.Json.Nodes;
using App = Autodesk.AutoCAD.ApplicationServices.Application;
using Bitmap = System.Drawing.Bitmap;
using DrawingColor = System.Drawing.Color;
using DrawingGraphics = System.Drawing.Graphics;
using DrawingImage = System.Drawing.Image;
using DrawingRectangle = System.Drawing.Rectangle;
using DrawingSize = System.Drawing.Size;
using GsGraphicsKernel = Autodesk.AutoCAD.GraphicsSystem.GraphicsKernel;
using GsKernelDescriptor = Autodesk.AutoCAD.GraphicsSystem.KernelDescriptor;
using GsManager = Autodesk.AutoCAD.GraphicsSystem.Manager;
using GsRendererType = Autodesk.AutoCAD.GraphicsSystem.RendererType;
using GsView = Autodesk.AutoCAD.GraphicsSystem.View;
using ImageFormat = System.Drawing.Imaging.ImageFormat;
using InterpolationMode = System.Drawing.Drawing2D.InterpolationMode;

namespace Civil3DMcpPlugin;

/// <summary>
/// Saves the model or layout view of the active drawing as a PNG without
/// screen capture. Palettes, ribbons, and dialogs are never included.
///
/// Render order:
///   1. Document.CapturePreviewImage(width, height) — renders the current view
///      at the requested size; used first when background = current.
///   2. GraphicsSystem off-screen device (Manager.CreateAutoCADOffScreenDevice +
///      View.GetSnapshot) — used first when a white/black background is requested
///      (the device background is settable) and as the fallback otherwise.
/// Whatever the renderer returns is letterboxed to exactly width x height.
/// </summary>
public static class ViewCaptureCommands
{
  private const int DefaultWidth = 1600;
  private const int DefaultHeight = 900;
  private const int MaxDimension = 4096;
  private const int MinDimension = 16;
  private const int ThumbnailMaxDimension = 256;
  private const double ExtentsMargin = 1.02;

  private sealed record CaptureRequest(
    int Width,
    int Height,
    string View,
    (double MinX, double MinY, double MaxX, double MaxY)? Window,
    string Background,
    string? Layout);

  public static async Task<object?> CaptureViewAsync(JsonObject? parameters)
  {
    var rawOutputPath = PluginRuntime.GetRequiredString(parameters, "outputPath");
    var overwrite = PluginRuntime.GetOptionalBool(parameters, "overwrite") ?? false;
    var includeThumbnail = PluginRuntime.GetOptionalBool(parameters, "includeThumbnail") ?? false;
    var request = ParseRequest(parameters);

    // Validate the destination before touching the drawing.
    var outputPath = FileBoundary.ResolveExportPath(rawOutputPath, overwrite, ".png");

    var capture = await CivilExecution.ReadAsync((doc, civilDoc, database, transaction) =>
      Capture(doc, database, transaction, request));

    var writtenPath = FileBoundary.WriteAllBytesAtomic(outputPath, capture.Png, overwrite, ".png");
    var response = new Dictionary<string, object?>
    {
      ["path"] = writtenPath,
      ["width"] = request.Width,
      ["height"] = request.Height,
      ["bytes"] = capture.Png.Length,
      ["view"] = request.View,
      ["layout"] = capture.Layout,
      ["background"] = request.Background,
      ["method"] = capture.Method,
      ["warnings"] = capture.Warnings,
    };
    if (includeThumbnail)
    {
      response["thumbnailBase64"] = Convert.ToBase64String(capture.Thumbnail ?? []);
      response["thumbnailMimeType"] = "image/png";
    }

    return response;
  }

  private static CaptureRequest ParseRequest(JsonObject? parameters)
  {
    var width = PluginRuntime.GetOptionalInt(parameters, "width") ?? DefaultWidth;
    var height = PluginRuntime.GetOptionalInt(parameters, "height") ?? DefaultHeight;
    if (width is < MinDimension or > MaxDimension || height is < MinDimension or > MaxDimension)
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.INVALID_INPUT",
        $"width and height must be between {MinDimension} and {MaxDimension} pixels.");
    }

    var view = (PluginRuntime.GetOptionalString(parameters, "view") ?? "current").Trim().ToLowerInvariant();
    if (view is not ("current" or "extents" or "window"))
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "view must be 'current', 'extents', or 'window'.");
    }

    (double, double, double, double)? window = null;
    if (view == "window")
    {
      var windowNode = PluginRuntime.GetParameter(parameters, "window") as JsonObject
        ?? throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "view='window' requires window {minX, minY, maxX, maxY}.");
      var minX = PluginRuntime.GetRequiredDouble(windowNode, "minX");
      var minY = PluginRuntime.GetRequiredDouble(windowNode, "minY");
      var maxX = PluginRuntime.GetRequiredDouble(windowNode, "maxX");
      var maxY = PluginRuntime.GetRequiredDouble(windowNode, "maxY");
      if (!(maxX > minX) || !(maxY > minY))
      {
        throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "window must satisfy maxX > minX and maxY > minY.");
      }

      window = (minX, minY, maxX, maxY);
    }

    var background = (PluginRuntime.GetOptionalString(parameters, "background") ?? "current").Trim().ToLowerInvariant();
    if (background is not ("current" or "white" or "black"))
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "background must be 'current', 'white', or 'black'.");
    }

    var layout = PluginRuntime.GetOptionalString(parameters, "layout");
    return new CaptureRequest(width, height, view, window, background, string.IsNullOrWhiteSpace(layout) ? null : layout.Trim());
  }

  private sealed record CaptureResult(byte[] Png, byte[]? Thumbnail, string Method, string Layout, List<string> Warnings);

  private static CaptureResult Capture(Document doc, Database database, Transaction transaction, CaptureRequest request)
  {
    var editor = doc.Editor;
    var warnings = new List<string>();
    var layoutManager = LayoutManager.Current;
    var previousLayout = layoutManager.CurrentLayout;
    var switchedLayout = false;

    if (request.Layout != null && !string.Equals(request.Layout, previousLayout, StringComparison.OrdinalIgnoreCase))
    {
      if (!layoutManager.LayoutExists(request.Layout))
      {
        throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Layout '{request.Layout}' was not found.");
      }

      layoutManager.CurrentLayout = request.Layout;
      switchedLayout = true;
    }

    ViewTableRecord? savedView = null;
    try
    {
      if (request.View != "current")
      {
        savedView = editor.GetCurrentView();
        var aspect = (double)request.Width / request.Height;
        var (min, max) = request.View == "extents"
          ? CurrentSpaceExtents(database)
          : (new Point3d(request.Window!.Value.MinX, request.Window.Value.MinY, 0), new Point3d(request.Window.Value.MaxX, request.Window.Value.MaxY, 0));
        ZoomTo(editor, min, max, aspect);
      }

      editor.UpdateScreen();
      using var rendered = Render(doc, database, transaction, request, warnings, out var method);
      using var exact = FitToSize(rendered, request.Width, request.Height, BackgroundFill(request.Background));
      var png = EncodePng(exact);
      byte[]? thumbnail = null;
      var scale = Math.Min(1d, (double)ThumbnailMaxDimension / Math.Max(request.Width, request.Height));
      using (var small = FitToSize(exact, Math.Max(1, (int)Math.Round(request.Width * scale)), Math.Max(1, (int)Math.Round(request.Height * scale)), DrawingColor.Black))
      {
        thumbnail = EncodePng(small);
      }

      return new CaptureResult(png, thumbnail, method, layoutManager.CurrentLayout, warnings);
    }
    finally
    {
      if (savedView != null)
      {
        try
        {
          editor.SetCurrentView(savedView);
        }
        catch (Exception exception)
        {
          PluginLog.Info("ViewCapture", $"Unable to restore the previous view: {exception.Message}");
        }
        savedView.Dispose();
      }

      if (switchedLayout)
      {
        try
        {
          layoutManager.CurrentLayout = previousLayout;
        }
        catch (Exception exception)
        {
          PluginLog.Info("ViewCapture", $"Unable to restore layout '{previousLayout}': {exception.Message}");
        }
      }
    }
  }

  private static DrawingImage Render(
    Document doc,
    Database database,
    Transaction transaction,
    CaptureRequest request,
    List<string> warnings,
    out string method)
  {
    var preferOffScreen = request.Background != "current";
    var attempts = preferOffScreen
      ? new (string Name, Func<DrawingImage?> Render)[]
        {
          ("OffScreenDevice", () => RenderOffScreen(doc, database, transaction, request)),
          ("CapturePreviewImage", () => doc.CapturePreviewImage((uint)request.Width, (uint)request.Height)),
        }
      : new (string Name, Func<DrawingImage?> Render)[]
        {
          ("CapturePreviewImage", () => doc.CapturePreviewImage((uint)request.Width, (uint)request.Height)),
          ("OffScreenDevice", () => RenderOffScreen(doc, database, transaction, request)),
        };

    foreach (var (name, render) in attempts)
    {
      try
      {
        var image = render();
        if (image != null && image.Width > 0 && image.Height > 0)
        {
          method = name;
          if (preferOffScreen && name == "CapturePreviewImage")
          {
            warnings.Add($"The off-screen renderer was unavailable, so the {request.Background} background could not be applied; the current background was used.");
          }

          return image;
        }

        image?.Dispose();
        warnings.Add($"{name} returned no image.");
      }
      catch (Exception exception)
      {
        warnings.Add($"{name} failed: {exception.Message}");
      }
    }

    throw new JsonRpcDispatchException(
      "CIVIL3D.API_ERROR",
      $"Unable to capture the view. {string.Join(" ", warnings)}");
  }

  private static DrawingImage? RenderOffScreen(Document doc, Database database, Transaction transaction, CaptureRequest request)
  {
    var manager = doc.GraphicsManager;
    var descriptor = new GsKernelDescriptor();
    descriptor.addRequirement(Autodesk.AutoCAD.UniqueString.Intern("3D Drawing"));
    GsGraphicsKernel kernel = GsManager.AcquireGraphicsKernel(descriptor);

    using var view = new GsView();
    var viewportNumber = Convert.ToInt32(App.GetSystemVariable("CVPORT"));
    manager.SetViewFromViewport(view, viewportNumber);

    using var device = manager.CreateAutoCADOffScreenDevice(kernel);
    device.OnSize(new DrawingSize(request.Width, request.Height));
    device.DeviceRenderType = GsRendererType.Default;
    if (request.Background != "current")
    {
      device.BackgroundColor = BackgroundFill(request.Background);
    }

    device.Add(view);
    device.Update();

    using var model = manager.CreateAutoCADModel(kernel);
    var space = (BlockTableRecord)transaction.GetObject(database.CurrentSpaceId, OpenMode.ForRead);
    view.Add(space, model);
    try
    {
      return view.GetSnapshot(new DrawingRectangle(0, 0, request.Width, request.Height));
    }
    finally
    {
      view.EraseAll();
      device.Erase(view);
    }
  }

  private static (Point3d Min, Point3d Max) CurrentSpaceExtents(Database database)
  {
    database.UpdateExt(true);
    var modelSpace = database.TileMode || Convert.ToInt32(App.GetSystemVariable("CVPORT")) > 1;
    var min = modelSpace ? database.Extmin : database.Pextmin;
    var max = modelSpace ? database.Extmax : database.Pextmax;
    if (min.X > max.X || min.Y > max.Y)
    {
      throw new JsonRpcDispatchException("CIVIL3D.INVALID_INPUT", "The current space is empty, so view='extents' has nothing to frame.");
    }

    return (min, max);
  }

  /// <summary>Frames a WCS box in the current view at the requested image aspect ratio.</summary>
  private static void ZoomTo(Editor editor, Point3d minWcs, Point3d maxWcs, double aspect)
  {
    using var view = editor.GetCurrentView();
    var worldToEye = (Matrix3d.Rotation(-view.ViewTwist, view.ViewDirection, view.Target)
      * Matrix3d.Displacement(view.Target - Point3d.Origin)
      * Matrix3d.PlaneToWorld(view.ViewDirection)).Inverse();

    var extents = new Extents3d(
      new Point3d(Math.Min(minWcs.X, maxWcs.X), Math.Min(minWcs.Y, maxWcs.Y), Math.Min(minWcs.Z, maxWcs.Z)),
      new Point3d(Math.Max(minWcs.X, maxWcs.X), Math.Max(minWcs.Y, maxWcs.Y), Math.Max(minWcs.Z, maxWcs.Z)));
    extents.TransformBy(worldToEye);

    var width = Math.Max((extents.MaxPoint.X - extents.MinPoint.X) * ExtentsMargin, 1e-6);
    var height = Math.Max((extents.MaxPoint.Y - extents.MinPoint.Y) * ExtentsMargin, 1e-6);
    if (width / height < aspect)
    {
      width = height * aspect;
    }
    else
    {
      height = width / aspect;
    }

    view.CenterPoint = new Point2d(
      (extents.MinPoint.X + extents.MaxPoint.X) / 2,
      (extents.MinPoint.Y + extents.MaxPoint.Y) / 2);
    view.Width = width;
    view.Height = height;
    editor.SetCurrentView(view);
  }

  private static DrawingColor BackgroundFill(string background) =>
    background == "white" ? DrawingColor.White : DrawingColor.Black;

  /// <summary>Scales an image into exactly width x height, preserving aspect ratio.</summary>
  private static Bitmap FitToSize(DrawingImage source, int width, int height, DrawingColor fill)
  {
    var target = new Bitmap(width, height);
    using var graphics = DrawingGraphics.FromImage(target);
    graphics.Clear(fill);
    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
    var scale = Math.Min((double)width / source.Width, (double)height / source.Height);
    var drawWidth = Math.Max(1, (int)Math.Round(source.Width * scale));
    var drawHeight = Math.Max(1, (int)Math.Round(source.Height * scale));
    graphics.DrawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return target;
  }

  private static byte[] EncodePng(DrawingImage image)
  {
    using var stream = new MemoryStream();
    image.Save(stream, ImageFormat.Png);
    return stream.ToArray();
  }
}
