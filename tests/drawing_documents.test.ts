import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { DRAWING_RUNTIME_DOMAIN_DEFINITION } from "../src/tools/domains/drawingRuntimeDomain.js";
import { isApprovalRequired } from "../src/tools/approvalPolicy.js";
import { registerTools } from "../src/tools/register.js";
import { getToolHandler } from "../src/tools/toolHandlerRegistry.js";

const actions = DRAWING_RUNTIME_DOMAIN_DEFINITION.actions;
const exposureShape = z.object(DRAWING_RUNTIME_DOMAIN_DEFINITION.exposures[0].inputShape);
const openDocument = {
  name: "site.dwg",
  path: "C:\\Users\\me\\Documents\\site.dwg",
  isActive: true,
  isModified: false,
  isReadOnly: false,
};

function approvalTarget(action: "open" | "close" | "list_open" | "activate") {
  const definition = actions[action];
  return {
    toolName: "civil3d_drawing",
    action,
    capabilities: definition.capabilities,
    safeForRetry: definition.safeForRetry,
    requiresActiveDrawing: definition.requiresActiveDrawing,
  };
}

describe("civil3d_drawing document actions schema", () => {
  it("exposes open, close, list_open, and activate on the canonical tool", () => {
    const exposure = DRAWING_RUNTIME_DOMAIN_DEFINITION.exposures[0];
    expect(exposure.supportedActions).toEqual(expect.arrayContaining(["open", "close", "list_open", "activate"]));
    expect(exposureShape.safeParse({ action: "open", path: "C:/work/site.dwg", readOnly: true }).success).toBe(true);
    expect(exposureShape.safeParse({ action: "close", save: false }).success).toBe(true);
    expect(exposureShape.safeParse({ action: "reopen" }).success).toBe(false);
  });

  it("validates per-action arguments", () => {
    expect(actions.open.inputSchema.safeParse({ action: "open" }).success).toBe(false);
    expect(actions.open.inputSchema.safeParse({ action: "open", path: "C:/work/site.dwg" }).success).toBe(true);
    expect(actions.close.inputSchema.safeParse({ action: "close" }).success).toBe(true);
    expect(actions.close.inputSchema.safeParse({ action: "close", saveAs: "C:/work/copy.dwg", save: false }).success).toBe(false);
    expect(actions.activate.inputSchema.safeParse({ action: "activate" }).success).toBe(false);
    expect(actions.activate.inputSchema.safeParse({ action: "activate", name: "site.dwg" }).success).toBe(true);
  });

  it("validates plugin response contracts", () => {
    expect(actions.open.responseSchema!.safeParse({ ...openDocument, alreadyOpen: false }).success).toBe(true);
    expect(actions.list_open.responseSchema!.safeParse([openDocument, { ...openDocument, name: "Drawing1.dwg", path: null, isActive: false, isModified: null }]).success).toBe(true);
    expect(actions.close.responseSchema!.safeParse({
      closed: true, name: "site.dwg", path: openDocument.path, saved: false, savedTo: null, discardedChanges: true,
    }).success).toBe(true);
  });
});

describe("civil3d_drawing document action payloads", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    sendCommandMock.mockResolvedValue(openDocument);
  });

  it("opens with read-write and activation defaults", async () => {
    await actions.open.execute({ action: "open", path: "C:/work/site.dwg" });
    expect(sendCommandMock).toHaveBeenCalledWith("openDrawing", { path: "C:/work/site.dwg", readOnly: false, activate: true });
  });

  it("opens read-only without activating", async () => {
    await actions.open.execute({ action: "open", path: "C:/work/site.dwg", readOnly: true, activate: false });
    expect(sendCommandMock).toHaveBeenCalledWith("openDrawing", { path: "C:/work/site.dwg", readOnly: true, activate: false });
  });

  it("forwards an omitted save flag so the plugin can refuse to discard changes", async () => {
    await actions.close.execute({ action: "close" });
    expect(sendCommandMock).toHaveBeenCalledWith("closeDrawing", { name: undefined, save: undefined, saveAs: undefined, overwrite: false });
  });

  it("closes a named drawing with an explicit discard or save-as", async () => {
    await actions.close.execute({ action: "close", name: "scratch.dwg", save: false });
    expect(sendCommandMock).toHaveBeenLastCalledWith("closeDrawing", { name: "scratch.dwg", save: false, saveAs: undefined, overwrite: false });
    await actions.close.execute({ action: "close", saveAs: "C:/work/copy.dwg", overwrite: true });
    expect(sendCommandMock).toHaveBeenLastCalledWith("closeDrawing", { name: undefined, save: undefined, saveAs: "C:/work/copy.dwg", overwrite: true });
  });

  it("lists and activates open documents", async () => {
    await actions.list_open.execute({ action: "list_open" });
    expect(sendCommandMock).toHaveBeenLastCalledWith("listOpenDrawings", {});
    await actions.activate.execute({ action: "activate", name: "site.dwg" });
    expect(sendCommandMock).toHaveBeenLastCalledWith("activateDrawing", { name: "site.dwg" });
  });
});

describe("civil3d_drawing document action approval", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
  });

  it("requires approval for open and close but not list_open or activate", () => {
    expect(isApprovalRequired(approvalTarget("open"))).toBe(true);
    expect(isApprovalRequired(approvalTarget("close"))).toBe(true);
    expect(isApprovalRequired(approvalTarget("list_open"))).toBe(false);
    expect(isApprovalRequired(approvalTarget("activate"))).toBe(false);
  });

  it("blocks unapproved close and open before they reach the plugin", async () => {
    await registerTools(new McpServer({ name: "drawing-close-approval", version: "test" }));
    const handler = getToolHandler("civil3d_drawing")!;

    const close = await handler({ action: "close", save: false });
    const open = await handler({ action: "open", path: "C:/work/site.dwg" });

    expect(close.isError).toBe(true);
    expect(close.content[0].text).toContain("Approval required");
    expect(open.isError).toBe(true);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it("runs list_open and activate directly", async () => {
    sendCommandMock.mockImplementation(async (command: string) =>
      command === "listOpenDrawings" ? [openDocument] : openDocument);
    await registerTools(new McpServer({ name: "drawing-list-open", version: "test" }));
    const handler = getToolHandler("civil3d_drawing")!;

    const list = await handler({ action: "list_open" });
    const activate = await handler({ action: "activate", name: "site.dwg" });

    expect(list.isError).toBeUndefined();
    expect(list.structuredContent).toMatchObject({ action: "list_open", result: [openDocument] });
    expect(activate.isError).toBeUndefined();
    expect(sendCommandMock).toHaveBeenCalledWith("activateDrawing", { name: "site.dwg" });
  });
});
