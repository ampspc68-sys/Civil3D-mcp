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
import { CAPTURE_DOMAIN_DEFINITION, CaptureViewResponseSchema } from "../src/tools/domains/captureDomain.js";
import { isApprovalRequired } from "../src/tools/approvalPolicy.js";
import { registerTools } from "../src/tools/register.js";
import { getToolHandler } from "../src/tools/toolHandlerRegistry.js";

const capture = CAPTURE_DOMAIN_DEFINITION.actions.capture;
const exposure = CAPTURE_DOMAIN_DEFINITION.exposures[0];
const outputPath = "C:\\Users\\me\\Documents\\captures\\site.png";
const pluginResult = {
  path: outputPath,
  width: 1600,
  height: 900,
  bytes: 48_213,
  view: "extents",
  layout: "Model",
  background: "white",
  method: "OffScreenDevice",
  warnings: [],
};

describe("civil3d_capture_view schema", () => {
  it("accepts a minimal PNG capture and full option sets", () => {
    expect(capture.inputSchema.safeParse({ outputPath }).success).toBe(true);
    expect(capture.inputSchema.safeParse({
      outputPath,
      width: 4096,
      height: 2160,
      view: "window",
      window: { minX: 0, minY: 0, maxX: 100, maxY: 50 },
      background: "black",
      layout: "C-101",
      overwrite: true,
      includeThumbnail: true,
    }).success).toBe(true);
  });

  it("rejects non-PNG output, oversized images, and incomplete windows", () => {
    expect(capture.inputSchema.safeParse({ outputPath: "C:/out/site.jpg" }).success).toBe(false);
    expect(capture.inputSchema.safeParse({ outputPath, width: 4097 }).success).toBe(false);
    expect(capture.inputSchema.safeParse({ outputPath, height: 0 }).success).toBe(false);
    expect(capture.inputSchema.safeParse({ outputPath, view: "window" }).success).toBe(false);
    expect(capture.inputSchema.safeParse({ outputPath, view: "window", window: { minX: 10, minY: 0, maxX: 5, maxY: 5 } }).success).toBe(false);
    expect(capture.inputSchema.safeParse({ outputPath, background: "transparent" }).success).toBe(false);
  });

  it("exposes the same fields on the MCP tool and documents what is not captured", () => {
    const shape = z.object(exposure.inputShape);
    expect(shape.safeParse({ outputPath, view: "extents" }).success).toBe(true);
    expect(exposure.description).toContain("NOT captured");
    expect(exposure.description).toContain("export roots");
  });

  it("validates the plugin response contract", () => {
    expect(CaptureViewResponseSchema.safeParse(pluginResult).success).toBe(true);
    expect(CaptureViewResponseSchema.safeParse({ ...pluginResult, thumbnailBase64: "iVBORw0KGgo=", thumbnailMimeType: "image/png" }).success).toBe(true);
    expect(CaptureViewResponseSchema.safeParse({ path: outputPath }).success).toBe(false);
  });
});

describe("civil3d_capture_view plugin payload", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
    sendCommandMock.mockResolvedValue(pluginResult);
  });

  it("applies defaults for size, view, background, and overwrite", async () => {
    await capture.execute({ outputPath });

    expect(sendCommandMock).toHaveBeenCalledWith("captureView", {
      outputPath,
      width: 1600,
      height: 900,
      view: "current",
      window: undefined,
      background: "current",
      layout: undefined,
      overwrite: false,
      includeThumbnail: false,
    });
  });

  it("forwards window, layout, background, and thumbnail options", async () => {
    const window = { minX: 1000, minY: 2000, maxX: 1500, maxY: 2300 };
    await capture.execute({ outputPath, width: 800, height: 600, view: "window", window, background: "white", layout: "C-101", overwrite: true, includeThumbnail: true });

    expect(sendCommandMock).toHaveBeenCalledWith("captureView", {
      outputPath,
      width: 800,
      height: 600,
      view: "window",
      window,
      background: "white",
      layout: "C-101",
      overwrite: true,
      includeThumbnail: true,
    });
  });
});

describe("civil3d_capture_view approval", () => {
  beforeEach(() => {
    sendCommandMock.mockReset();
  });

  it("requires approval because it writes a file", () => {
    expect(isApprovalRequired({
      toolName: "civil3d_capture_view",
      action: "capture",
      capabilities: capture.capabilities,
      safeForRetry: capture.safeForRetry,
      requiresActiveDrawing: capture.requiresActiveDrawing,
    })).toBe(true);
  });

  it("blocks unapproved capture, then captures with a matching token", async () => {
    sendCommandMock.mockImplementation(async (command: string) =>
      command === "getDrawingInfo" ? { fileName: "site.dwg" } : pluginResult);
    await registerTools(new McpServer({ name: "capture-approval", version: "test" }));
    const handler = getToolHandler("civil3d_capture_view")!;
    const parameters = { outputPath, view: "extents" };

    const blocked = await handler(parameters);
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain("Approval required");
    expect(sendCommandMock).not.toHaveBeenCalledWith("captureView", expect.anything());

    const approval = await getToolHandler("civil3d_request_approval")!({
      toolName: "civil3d_capture_view", action: "capture", parameters,
    });
    const approvalToken = (approval.structuredContent as { approvalToken: string }).approvalToken;
    const result = await handler({ ...parameters, approvalToken });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ action: "capture", result: { path: outputPath, width: 1600, height: 900 } });
  });
});
