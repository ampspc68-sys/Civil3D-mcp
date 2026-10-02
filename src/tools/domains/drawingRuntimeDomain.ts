import { z } from "zod";
import { withApplicationConnection } from "../../utils/ConnectionManager.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

const DrawingInfoResponseSchema = z.object({ fileName: z.string().optional(), filePath: z.string().optional(), coordinateSystem: z.string().nullable().optional(), linearUnits: z.enum(["feet", "meters", "other"]).optional(), angularUnits: z.enum(["degrees", "radians", "grads"]).optional(), unsavedChanges: z.boolean().optional(), objectCounts: z.object({ surfaces: z.number().optional(), alignments: z.number().optional(), profiles: z.number().optional(), corridors: z.number().optional(), pipeNetworks: z.number().optional(), points: z.number().optional(), parcels: z.number().optional() }).optional(), drawingName: z.string().optional(), projectName: z.string().nullable().optional(), units: z.string().optional() });
const DrawingSettingsResponseSchema = z.object({ coordinateSystem: z.string().nullable().optional(), coordinateZone: z.string().nullable().optional(), datum: z.string().nullable().optional(), scaleFactor: z.number().optional(), elevationReference: z.string().nullable().optional(), defaultLayer: z.string().optional(), defaultStyles: z.object({ surface: z.string().optional(), alignment: z.string().optional(), profile: z.string().optional(), corridor: z.string().optional(), pipeNetwork: z.string().optional() }).optional() });
const SelectedCivilObjectsResponseSchema = z.array(z.object({ handle: z.string(), objectType: z.string(), name: z.string().optional(), description: z.string().optional() }));
const CivilObjectTypesResponseSchema = z.array(z.string());
const GenericResponseSchema = z.object({}).passthrough();
const OpenDocumentSchema = z.object({ name: z.string(), path: z.string().nullable(), isActive: z.boolean(), isModified: z.boolean().nullable(), isReadOnly: z.boolean().optional() }).passthrough();
const OpenDrawingResponseSchema = OpenDocumentSchema.extend({ alreadyOpen: z.boolean().optional() });
const CloseDrawingResponseSchema = z.object({ closed: z.boolean(), name: z.string(), path: z.string().nullable(), saved: z.boolean(), savedTo: z.string().nullable(), discardedChanges: z.boolean() }).passthrough();
const ListOpenDrawingsResponseSchema = z.array(OpenDocumentSchema);

const DrawingInfoArgs = z.object({ action: z.literal("info") });
const DrawingNewArgs = z.object({ action: z.literal("new"), templatePath: z.string().optional() });
const DrawingSaveArgs = z.object({ action: z.literal("save"), saveAs: z.string().optional(), overwrite: z.boolean().optional() });
const DrawingUndoArgs = z.object({ action: z.literal("undo"), steps: z.number().int().min(1).max(10).optional() });
const DrawingRedoArgs = z.object({ action: z.literal("redo"), steps: z.number().int().min(1).max(10).optional() });
const DrawingSettingsArgs = z.object({ action: z.literal("settings") });
const SelectedObjectsArgs = z.object({ action: z.literal("selected_objects_info"), limit: z.number().optional() });
const ObjectTypesArgs = z.object({ action: z.literal("list_object_types") });
const DrawingOpenArgs = z.object({ action: z.literal("open"), path: z.string().min(1), readOnly: z.boolean().optional(), activate: z.boolean().optional() });
const DrawingCloseArgs = z.object({ action: z.literal("close"), name: z.string().min(1).optional(), save: z.boolean().optional(), saveAs: z.string().min(1).optional(), overwrite: z.boolean().optional() }).refine((args) => !(args.saveAs && args.save === false), { message: "saveAs cannot be combined with save=false." });
const DrawingListOpenArgs = z.object({ action: z.literal("list_open") });
const DrawingActivateArgs = z.object({ action: z.literal("activate"), name: z.string().min(1) });

const DRAWING_ACTIONS = ["info", "new", "save", "undo", "redo", "settings", "selected_objects_info", "list_object_types", "open", "close", "list_open", "activate"] as const;
const DRAWING_DESCRIPTION = [
  "Reads drawing state, settings, selection context, and document operations through a single domain tool.",
  "Document actions: open {path, readOnly?=false, activate?=true} opens a .dwg/.dwt from the configured import roots (returns the existing document if it is already open);",
  "close {name? (default active), save?, saveAs?, overwrite?} never discards unsaved changes unless save=false is passed explicitly, and returns a CONFLICT error when the drawing is modified and save is omitted;",
  "list_open returns [{name, path, isActive, isModified, isReadOnly}]; activate {name} switches the active document (name may be the file name or full path).",
  "open and close require approval; list_open and activate do not.",
].join(" ");

export const DRAWING_RUNTIME_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "drawing",
  actions: {
    info: { action: "info", inputSchema: DrawingInfoArgs, responseSchema: DrawingInfoResponseSchema, capabilities: ["query", "inspect"], requiresActiveDrawing: false, safeForRetry: true, pluginMethods: ["getDrawingInfo"], execute: async () => await withApplicationConnection(async (appClient) => await appClient.sendCommand("getDrawingInfo", {})) },
    new: { action: "new", inputSchema: DrawingNewArgs, responseSchema: GenericResponseSchema, capabilities: ["create", "manage"], requiresActiveDrawing: false, safeForRetry: false, pluginMethods: ["newDrawing"], execute: async (args) => await withApplicationConnection(async (appClient) => await appClient.sendCommand("newDrawing", { templatePath: args.templatePath })) },
    save: { action: "save", inputSchema: DrawingSaveArgs, responseSchema: GenericResponseSchema, capabilities: ["edit", "manage"], requiresActiveDrawing: false, safeForRetry: false, pluginMethods: ["saveDrawing"], execute: async (args) => await withApplicationConnection(async (appClient) => await appClient.sendCommand("saveDrawing", { saveAs: args.saveAs, overwrite: args.overwrite ?? false })) },
    undo: { action: "undo", inputSchema: DrawingUndoArgs, responseSchema: GenericResponseSchema, capabilities: ["edit", "manage"], requiresActiveDrawing: true, safeForRetry: false, pluginMethods: ["undoDrawing"], execute: async (args) => await withApplicationConnection(async (appClient) => await appClient.sendCommand("undoDrawing", { steps: args.steps ?? 1 })) },
    redo: { action: "redo", inputSchema: DrawingRedoArgs, responseSchema: GenericResponseSchema, capabilities: ["edit", "manage"], requiresActiveDrawing: true, safeForRetry: false, pluginMethods: ["redoDrawing"], execute: async (args) => await withApplicationConnection(async (appClient) => await appClient.sendCommand("redoDrawing", { steps: args.steps ?? 1 })) },
    settings: { action: "settings", inputSchema: DrawingSettingsArgs, responseSchema: DrawingSettingsResponseSchema, capabilities: ["query", "inspect"], requiresActiveDrawing: false, safeForRetry: true, pluginMethods: ["getDrawingSettings"], execute: async () => await withApplicationConnection(async (appClient) => await appClient.sendCommand("getDrawingSettings", {})) },
    selected_objects_info: { action: "selected_objects_info", inputSchema: SelectedObjectsArgs, responseSchema: SelectedCivilObjectsResponseSchema, capabilities: ["query", "inspect"], requiresActiveDrawing: true, safeForRetry: true, pluginMethods: ["getSelectedCivilObjectsInfo"], execute: async (args) => await withApplicationConnection(async (appClient) => await appClient.sendCommand("getSelectedCivilObjectsInfo", { limit: args.limit || 100 })) },
    open: { action: "open", inputSchema: DrawingOpenArgs, responseSchema: OpenDrawingResponseSchema, capabilities: ["manage"], requiresActiveDrawing: false, safeForRetry: false, pluginMethods: ["openDrawing"], execute: async (args) => await withApplicationConnection(async (appClient) => await appClient.sendCommand("openDrawing", { path: args.path, readOnly: args.readOnly ?? false, activate: args.activate ?? true })) },
    close: { action: "close", inputSchema: DrawingCloseArgs, responseSchema: CloseDrawingResponseSchema, capabilities: ["manage"], requiresActiveDrawing: true, safeForRetry: false, pluginMethods: ["closeDrawing"], execute: async (args) => await withApplicationConnection(async (appClient) => await appClient.sendCommand("closeDrawing", { name: args.name, save: args.save, saveAs: args.saveAs, overwrite: args.overwrite ?? false })) },
    list_open: { action: "list_open", inputSchema: DrawingListOpenArgs, responseSchema: ListOpenDrawingsResponseSchema, capabilities: ["query", "inspect"], requiresActiveDrawing: false, safeForRetry: true, pluginMethods: ["listOpenDrawings"], execute: async () => await withApplicationConnection(async (appClient) => await appClient.sendCommand("listOpenDrawings", {})) },
    activate: { action: "activate", inputSchema: DrawingActivateArgs, responseSchema: OpenDocumentSchema, capabilities: ["manage"], requiresActiveDrawing: false, safeForRetry: true, pluginMethods: ["activateDrawing"], execute: async (args) => await withApplicationConnection(async (appClient) => await appClient.sendCommand("activateDrawing", { name: args.name })) },
    list_object_types: { action: "list_object_types", inputSchema: ObjectTypesArgs, responseSchema: CivilObjectTypesResponseSchema, capabilities: ["query", "inspect"], requiresActiveDrawing: false, safeForRetry: true, pluginMethods: ["listCivilObjectTypes"], execute: async () => await withApplicationConnection(async (appClient) => await appClient.sendCommand("listCivilObjectTypes", {})) },
  },
  exposures: [
    { toolName: "civil3d_drawing", displayName: "Civil 3D Drawing", description: DRAWING_DESCRIPTION, inputShape: { action: z.enum(DRAWING_ACTIONS), templatePath: z.string().optional(), saveAs: z.string().optional(), overwrite: z.boolean().optional(), steps: z.number().int().min(1).max(10).optional(), limit: z.number().optional(), path: z.string().optional(), readOnly: z.boolean().optional(), activate: z.boolean().optional(), name: z.string().optional(), save: z.boolean().optional() }, supportedActions: [...DRAWING_ACTIONS], resolveAction: (rawArgs) => ({ action: String(rawArgs.action ?? ""), args: rawArgs }) },
    { toolName: "get_drawing_info", displayName: "Get Drawing Info", description: "Retrieves basic information about the active Civil 3D drawing.", inputShape: {}, supportedActions: ["info"], resolveAction: () => ({ action: "info", args: { action: "info" } }) },
    { toolName: "get_selected_civil_objects_info", displayName: "Get Selected Civil Objects Info", description: "Gets basic properties of currently selected Civil 3D objects.", inputShape: { limit: z.number().optional() }, supportedActions: ["selected_objects_info"], resolveAction: (rawArgs) => ({ action: "selected_objects_info", args: { action: "selected_objects_info", ...rawArgs } }) },
    { toolName: "list_civil_object_types", displayName: "List Civil Object Types", description: "Lists major Civil 3D object types available in the current context.", inputShape: {}, supportedActions: ["list_object_types"], resolveAction: () => ({ action: "list_object_types", args: { action: "list_object_types" } }) },
  ],
};
