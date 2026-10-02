import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendCommandMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
}));

vi.mock("../src/utils/ConnectionManager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ConnectionManager.js")>();
  return {
    ...actual,
    withApplicationConnection: async <T>(
      operation: (client: { sendCommand: typeof sendCommandMock }) => Promise<T>,
    ) => await operation({ sendCommand: sendCommandMock }),
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PLUGIN_DOMAIN_DEFINITION, PLUGIN_RESET_DOMAIN_DEFINITION, ResetQueueResponseSchema } from "../src/tools/domains/pluginDomain.js";
import { isApprovalRequired } from "../src/tools/approvalPolicy.js";
import { registerTools } from "../src/tools/register.js";
import { getToolHandler } from "../src/tools/toolHandlerRegistry.js";

const stuckOperation = { id: 7, operation: "getProfile", requestId: "\"rpc-1\"", state: "waiting_for_host", ageMs: 734_000 };
const baseHealth = {
  connected: true,
  civil3dVersion: "25.1s",
  pluginVersion: "1.2.1.0",
  drawingLoaded: true,
  operationInProgress: true,
  currentOperation: "getProfile",
  queueDepth: 3,
  queueCapacity: 64,
  currentOperationStartedAtUnixMs: 1,
  currentRequestId: "\"rpc-1\"",
  currentOperationDurationMs: 734_000,
  memoryUsageMb: 900,
  logFilePath: "C:\\logs\\plugin.log",
  fileLoggingHealthy: true,
  fileLoggingError: null,
  jobs: { total: 0, running: 0, completed: 0, failed: 0, cancelled: 0, capacity: 256, terminalRetentionMinutes: 1440 },
};

describe("stuck host queue diagnostics", () => {
  it("reports host operations and the start timeout in civil3d_health", () => {
    const parsed = PLUGIN_DOMAIN_DEFINITION.actions.health.responseSchema!.parse({
      ...baseHealth,
      hostStartTimeoutMs: 90_000,
      hostOperations: [stuckOperation, { ...stuckOperation, id: 8, operation: "listSurfaces", state: "queued", ageMs: 5_000 }],
    });

    expect(parsed.hostOperations).toHaveLength(2);
    expect(PLUGIN_DOMAIN_DEFINITION.exposures[0].description).toContain("civil3d_reset_queue");
  });

  it("keeps civil3d_health read-only", () => {
    expect(PLUGIN_DOMAIN_DEFINITION.actions.health.capabilities).toEqual(["query", "inspect"]);
  });
});

describe("civil3d_reset_queue", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
  });

  it("does not require approval, so it works while the queue is stuck", () => {
    const action = PLUGIN_RESET_DOMAIN_DEFINITION.actions.reset_queue;
    expect(isApprovalRequired({
      toolName: "civil3d_reset_queue",
      action: "reset_queue",
      capabilities: action.capabilities,
      safeForRetry: action.safeForRetry,
      requiresActiveDrawing: action.requiresActiveDrawing,
    })).toBe(false);
  });

  it("sends only resetHostQueue (no drawing fingerprint round-trip) and returns the result", async () => {
    sendCommandMock.mockResolvedValue({ abandoned: 3, stillRunning: [], message: "Abandoned 3 pending operation(s). The queue is free." });
    await registerTools(new McpServer({ name: "reset-queue", version: "test" }));

    const result = await getToolHandler("civil3d_reset_queue")!({});

    expect(result.isError).toBeUndefined();
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
    expect(sendCommandMock).toHaveBeenCalledWith("resetHostQueue", {});
    expect(result.structuredContent).toMatchObject({ action: "reset_queue", result: { abandoned: 3, stillRunning: [] } });
  });

  it("validates the reset response, including work that cannot be interrupted", () => {
    expect(ResetQueueResponseSchema.safeParse({
      abandoned: 0,
      stillRunning: [{ ...stuckOperation, operation: "executeCode", state: "running" }],
      message: "1 operation(s) are executing on Civil 3D's main thread and cannot be interrupted.",
    }).success).toBe(true);
    expect(ResetQueueResponseSchema.safeParse({ abandoned: 1 }).success).toBe(false);
  });
});

describe("server-side command timeout releases the plugin request", () => {
  let server: net.Server | undefined;
  const savedEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...savedEnv };
    vi.resetModules();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("closes the connection when a command times out, which cancels and abandons it in the plugin", async () => {
    let clientClosed!: () => void;
    const closed = new Promise<void>((resolve) => { clientClosed = resolve; });
    server = net.createServer((socket) => {
      // Accept the request and never answer, like a plugin blocked behind a modal dialog.
      socket.on("data", () => undefined);
      socket.on("end", () => clientClosed());
      socket.on("close", () => clientClosed());
    });
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as net.AddressInfo).port));
    });

    process.env.CIVIL3D_HOST = "127.0.0.1";
    process.env.CIVIL3D_PORT = String(port);
    process.env.CIVIL3D_COMMAND_TIMEOUT = "200";
    vi.resetModules();
    const { withApplicationConnection } = await vi.importActual<typeof import("../src/utils/ConnectionManager.js")>(
      "../src/utils/ConnectionManager.js",
    );

    const started = Date.now();
    await expect(withApplicationConnection(async (client) => await client.sendCommand("getProfile", { name: "EG" })))
      .rejects.toThrow("Command timed out after 200ms: getProfile");
    await closed;

    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
