import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { withApplicationConnection } from "../../utils/ConnectionManager.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

/**
 * Server-side Civil 3D host management (Windows only): discovers installed
 * Civil 3D releases from the registry and launches one with the MCP plugin's
 * filesystem roots, then waits until the plugin answers health checks.
 */

export const LAUNCH_DEFAULT_WAIT_MS = 180_000;
export const LAUNCH_MAX_WAIT_MS = 600_000;
const HEALTH_POLL_INTERVAL_MS = 2_000;
const AUTOCAD_REGISTRY_ROOT = "HKLM\\SOFTWARE\\Autodesk\\AutoCAD";
const REG_QUERY_MAX_BUFFER = 64 * 1024 * 1024;

export const CIVIL3D_PROFILES = {
  metric: "<<C3D_Metric>>",
  imperial: "<<C3D_Imperial>>",
} as const;
export type Civil3DProfile = keyof typeof CIVIL3D_PROFILES;

export interface Civil3DInstallation {
  release: string;
  productKey: string;
  productName: string;
  installDir: string;
  acadExe: string;
  profiles: Civil3DProfile[];
}

export interface HostDependencies {
  platform: NodeJS.Platform;
  /** Raw `reg query` output covering HKLM\SOFTWARE\Autodesk\AutoCAD product keys. */
  queryRegistry: () => Promise<string>;
  /** Process ids of running acad.exe instances. */
  listAcadProcessIds: () => Promise<number[]>;
  spawnDetached: (executable: string, args: string[], env: NodeJS.ProcessEnv) => { pid?: number };
  /** True when the Civil 3D plugin answers getCivil3DHealth. */
  isPluginHealthy: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

class HostError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: REG_QUERY_MAX_BUFFER }, (error, stdout) => {
      // reg.exe exits 1 when a filtered search finds nothing; treat as empty output.
      if (error && !stdout) {
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  });
}

export function createDefaultHostDependencies(): HostDependencies {
  return {
    platform: process.platform,
    queryRegistry: async () => {
      const [productNames, locations] = await Promise.all([
        execFileText("reg", ["query", AUTOCAD_REGISTRY_ROOT, "/s", "/v", "ProductName", "/reg:64"]).catch(() => ""),
        execFileText("reg", ["query", AUTOCAD_REGISTRY_ROOT, "/s", "/v", "AcadLocation", "/reg:64"]).catch(() => ""),
      ]);
      return `${productNames}\n${locations}`;
    },
    listAcadProcessIds: async () => parseTasklistCsv(
      await execFileText("tasklist", ["/FI", "IMAGENAME eq acad.exe", "/FO", "CSV", "/NH"]).catch(() => ""),
    ),
    spawnDetached: (executable, args, env) => {
      const child = spawn(executable, args, { detached: true, stdio: "ignore", env, windowsHide: false });
      child.unref();
      return { pid: child.pid };
    },
    isPluginHealthy: async () => {
      try {
        const health = await withApplicationConnection(async (client) => await client.sendCommand("getCivil3DHealth", {}));
        return Boolean(health && typeof health === "object" && (health as { connected?: unknown }).connected !== false);
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

let hostDependencies: HostDependencies = createDefaultHostDependencies();

/** Test hook: replaces host dependencies and returns a restore function. */
export function setHostDependencies(overrides: Partial<HostDependencies>): () => void {
  const previous = hostDependencies;
  hostDependencies = { ...previous, ...overrides };
  return () => {
    hostDependencies = previous;
  };
}

/** Parses `reg query /s` output into key -> value-name -> data. */
export function parseRegQueryKeys(output: string): Map<string, Map<string, string>> {
  const keys = new Map<string, Map<string, string>>();
  let currentKey: string | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (/^HKEY_/i.test(line)) {
      currentKey = line;
      if (!keys.has(currentKey)) keys.set(currentKey, new Map());
      continue;
    }

    const value = /^\s+(.+?)\s{2,}(REG_[A-Z0-9_]+)(?:\s{2,}(.*))?$/.exec(rawLine.replace(/\r$/, ""));
    if (currentKey && value) {
      keys.get(currentKey)!.set(value[1].trim().toLowerCase(), (value[3] ?? "").trim());
    }
  }
  return keys;
}

function releaseSortKey(release: string): number[] {
  return release.replace(/^R/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareReleasesDescending(left: Civil3DInstallation, right: Civil3DInstallation): number {
  const a = releaseSortKey(left.release);
  const b = releaseSortKey(right.release);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.productKey.localeCompare(right.productKey);
}

/** Extracts Civil 3D product keys (ProductName contains "Civil 3D") from `reg query` output, newest first. */
export function parseCivil3DInstallations(output: string): Civil3DInstallation[] {
  const installations: Civil3DInstallation[] = [];
  for (const [key, values] of parseRegQueryKeys(output)) {
    const match = /\\SOFTWARE\\Autodesk\\AutoCAD\\(R\d+(?:\.\d+)*)\\(ACAD-[^\\]+)$/i.exec(key);
    const productName = values.get("productname");
    if (!match || !productName || !/civil 3d/i.test(productName)) continue;

    const installDir = values.get("acadlocation") ?? values.get("location");
    if (!installDir) continue;

    installations.push({
      release: match[1].toUpperCase(),
      productKey: match[2],
      productName,
      installDir,
      acadExe: path.win32.join(installDir, "acad.exe"),
      profiles: ["metric", "imperial"],
    });
  }
  return installations.sort(compareReleasesDescending);
}

/** Parses `tasklist /FO CSV /NH` output into process ids. */
export function parseTasklistCsv(output: string): number[] {
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const columns = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    if (columns.length >= 2 && /^acad\.exe$/i.test(columns[0])) {
      const pid = Number.parseInt(columns[1], 10);
      if (Number.isFinite(pid)) pids.push(pid);
    }
  }
  return pids;
}

function requireWindows(deps: HostDependencies, toolName: string) {
  if (deps.platform !== "win32") {
    throw new HostError(`${toolName} is only supported when the MCP server runs on Windows.`, "CIVIL3D.UNAVAILABLE");
  }
}

function selectInstallation(installations: Civil3DInstallation[], release: string | undefined): Civil3DInstallation {
  if (installations.length === 0) {
    throw new HostError("No Civil 3D installation was found in the registry.", "CIVIL3D.OBJECT_NOT_FOUND");
  }
  if (!release) return installations[0];

  const wanted = release.trim().toUpperCase().replace(/^(?=\d+\.)/, "R");
  const selected = installations.find((installation) =>
    installation.release === wanted || installation.productName.toUpperCase().includes(release.trim().toUpperCase()));
  if (!selected) {
    throw new HostError(
      `Civil 3D release '${release}' is not installed. Installed: ${installations.map((item) => `${item.release} (${item.productName})`).join(", ")}.`,
      "CIVIL3D.OBJECT_NOT_FOUND",
    );
  }
  return selected;
}

async function waitForPlugin(deps: HostDependencies, startedAt: number, waitForPluginMs: number): Promise<boolean> {
  while (true) {
    if (await deps.isPluginHealthy()) return true;
    const remaining = waitForPluginMs - (deps.now() - startedAt);
    if (remaining <= 0) return false;
    await deps.sleep(Math.min(HEALTH_POLL_INTERVAL_MS, remaining));
  }
}

export async function listInstallations(deps: HostDependencies = hostDependencies) {
  requireWindows(deps, "civil3d_list_installations");
  return { installations: parseCivil3DInstallations(await deps.queryRegistry()) };
}

export interface LaunchArgs {
  release?: string;
  profile: Civil3DProfile;
  fileRoots?: string[];
  waitForPluginMs?: number;
}

export async function launchCivil3D(args: LaunchArgs, deps: HostDependencies = hostDependencies) {
  requireWindows(deps, "civil3d_launch");
  const startedAt = deps.now();
  const waitForPluginMs = args.waitForPluginMs ?? LAUNCH_DEFAULT_WAIT_MS;

  if (await deps.isPluginHealthy()) {
    const [pid] = await deps.listAcadProcessIds();
    return { launched: false, alreadyRunning: true, pid: pid ?? null, pluginConnected: true, waitedMs: deps.now() - startedAt };
  }

  const running = await deps.listAcadProcessIds();
  if (running.length > 0) {
    // Never start a second instance; give a starting instance time to load the plugin.
    const pluginConnected = await waitForPlugin(deps, startedAt, waitForPluginMs);
    return { launched: false, alreadyRunning: true, pid: running[0], pluginConnected, waitedMs: deps.now() - startedAt };
  }

  const installation = selectInstallation(parseCivil3DInstallations(await deps.queryRegistry()), args.release);
  const commandArgs = [
    "/ld", path.win32.join(installation.installDir, "AecBase.dbx"),
    "/p", CIVIL3D_PROFILES[args.profile],
    "/product", "C3D",
    "/language", "en-US",
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (args.fileRoots && args.fileRoots.length > 0) {
    env.CIVIL3D_FILE_ROOTS = args.fileRoots.join(";");
  }

  const child = deps.spawnDetached(installation.acadExe, commandArgs, env);
  const pluginConnected = waitForPluginMs > 0 ? await waitForPlugin(deps, startedAt, waitForPluginMs) : false;
  return {
    launched: true,
    alreadyRunning: false,
    pid: child.pid ?? null,
    pluginConnected,
    waitedMs: deps.now() - startedAt,
    release: installation.release,
    productName: installation.productName,
    profile: args.profile,
    acadExe: installation.acadExe,
  };
}

const FileRootSchema = z.string().min(1)
  .refine((value) => path.win32.isAbsolute(value) && /^(?:[A-Za-z]:\\|\\\\)/.test(value.replace(/\//g, "\\")), "fileRoots entries must be absolute Windows paths.")
  .refine((value) => !/[;"]/.test(value), "fileRoots entries cannot contain ';' or '\"'.");

const ListInstallationsArgs = z.object({});
const LaunchArgsSchema = z.object({
  release: z.string().min(1).optional(),
  profile: z.enum(["metric", "imperial"]),
  fileRoots: z.array(FileRootSchema).max(16).optional(),
  waitForPluginMs: z.number().int().min(0).max(LAUNCH_MAX_WAIT_MS).optional(),
});

const InstallationSchema = z.object({
  release: z.string(),
  productKey: z.string(),
  productName: z.string(),
  installDir: z.string(),
  acadExe: z.string(),
  profiles: z.array(z.enum(["metric", "imperial"])),
});
export const ListInstallationsResponseSchema = z.object({ installations: z.array(InstallationSchema) });
export const LaunchResponseSchema = z.object({
  launched: z.boolean(),
  alreadyRunning: z.boolean(),
  pid: z.number().nullable(),
  pluginConnected: z.boolean(),
  waitedMs: z.number(),
  release: z.string().optional(),
  productName: z.string().optional(),
  profile: z.enum(["metric", "imperial"]).optional(),
  acadExe: z.string().optional(),
});

export const HOST_INSTALLATIONS_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "host",
  actions: {
    list_installations: {
      action: "list_installations",
      inputSchema: ListInstallationsArgs,
      responseSchema: ListInstallationsResponseSchema,
      capabilities: ["query", "inspect"],
      requiresActiveDrawing: false,
      safeForRetry: true,
      execute: async () => await listInstallations(),
    },
  },
  exposures: [
    {
      toolName: "civil3d_list_installations",
      displayName: "Civil 3D List Installations",
      description: "Lists Civil 3D releases installed on this Windows machine (HKLM\\SOFTWARE\\Autodesk\\AutoCAD\\R*\\ACAD-* product keys whose ProductName contains 'Civil 3D'), newest first, with release, productName, acadExe, and the metric/imperial profiles civil3d_launch accepts. Runs on the MCP server; Civil 3D does not need to be running.",
      inputShape: {},
      supportedActions: ["list_installations"],
      resolveAction: () => ({ action: "list_installations", args: {} }),
    },
  ],
};

export const HOST_LAUNCH_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "host",
  actions: {
    launch: {
      action: "launch",
      inputSchema: LaunchArgsSchema,
      responseSchema: LaunchResponseSchema,
      // Idempotent: a running Civil 3D is returned instead of starting another.
      capabilities: ["manage"],
      requiresActiveDrawing: false,
      safeForRetry: true,
      execute: async (args) => await launchCivil3D(args as z.infer<typeof LaunchArgsSchema>),
    },
  },
  exposures: [
    {
      toolName: "civil3d_launch",
      displayName: "Civil 3D Launch",
      description: [
        "Starts Civil 3D on this Windows machine and waits until the MCP plugin answers health checks.",
        "If Civil 3D is already running (plugin reachable or acad.exe present) nothing new is started and alreadyRunning=true is returned.",
        "release defaults to the newest installation ('R25.1', '25.1', or '2026' also match); profile 'metric' or 'imperial' selects <<C3D_Metric>> / <<C3D_Imperial>>.",
        "fileRoots sets CIVIL3D_FILE_ROOTS for the new Civil 3D process only (absolute Windows paths), defining the plugin's import/export roots.",
        "waitForPluginMs (default 180000, max 600000; 0 = do not wait). Returns {launched, alreadyRunning, pid, pluginConnected, waitedMs}.",
      ].join(" "),
      inputShape: {
        release: z.string().min(1).optional(),
        profile: z.enum(["metric", "imperial"]),
        fileRoots: z.array(FileRootSchema).max(16).optional(),
        waitForPluginMs: z.number().int().min(0).max(LAUNCH_MAX_WAIT_MS).optional(),
      },
      supportedActions: ["launch"],
      resolveAction: (rawArgs) => ({ action: "launch", args: rawArgs }),
    },
  ],
};
