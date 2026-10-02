# Local build and test: live-session tools

Windows steps to build, deploy, and verify `civil3d_execute_code`, the
`civil3d_drawing` document actions (`open` / `close` / `list_open` /
`activate`), `civil3d_capture_view`, `civil3d_list_installations`, and
`civil3d_launch` on Civil 3D 2026 (Metric, R25.1).

The TypeScript server and the Autodesk-independent C# pieces (the Roslyn script
engine and `FileBoundary`) are covered by automated tests. **The plugin itself
can only be compiled and exercised on a machine with licensed Civil 3D 2026
assemblies**, so run every step below before merging.

> The plugin targets `net8.0-windows` (Civil 3D 2026 runs on .NET 8). Any .NET 8
> or newer SDK can build it; do not change `TargetFramework`.

All commands are PowerShell, run from the repository root.

---

## 1. Put the Civil 3D 2026 managed DLLs in `C_References\`

`C_References\` is git-ignored. Autodesk assemblies must never be committed.

```powershell
$acad = "C:\Program Files\Autodesk\AutoCAD 2026"
$refs = Join-Path $PWD "C_References"
New-Item -ItemType Directory -Force $refs | Out-Null
foreach ($name in "accoremgd","AcDbMgd","acmgd","AecBaseMgd","AeccDbMgd","AeccPressurePipesMgd") {
  $found = Get-ChildItem $acad, "$acad\C3D" -Filter "$name.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) { throw "$name.dll not found under $acad" }
  Copy-Item $found.FullName $refs -Force
}
Get-ChildItem $refs
```

## 2. Build the plugin

```powershell
dotnet build .\Civil3D-MCP-Plugin\Civil3DMcpPlugin.csproj -c Release -p:Civil3DReferencesPath="$refs"
```

Output: `Civil3D-MCP-Plugin\bin\Release\net8.0-windows\`. Check that the Roslyn
assemblies were copied next to the plugin:

```powershell
$out = ".\Civil3D-MCP-Plugin\bin\Release\net8.0-windows"
Get-ChildItem $out -Filter *.dll | Select-Object Name
# Expect: Civil3DMcpPlugin.dll, Microsoft.CodeAnalysis.dll, Microsoft.CodeAnalysis.CSharp.dll,
#         Microsoft.CodeAnalysis.Scripting.dll, Microsoft.CodeAnalysis.CSharp.Scripting.dll
# Autodesk DLLs must NOT be in the output (they are referenced with Private=false).
```

Optional, no Civil 3D needed:

```powershell
npm run test:code-engine      # Roslyn engine: compile errors, runtime errors, cache, caps
npm run test:p2-boundaries    # FileBoundary incl. WriteAllBytesAtomic
```

## 3. Build and test the MCP server

```powershell
npm ci; npm run build; npm test
node .\scripts\generate-tool-docs.mjs --check
```

## 4. Back up and update the bundle

```powershell
$bundle = "$env:APPDATA\Autodesk\ApplicationPlugins\Civil3DMcp.bundle"
$contents = "$bundle\Contents\2026"
# Civil 3D must be closed, otherwise the DLLs are locked.
Get-Process acad -ErrorAction SilentlyContinue | ForEach-Object { throw "Close Civil 3D (pid $($_.Id)) first." }

$backup = "$bundle\Contents\2026.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $contents $backup -Recurse
Copy-Item "$out\Civil3DMcpPlugin.dll", "$out\Civil3DMcpPlugin.deps.json", "$out\Microsoft.CodeAnalysis*.dll" $contents -Force
Get-ChildItem $contents
```

**`PackageContents.xml`:** no change is needed. Its `ComponentEntry` keeps
pointing at `./Contents/2026/Civil3DMcpPlugin.dll`. The four
`Microsoft.CodeAnalysis*.dll` files only have to be in the same folder, because
.NET resolves an assembly's dependencies from the folder it was loaded from.
`System.Collections.Immutable` and `System.Reflection.Metadata` 8.0 come with
the .NET 8 runtime that Civil 3D uses, and `System.Drawing` comes with the
Windows Desktop runtime that it already loads, so neither is deployed. Check
with:

```powershell
Select-String -Path "$bundle\PackageContents.xml" -Pattern "ModuleName"
```

To roll back, delete `$contents` and rename the backup folder to `2026`.

## 5. Restart Civil 3D and reconnect the MCP server

1. Start Civil 3D 2026 Metric. To test the boundary on a scratch folder, set
   the roots before launching (or use `civil3d_launch` with `fileRoots`):
   ```powershell
   $env:CIVIL3D_FILE_ROOTS = "$env:USERPROFILE\Documents\c3d-mcp-smoke"
   New-Item -ItemType Directory -Force $env:CIVIL3D_FILE_ROOTS | Out-Null
   ```
2. In Civil 3D, run `C3DMCPSTATUS` and check that the listener is running on port 8080.
3. Reconnect the MCP server so it picks up the new build. In Claude Code, run
   `/mcp` and reconnect `civil3d-mcp`, or restart the client. Then call
   `civil3d_health`.

## 6. Smoke tests (blank drawing)

Start from a new blank drawing (`civil3d_drawing {action:"new"}` or QNEW).
Write actions need an approval token. Call `civil3d_request_approval` with the
same `toolName`, `action`, and `parameters`, then repeat the call with
`approvalToken`. For local smoke testing only, you can set
`CIVIL3D_APPROVAL_MODE=disabled` in the MCP server environment instead.

| # | Call | Expected |
|---|---|---|
| 1 | `civil3d_execute_code {"code":"return Db.Filename;"}` (write, approved) | `success: true`, `committed: true`, `returnValue` is `Database.Filename` (for a new, unsaved drawing this is usually the template path). |
| 2 | `civil3d_execute_code {"mode":"read","code":"return CivilDoc.GetSurfaceIds().Cast<ObjectId>().Select(id => ((Surface)Tr.GetObject(id, OpenMode.ForRead)).Name).ToList();"}` | `success: true`, `committed: false`, `returnValue: []` on a blank drawing. No approval prompt. |
| 3 | `civil3d_execute_code {"mode":"read","code":"var a = 1;\nreturn b;"}` | Tool call **succeeds** with `success: false` and `compileErrors[0]` = `{line: 2, column: 8, id: "CS0103"}`. Civil 3D shows no error. |
| 4 | `civil3d_execute_code {"code":"CivilDoc.Styles.PointStyles.Add(\"SMOKE_ROLLBACK\"); throw new Exception(\"rollback test\");"}` (write, approved), then `{"mode":"read","code":"return CivilDoc.Styles.PointStyles.Contains(\"SMOKE_ROLLBACK\");"}` | First call: `success: false`, `runtimeError.type: "System.Exception"`, `committed: false`. Second call: `returnValue: false`, so the transaction was aborted and the drawing is unchanged. |
| 5 | Copy any `.dwg` to `$env:CIVIL3D_FILE_ROOTS\scratch.dwg`. Then `civil3d_drawing {"action":"open","path":"<root>\\scratch.dwg"}` (approved), then `{"action":"list_open"}`, then `{"action":"activate","name":"<first drawing>"}`, then `{"action":"activate","name":"scratch.dwg"}`, then `{"action":"close","name":"scratch.dwg","save":false}` (approved) | `open` returns `isActive: true`. `list_open` shows both drawings with the right `isActive`. `activate` switches the active drawing. `close` returns `saved: false`. Repeat with a modified drawing and `save` omitted: you get `CIVIL3D.CONFLICT` and the drawing stays open. |
| 6 | Draw a line, then `civil3d_capture_view {"outputPath":"<root>\\smoke.png","view":"extents","width":1600,"height":900}` (approved) | A PNG exists. Check its size with `Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile("<root>\smoke.png"); "$($i.Width)x$($i.Height)"; $i.Dispose()`, which should print `1600x900`. The response reports `method`. The on-screen view is unchanged afterwards. Try `background:"white"` and a path outside the roots (expect `CIVIL3D.PATH_NOT_ALLOWED`). |
| 7 | `civil3d_list_installations {}` | Lists `R25.1` / `Autodesk Civil 3D 2026` with `acadExe` under `C:\Program Files\Autodesk\AutoCAD 2026\`. |
| 8 | `civil3d_launch {"profile":"metric"}` while Civil 3D is running | `launched: false`, `alreadyRunning: true`, `pluginConnected: true`, and no second `acad.exe` in Task Manager. |

Optional: close Civil 3D and run
`civil3d_launch {"profile":"metric","fileRoots":["C:\\Users\\<you>\\Documents\\c3d-mcp-smoke"]}`.
Expect `launched: true` and, once the plugin loads, `pluginConnected: true`.

## Known limitations

- `execute_code` timeouts are cooperative. Scripts run synchronously on Civil
  3D's main thread and cannot be pre-empted. A tight loop that never calls
  `Log()` or checks `CancellationToken` blocks Civil 3D until it finishes; the
  result is still never committed.
- Each newly compiled script loads a small in-memory assembly for the rest of
  the session. The 32-entry cache avoids recompiling repeated code.
- `capture_view` output depends on the graphics system. If
  `CapturePreviewImage` returns an image at a different size, it is
  letterboxed to the requested size. The `warnings` field reports any
  fallback.
