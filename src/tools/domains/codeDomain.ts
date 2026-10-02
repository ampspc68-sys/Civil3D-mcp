import { z } from "zod";
import { withApplicationConnection } from "../../utils/ConnectionManager.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

export const EXECUTE_CODE_DEFAULT_TIMEOUT_MS = 60_000;
export const EXECUTE_CODE_MIN_TIMEOUT_MS = 1_000;
export const EXECUTE_CODE_MAX_TIMEOUT_MS = 300_000;
export const EXECUTE_CODE_MAX_LENGTH = 200_000;
// Covers plugin queueing and Roslyn compilation on top of the script's own budget.
const TRANSPORT_GRACE_MS = 30_000;

const CodeSchema = z.string().min(1).max(EXECUTE_CODE_MAX_LENGTH);
const TimeoutSchema = z.number().int().min(EXECUTE_CODE_MIN_TIMEOUT_MS).max(EXECUTE_CODE_MAX_TIMEOUT_MS);

const ExecuteWriteArgs = z.object({
  code: CodeSchema,
  mode: z.literal("write").optional(),
  timeoutMs: TimeoutSchema.optional(),
});
const ExecuteReadArgs = z.object({
  code: CodeSchema,
  mode: z.literal("read"),
  timeoutMs: TimeoutSchema.optional(),
});

export const ExecuteCodeResponseSchema = z.object({
  success: z.boolean(),
  mode: z.enum(["write", "read"]),
  returnValue: z.unknown().optional(),
  output: z.string(),
  compileErrors: z.array(z.object({
    line: z.number(),
    column: z.number(),
    id: z.string().optional(),
    message: z.string(),
  })),
  runtimeError: z.object({
    type: z.string(),
    message: z.string(),
    stackTrace: z.string().nullable().optional(),
  }).nullable(),
  durationMs: z.number(),
  truncated: z.boolean(),
  committed: z.boolean().optional(),
}).passthrough();

async function executeCode(code: string, mode: "write" | "read", timeoutMs: number | undefined) {
  const effectiveTimeoutMs = timeoutMs ?? EXECUTE_CODE_DEFAULT_TIMEOUT_MS;
  return await withApplicationConnection(async (appClient) => await appClient.sendCommand(
    "executeCode",
    { code, mode, timeoutMs: effectiveTimeoutMs },
    { timeoutMs: effectiveTimeoutMs + TRANSPORT_GRACE_MS },
  ));
}

const EXECUTE_CODE_DESCRIPTION = [
  "Compiles and runs C# (Roslyn script) inside the live Civil 3D session with the full AutoCAD and Civil 3D .NET API.",
  "SECURITY: runs arbitrary code in the Civil 3D process on this machine. Local, trusted use only.",
  "",
  "Globals: Doc (Document), Db (Database), Ed (Editor), CivilDoc (CivilApplication.ActiveDocument), Tr (the open Transaction), Log(string) (captured into 'output'), CancellationToken.",
  "Imported namespaces: System, System.Linq, System.Collections.Generic, System.Text, Autodesk.AutoCAD.{ApplicationServices,DatabaseServices,EditorInput,Geometry,Colors}, Autodesk.Civil, Autodesk.Civil.{ApplicationServices,DatabaseServices,DatabaseServices.Styles,Settings}. 'Surface' and 'Section' mean the Civil 3D types and 'Entity' the AutoCAD type; fully qualify other ambiguous names.",
  "Use 'return x;' (or a final expression without a semicolon) to send a value back as JSON in 'returnValue'. ObjectIds and DB objects are summarized by handle; output and return values are capped at about 100 KB ('truncated': true).",
  "",
  "Everything runs on Civil 3D's main thread inside one DocumentLock and ONE transaction (Tr). Do not commit Tr yourself.",
  "mode='write' (default): Tr is committed when the code succeeds and aborted on any exception or timeout. Requires approval: call civil3d_request_approval with toolName='civil3d_execute_code', action='write', and the identical parameters, then retry with approvalToken.",
  "mode='read': Tr is always aborted, so database edits made through Tr are discarded. No approval. Read mode is not a sandbox: file I/O, commands, or extra transactions started by the code are not rolled back.",
  "Compile errors are returned in compileErrors[] with line/column (nothing runs). Runtime exceptions are returned in runtimeError. timeoutMs (default 60000, max 300000) is cooperative: Log() and CancellationToken observe it, and a script that overruns is never committed.",
  "",
  "Example (read) - list surfaces:",
  "  return CivilDoc.GetSurfaceIds().Cast<ObjectId>().Select(id => (Surface)Tr.GetObject(id, OpenMode.ForRead)).Select(s => new { s.Name, Type = s.GetType().Name }).ToList();",
  "Example (write) - create a point style:",
  "  return CivilDoc.Styles.PointStyles.Add(\"MCP Point Style\");",
  "Example (write) - Elevations analysis with 5 ranges and ACI colours on surface 'EG':",
  "  var id = CivilDoc.GetSurfaceIds().Cast<ObjectId>().First(i => ((Surface)Tr.GetObject(i, OpenMode.ForRead)).Name == \"EG\");",
  "  var s = (Surface)Tr.GetObject(id, OpenMode.ForWrite); var p = s.GetGeneralProperties();",
  "  double min = p.MinimumElevation, step = (p.MaximumElevation - min) / 5; short[] aci = { 1, 2, 3, 4, 5 };",
  "  var ranges = Enumerable.Range(0, 5).Select(i => new SurfaceAnalysisElevationData(min + i * step, min + (i + 1) * step, Color.FromColorIndex(ColorMethod.ByAci, aci[i]))).ToArray();",
  "  s.Analysis.SetElevationData(ranges); return ranges.Length;",
].join("\n");

export const CODE_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "code",
  actions: {
    write: {
      action: "write",
      inputSchema: ExecuteWriteArgs,
      responseSchema: ExecuteCodeResponseSchema,
      capabilities: ["create", "edit", "delete"],
      requiresActiveDrawing: true,
      safeForRetry: false,
      pluginMethods: ["executeCode"],
      execute: async (args) => {
        const parsed = args as z.infer<typeof ExecuteWriteArgs>;
        return await executeCode(parsed.code, "write", parsed.timeoutMs);
      },
    },
    read: {
      action: "read",
      inputSchema: ExecuteReadArgs,
      responseSchema: ExecuteCodeResponseSchema,
      capabilities: ["query", "inspect", "analyze"],
      requiresActiveDrawing: true,
      safeForRetry: true,
      pluginMethods: ["executeCode"],
      execute: async (args) => {
        const parsed = args as z.infer<typeof ExecuteReadArgs>;
        return await executeCode(parsed.code, "read", parsed.timeoutMs);
      },
    },
  },
  exposures: [
    {
      toolName: "civil3d_execute_code",
      displayName: "Civil 3D Execute Code",
      description: EXECUTE_CODE_DESCRIPTION,
      inputShape: {
        code: CodeSchema,
        mode: z.enum(["write", "read"]).optional(),
        timeoutMs: TimeoutSchema.optional(),
      },
      supportedActions: ["write", "read"],
      resolveAction: (rawArgs) => ({
        action: rawArgs.mode === "read" ? "read" : "write",
        args: rawArgs,
      }),
    },
  ],
};
