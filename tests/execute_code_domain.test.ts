import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { sendCommandMock } = vi.hoisted(() => ({
  sendCommandMock: vi.fn(),
}));

vi.mock("../src/utils/ConnectionManager.js", () => ({
  withApplicationConnection: async <T>(
    operation: (client: { sendCommand: typeof sendCommandMock }) => Promise<T>,
  ) => await operation({ sendCommand: sendCommandMock }),
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CODE_DOMAIN_DEFINITION, ExecuteCodeResponseSchema } from "../src/tools/domains/codeDomain.js";
import { isApprovalRequired } from "../src/tools/approvalPolicy.js";
import { registerTools } from "../src/tools/register.js";
import { getToolHandler } from "../src/tools/toolHandlerRegistry.js";
import { findManifestAction } from "../src/tools/toolManifest.js";
import { ApplicationClientConnection } from "../src/utils/SocketClient.js";

const exposure = CODE_DOMAIN_DEFINITION.exposures[0];
const inputSchema = z.object(exposure.inputShape);
const successResult = {
  success: true,
  mode: "write",
  returnValue: "C:\\work\\site.dwg",
  output: "",
  compileErrors: [],
  runtimeError: null,
  durationMs: 12,
  truncated: false,
  committed: true,
};

function approvalTarget(action: "write" | "read") {
  const definition = CODE_DOMAIN_DEFINITION.actions[action];
  return {
    toolName: "civil3d_execute_code",
    action,
    capabilities: definition.capabilities,
    safeForRetry: definition.safeForRetry,
    requiresActiveDrawing: definition.requiresActiveDrawing,
  };
}

describe("civil3d_execute_code schema", () => {
  it("accepts code with optional mode and timeout", () => {
    expect(inputSchema.safeParse({ code: "return Db.Filename;" }).success).toBe(true);
    expect(inputSchema.safeParse({ code: "return 1;", mode: "read", timeoutMs: 300_000 }).success).toBe(true);
  });

  it("rejects empty code, unknown modes, and out-of-range timeouts", () => {
    expect(inputSchema.safeParse({ code: "" }).success).toBe(false);
    expect(inputSchema.safeParse({}).success).toBe(false);
    expect(inputSchema.safeParse({ code: "return 1;", mode: "commit" }).success).toBe(false);
    expect(inputSchema.safeParse({ code: "return 1;", timeoutMs: 300_001 }).success).toBe(false);
    expect(inputSchema.safeParse({ code: "return 1;", timeoutMs: 999 }).success).toBe(false);
    expect(inputSchema.safeParse({ code: "return 1;", timeoutMs: 1.5 }).success).toBe(false);
  });

  it("routes mode to the write or read action", () => {
    expect(exposure.resolveAction({ code: "x" }).action).toBe("write");
    expect(exposure.resolveAction({ code: "x", mode: "write" }).action).toBe("write");
    expect(exposure.resolveAction({ code: "x", mode: "read" }).action).toBe("read");
  });

  it("documents globals, return semantics, transaction behaviour, and examples", () => {
    for (const fragment of ["Doc", "Db", "Ed", "CivilDoc", "Tr", "Log(string)", "return x;", "ONE transaction", "mode='read'", "SECURITY", "PointStyles.Add", "SetElevationData"]) {
      expect(exposure.description).toContain(fragment);
    }
  });

  it("validates the plugin result contract", () => {
    expect(ExecuteCodeResponseSchema.safeParse(successResult).success).toBe(true);
    expect(ExecuteCodeResponseSchema.safeParse({
      ...successResult,
      success: false,
      returnValue: null,
      compileErrors: [{ line: 2, column: 9, id: "CS0103", message: "The name 'x' does not exist" }],
      committed: false,
    }).success).toBe(true);
    expect(ExecuteCodeResponseSchema.safeParse({ ...successResult, runtimeError: undefined }).success).toBe(false);
  });
});

describe("civil3d_execute_code plugin payloads", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    sendCommandMock.mockResolvedValue(successResult);
  });

  it("sends write mode with the default timeout and a longer transport timeout", async () => {
    await CODE_DOMAIN_DEFINITION.actions.write.execute({ code: "return Db.Filename;" });

    expect(sendCommandMock).toHaveBeenCalledWith(
      "executeCode",
      { code: "return Db.Filename;", mode: "write", timeoutMs: 60_000 },
      { timeoutMs: 90_000 },
    );
  });

  it("sends read mode with an explicit timeout", async () => {
    await CODE_DOMAIN_DEFINITION.actions.read.execute({ code: "return 1;", mode: "read", timeoutMs: 300_000 });

    expect(sendCommandMock).toHaveBeenCalledWith(
      "executeCode",
      { code: "return 1;", mode: "read", timeoutMs: 300_000 },
      { timeoutMs: 330_000 },
    );
  });
});

describe("civil3d_execute_code approval", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
  });

  it("requires approval for write mode only", () => {
    expect(isApprovalRequired(approvalTarget("write"))).toBe(true);
    expect(isApprovalRequired(approvalTarget("read"))).toBe(false);
  });

  it("blocks unapproved write execution before it reaches the plugin", async () => {
    await registerTools(new McpServer({ name: "execute-code-approval", version: "test" }));
    const result = await getToolHandler("civil3d_execute_code")!({ code: "return 1;" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Approval required");
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it("runs read mode directly and returns the structured result", async () => {
    sendCommandMock.mockResolvedValue({ ...successResult, mode: "read", committed: false });
    await registerTools(new McpServer({ name: "execute-code-read", version: "test" }));
    const result = await getToolHandler("civil3d_execute_code")!({ code: "return 1;", mode: "read" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ action: "read", result: { success: true, mode: "read" } });
    expect(sendCommandMock).toHaveBeenCalledTimes(1);
  });

  it("executes write mode with a token bound to the exact code", async () => {
    sendCommandMock.mockImplementation(async (command: string) =>
      command === "getDrawingInfo" ? { fileName: "site.dwg" } : successResult);
    await registerTools(new McpServer({ name: "execute-code-approved", version: "test" }));
    const parameters = { code: "return Db.Filename;", mode: "write" };

    const preview = await getToolHandler("civil3d_preview_action")!({
      toolName: "civil3d_execute_code", action: "write", parameters,
    });
    expect(preview.content[0].text).toContain('"approval_required"');

    const approval = await getToolHandler("civil3d_request_approval")!({
      toolName: "civil3d_execute_code", action: "write", parameters,
    });
    const approvalToken = (approval.structuredContent as { approvalToken: string }).approvalToken;

    const tampered = await getToolHandler("civil3d_execute_code")!({
      ...parameters, code: "Db.Purge(new ObjectIdCollection());", approvalToken,
    });
    expect(tampered.isError).toBe(true);
    expect(sendCommandMock).not.toHaveBeenCalledWith("executeCode", expect.anything(), expect.anything());

    const freshApproval = await getToolHandler("civil3d_request_approval")!({
      toolName: "civil3d_execute_code", action: "write", parameters,
    });
    const result = await getToolHandler("civil3d_execute_code")!({
      ...parameters,
      approvalToken: (freshApproval.structuredContent as { approvalToken: string }).approvalToken,
    });
    expect(result.isError).toBeUndefined();
    expect(sendCommandMock).toHaveBeenCalledWith(
      "executeCode",
      { code: "return Db.Filename;", mode: "write", timeoutMs: 60_000 },
      { timeoutMs: 90_000 },
    );
  });

  it("previews read mode as directly executable", async () => {
    await registerTools(new McpServer({ name: "execute-code-preview", version: "test" }));
    const preview = await getToolHandler("civil3d_preview_action")!({
      toolName: "civil3d_execute_code", action: "read", parameters: { code: "return 1;", mode: "read" },
    });

    expect(preview.content[0].text).toContain('"ready"');
    expect(findManifestAction("civil3d_execute_code", "read")?.actionDefinition.pluginMethods).toEqual(["executeCode"]);
  });
});

describe("per-command transport timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("extends but never shortens the default command timeout", async () => {
    vi.useFakeTimers();
    const client = new ApplicationClientConnection("localhost", 9);
    client.isConnected = true;
    client.socket.write = vi.fn() as unknown as typeof client.socket.write;

    const extended = client.sendCommand("executeCode", {}, { timeoutMs: 200_000 });
    const extendedOutcome = extended.then(() => "resolved", (error: Error) => error.message);
    const shortened = client.sendCommand("getDrawingInfo", {}, { timeoutMs: 10 });
    const shortenedOutcome = shortened.then(() => "resolved", (error: Error) => error.message);

    await vi.advanceTimersByTimeAsync(120_001);
    expect(await shortenedOutcome).toBe("Command timed out after 120000ms: getDrawingInfo");
    expect(client.responseCallbacks.size).toBe(1);

    await vi.advanceTimersByTimeAsync(80_000);
    expect(await extendedOutcome).toBe("Command timed out after 200000ms: executeCode");
    client.socket.destroy();
  });
});
