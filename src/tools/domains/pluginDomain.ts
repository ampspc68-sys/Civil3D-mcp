import { z } from "zod";
import { withApplicationConnection } from "../../utils/ConnectionManager.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

const HostOperationSchema = z.object({
  id: z.number(),
  operation: z.string(),
  requestId: z.string().nullable(),
  state: z.enum(["queued", "waiting_for_host", "running", "abandoned"]),
  ageMs: z.number(),
});

const HealthResponseSchema = z.object({
  connected: z.boolean(),
  civil3dVersion: z.string().optional(),
  pluginVersion: z.string().optional(),
  drawingLoaded: z.boolean(),
  operationInProgress: z.boolean(),
  currentOperation: z.string().nullable(),
  queueDepth: z.number(),
  queueCapacity: z.number(),
  currentOperationStartedAtUnixMs: z.number().nullable(),
  currentRequestId: z.string().nullable(),
  currentOperationDurationMs: z.number().nullable(),
  memoryUsageMb: z.number(),
  logFilePath: z.string(),
  fileLoggingHealthy: z.boolean(),
  fileLoggingError: z.string().nullable(),
  hostStartTimeoutMs: z.number().optional(),
  hostOperations: z.array(HostOperationSchema).optional(),
  jobs: z.object({
    total: z.number(),
    running: z.number(),
    completed: z.number(),
    failed: z.number(),
    cancelled: z.number(),
    capacity: z.number(),
    terminalRetentionMinutes: z.number(),
  }),
});

export const ResetQueueResponseSchema = z.object({
  abandoned: z.number(),
  stillRunning: z.array(HostOperationSchema),
  message: z.string(),
});

export const PLUGIN_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "plugin",
  actions: {
    health: {
      action: "health",
      inputSchema: z.object({ action: z.literal("health") }),
      responseSchema: HealthResponseSchema,
      capabilities: ["query", "inspect"],
      requiresActiveDrawing: false,
      safeForRetry: true,
      pluginMethods: ["getCivil3DHealth"],
      execute: async () => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("getCivil3DHealth", {}),
      ),
    },
  },
  exposures: [
    {
      toolName: "civil3d_health",
      displayName: "Civil 3D Health",
      description: "Reports the status of the Civil 3D connection and plugin, including hostOperations (queued / waiting_for_host / running, with ageMs). An operation stuck in waiting_for_host usually means a modal dialog or an active command in Civil 3D; close it, or call civil3d_reset_queue to free the queue.",
      inputShape: {},
      supportedActions: ["health"],
      resolveAction: () => ({ action: "health", args: { action: "health" } }),
    },
  ],
};

export const PLUGIN_RESET_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "plugin",
  actions: {
    reset_queue: {
      action: "reset_queue",
      inputSchema: z.object({ action: z.literal("reset_queue") }),
      responseSchema: ResetQueueResponseSchema,
      // Recovery must work while the queue is stuck, so it cannot depend on the
      // approval policy's drawing fingerprint (which needs the queue). Abandoning
      // work Civil 3D has not started is idempotent.
      capabilities: ["manage"],
      requiresActiveDrawing: false,
      safeForRetry: true,
      pluginMethods: ["resetHostQueue"],
      execute: async () => await withApplicationConnection(
        async (appClient) => await appClient.sendCommand("resetHostQueue", {}),
      ),
    },
  },
  exposures: [
    {
      toolName: "civil3d_reset_queue",
      displayName: "Civil 3D Reset Queue",
      description: "Recovers a stuck Civil 3D plugin queue: abandons every queued MCP operation that Civil 3D has not started yet (for example one blocked behind a modal dialog), so later calls stop timing out. Abandoned operations never run later. Work already executing on Civil 3D's main thread cannot be interrupted and is listed in stillRunning. Does not change the drawing.",
      inputShape: {},
      supportedActions: ["reset_queue"],
      resolveAction: () => ({ action: "reset_queue", args: { action: "reset_queue" } }),
    },
  ],
};
