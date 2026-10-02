import { z } from "zod";
import { withApplicationConnection } from "../../utils/ConnectionManager.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

export const CAPTURE_DEFAULT_WIDTH = 1600;
export const CAPTURE_DEFAULT_HEIGHT = 900;
export const CAPTURE_MAX_DIMENSION = 4096;

const DimensionSchema = z.number().int().min(16).max(CAPTURE_MAX_DIMENSION);
const WindowSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  maxX: z.number(),
  maxY: z.number(),
}).refine((window) => window.maxX > window.minX && window.maxY > window.minY, {
  message: "window must satisfy maxX > minX and maxY > minY.",
});
const OutputPathSchema = z.string().min(1).regex(/\.png$/i, "outputPath must end in .png");

const CaptureArgs = z.object({
  outputPath: OutputPathSchema,
  width: DimensionSchema.optional(),
  height: DimensionSchema.optional(),
  view: z.enum(["current", "extents", "window"]).optional(),
  window: WindowSchema.optional(),
  background: z.enum(["current", "white", "black"]).optional(),
  layout: z.string().min(1).optional(),
  overwrite: z.boolean().optional(),
  includeThumbnail: z.boolean().optional(),
}).refine((args) => args.view !== "window" || args.window !== undefined, {
  message: "view='window' requires window {minX, minY, maxX, maxY}.",
  path: ["window"],
});

export const CaptureViewResponseSchema = z.object({
  path: z.string(),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
  view: z.string().optional(),
  layout: z.string().optional(),
  background: z.string().optional(),
  method: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  thumbnailBase64: z.string().optional(),
  thumbnailMimeType: z.string().optional(),
}).passthrough();

const CAPTURE_DESCRIPTION = [
  "Saves the active drawing's model or layout view as a PNG file at a requested size, without screen capture or taking control of the screen.",
  "outputPath must be an absolute .png path under the configured export roots (CIVIL3D_EXPORT_ROOTS / CIVIL3D_FILE_ROOTS); existing files are only replaced with overwrite=true.",
  "width/height default to 1600x900 (max 4096). view: 'current' (as on screen), 'extents' (zoom extents of the current space), or 'window' with window {minX, minY, maxX, maxY} in WCS; the user's previous view is restored afterwards.",
  "layout switches to a named layout for the capture and switches back. background: 'current', 'white', or 'black'.",
  "includeThumbnail=true also returns a base64 PNG thumbnail (max 256 px). Returns {path, width, height, bytes, method, warnings}.",
  "Writes a file, so it requires approval (civil3d_request_approval with toolName='civil3d_capture_view', action='capture').",
  "NOTE: Civil 3D palettes, ribbons, and dialogs are NOT captured - only the model or layout view. For dialogs, use a normal screen capture.",
].join(" ");

export const CAPTURE_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "drawing",
  actions: {
    capture: {
      action: "capture",
      inputSchema: CaptureArgs,
      responseSchema: CaptureViewResponseSchema,
      capabilities: ["export"],
      requiresActiveDrawing: true,
      safeForRetry: false,
      pluginMethods: ["captureView"],
      execute: async (args) => {
        const parsed = args as z.infer<typeof CaptureArgs>;
        return await withApplicationConnection(async (appClient) => await appClient.sendCommand("captureView", {
          outputPath: parsed.outputPath,
          width: parsed.width ?? CAPTURE_DEFAULT_WIDTH,
          height: parsed.height ?? CAPTURE_DEFAULT_HEIGHT,
          view: parsed.view ?? "current",
          window: parsed.window,
          background: parsed.background ?? "current",
          layout: parsed.layout,
          overwrite: parsed.overwrite ?? false,
          includeThumbnail: parsed.includeThumbnail ?? false,
        }));
      },
    },
  },
  exposures: [
    {
      toolName: "civil3d_capture_view",
      displayName: "Civil 3D Capture View",
      description: CAPTURE_DESCRIPTION,
      inputShape: {
        outputPath: OutputPathSchema,
        width: DimensionSchema.optional(),
        height: DimensionSchema.optional(),
        view: z.enum(["current", "extents", "window"]).optional(),
        window: WindowSchema.optional(),
        background: z.enum(["current", "white", "black"]).optional(),
        layout: z.string().min(1).optional(),
        overwrite: z.boolean().optional(),
        includeThumbnail: z.boolean().optional(),
      },
      supportedActions: ["capture"],
      resolveAction: (rawArgs) => ({ action: "capture", args: rawArgs }),
    },
  ],
};
