import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { spawnMock, execFileMock, unrefMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
  unrefMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  HOST_INSTALLATIONS_DOMAIN_DEFINITION,
  HOST_LAUNCH_DOMAIN_DEFINITION,
  createDefaultHostDependencies,
  launchCivil3D,
  listInstallations,
  parseCivil3DInstallations,
  parseRegQueryKeys,
  parseTasklistCsv,
  setHostDependencies,
  type HostDependencies,
} from "../src/tools/domains/hostDomain.js";
import { isApprovalRequired } from "../src/tools/approvalPolicy.js";
import { registerTools } from "../src/tools/register.js";
import { getToolHandler } from "../src/tools/toolHandlerRegistry.js";

// Shape of `reg query HKLM\SOFTWARE\Autodesk\AutoCAD /s /v ProductName` followed by `/v AcadLocation`.
const REG_QUERY_OUTPUT = [
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R24.3\\ACAD-7100:409",
  "    ProductName    REG_SZ    Autodesk Civil 3D 2025",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R25.1\\ACAD-8100:409",
  "    ProductName    REG_SZ    Autodesk Civil 3D 2026",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R25.1\\ACAD-8101:409",
  "    ProductName    REG_SZ    AutoCAD 2026",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R25.1\\ACAD-8100:409\\Applications\\AeccUiBase",
  "    ProductName    REG_SZ    Civil 3D UI component",
  "End of search: 4 match(es) found.",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R24.3\\ACAD-7100:409",
  "    AcadLocation    REG_SZ    C:\\Program Files\\Autodesk\\AutoCAD 2025",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R25.1\\ACAD-8100:409",
  "    AcadLocation    REG_SZ    C:\\Program Files\\Autodesk\\AutoCAD 2026",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R25.1\\ACAD-8101:409",
  "    AcadLocation    REG_SZ    C:\\Program Files\\Autodesk\\AutoCAD 2026",
  "End of search: 3 match(es) found.",
].join("\r\n");

const TASKLIST_RUNNING = '"acad.exe","14820","Console","1","1,482,312 K"\r\n';
const TASKLIST_NONE = "INFO: No tasks are running which match the specified criteria.\r\n";

function fakeHost(overrides: Partial<HostDependencies> = {}) {
  let clock = 0;
  const deps: HostDependencies & { spawned: Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> } = {
    platform: "win32",
    queryRegistry: vi.fn(async () => REG_QUERY_OUTPUT),
    listAcadProcessIds: vi.fn(async () => []),
    spawnDetached: vi.fn((executable: string, args: string[], env: NodeJS.ProcessEnv) => {
      deps.spawned.push({ executable, args, env });
      return { pid: 4242 };
    }),
    isPluginHealthy: vi.fn(async () => false),
    sleep: vi.fn(async (ms: number) => { clock += ms; }),
    now: () => clock,
    spawned: [],
    ...overrides,
  };
  return deps;
}

describe("civil3d_list_installations registry parsing", () => {
  it("parses reg query keys and values", () => {
    const keys = parseRegQueryKeys(REG_QUERY_OUTPUT);
    expect(keys.get("HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R25.1\\ACAD-8100:409")?.get("acadlocation"))
      .toBe("C:\\Program Files\\Autodesk\\AutoCAD 2026");
  });

  it("returns only Civil 3D product keys, newest release first", () => {
    const installations = parseCivil3DInstallations(REG_QUERY_OUTPUT);

    expect(installations).toEqual([
      {
        release: "R25.1",
        productKey: "ACAD-8100:409",
        productName: "Autodesk Civil 3D 2026",
        installDir: "C:\\Program Files\\Autodesk\\AutoCAD 2026",
        acadExe: "C:\\Program Files\\Autodesk\\AutoCAD 2026\\acad.exe",
        profiles: ["metric", "imperial"],
      },
      {
        release: "R24.3",
        productKey: "ACAD-7100:409",
        productName: "Autodesk Civil 3D 2025",
        installDir: "C:\\Program Files\\Autodesk\\AutoCAD 2025",
        acadExe: "C:\\Program Files\\Autodesk\\AutoCAD 2025\\acad.exe",
        profiles: ["metric", "imperial"],
      },
    ]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(parseCivil3DInstallations("\r\nEnd of search: 0 match(es) found.\r\n")).toEqual([]);
  });

  it("parses tasklist CSV output", () => {
    expect(parseTasklistCsv(TASKLIST_RUNNING)).toEqual([14820]);
    expect(parseTasklistCsv(TASKLIST_NONE)).toEqual([]);
  });

  it("lists installations on Windows and refuses elsewhere", async () => {
    await expect(listInstallations(fakeHost())).resolves.toMatchObject({
      installations: [expect.objectContaining({ release: "R25.1" }), expect.objectContaining({ release: "R24.3" })],
    });
    await expect(listInstallations(fakeHost({ platform: "linux" }))).rejects.toMatchObject({ code: "CIVIL3D.UNAVAILABLE" });
  });
});

describe("civil3d_launch", () => {
  it("returns the running instance when the plugin already answers", async () => {
    const host = fakeHost({
      isPluginHealthy: vi.fn(async () => true),
      listAcadProcessIds: vi.fn(async () => [14820]),
    });

    const result = await launchCivil3D({ profile: "metric" }, host);

    expect(result).toEqual({ launched: false, alreadyRunning: true, pid: 14820, pluginConnected: true, waitedMs: 0 });
    expect(host.spawnDetached).not.toHaveBeenCalled();
  });

  it("never starts a second instance while acad.exe is starting up", async () => {
    const health = [false, false, true];
    const host = fakeHost({
      listAcadProcessIds: vi.fn(async () => [14820]),
      isPluginHealthy: vi.fn(async () => health.shift() ?? true),
    });

    const result = await launchCivil3D({ profile: "metric" }, host);

    expect(result).toMatchObject({ launched: false, alreadyRunning: true, pid: 14820, pluginConnected: true });
    expect(host.spawnDetached).not.toHaveBeenCalled();
    expect(host.sleep).toHaveBeenCalledTimes(1);
  });

  it("spawns the newest Civil 3D with the metric profile and child-only file roots, then polls health", async () => {
    const health = [false, false, false, true];
    const host = fakeHost({ isPluginHealthy: vi.fn(async () => health.shift() ?? true) });
    const before = process.env.CIVIL3D_FILE_ROOTS;

    const result = await launchCivil3D({ profile: "metric", fileRoots: ["C:\\Projects\\Site", "D:\\Exports"] }, host);

    expect(host.spawned).toHaveLength(1);
    expect(host.spawned[0].executable).toBe("C:\\Program Files\\Autodesk\\AutoCAD 2026\\acad.exe");
    expect(host.spawned[0].args).toEqual([
      "/ld", "C:\\Program Files\\Autodesk\\AutoCAD 2026\\AecBase.dbx",
      "/p", "<<C3D_Metric>>",
      "/product", "C3D",
      "/language", "en-US",
    ]);
    expect(host.spawned[0].env.CIVIL3D_FILE_ROOTS).toBe("C:\\Projects\\Site;D:\\Exports");
    expect(process.env.CIVIL3D_FILE_ROOTS).toBe(before);
    expect(result).toEqual({
      launched: true,
      alreadyRunning: false,
      pid: 4242,
      pluginConnected: true,
      waitedMs: 4_000,
      release: "R25.1",
      productName: "Autodesk Civil 3D 2026",
      profile: "metric",
      acadExe: "C:\\Program Files\\Autodesk\\AutoCAD 2026\\acad.exe",
    });
  });

  it("selects a requested release and the imperial profile", async () => {
    for (const release of ["R24.3", "24.3", "2025"]) {
      const host = fakeHost({ isPluginHealthy: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true) });
      await launchCivil3D({ release, profile: "imperial", waitForPluginMs: 10_000 }, host);
      expect(host.spawned[0].executable).toBe("C:\\Program Files\\Autodesk\\AutoCAD 2025\\acad.exe");
      expect(host.spawned[0].args).toContain("<<C3D_Imperial>>");
    }
  });

  it("reports pluginConnected=false when health polling times out", async () => {
    const host = fakeHost();
    const result = await launchCivil3D({ profile: "metric", waitForPluginMs: 5_000 }, host);

    expect(result).toMatchObject({ launched: true, pluginConnected: false, waitedMs: 5_000 });
  });

  it("does not wait when waitForPluginMs is 0", async () => {
    const host = fakeHost();
    const result = await launchCivil3D({ profile: "metric", waitForPluginMs: 0 }, host);

    expect(result).toMatchObject({ launched: true, pluginConnected: false, waitedMs: 0 });
    expect(host.isPluginHealthy).toHaveBeenCalledTimes(1);
  });

  it("fails clearly for missing releases, missing installs, and non-Windows hosts", async () => {
    await expect(launchCivil3D({ release: "2019", profile: "metric" }, fakeHost())).rejects.toMatchObject({ code: "CIVIL3D.OBJECT_NOT_FOUND" });
    await expect(launchCivil3D({ profile: "metric" }, fakeHost({ queryRegistry: vi.fn(async () => "") }))).rejects.toMatchObject({ code: "CIVIL3D.OBJECT_NOT_FOUND" });
    await expect(launchCivil3D({ profile: "metric" }, fakeHost({ platform: "darwin" }))).rejects.toMatchObject({ code: "CIVIL3D.UNAVAILABLE" });
  });

  it("validates launch arguments", () => {
    const schema = HOST_LAUNCH_DOMAIN_DEFINITION.actions.launch.inputSchema;
    expect(schema.safeParse({ profile: "metric" }).success).toBe(true);
    expect(schema.safeParse({ profile: "metric", fileRoots: ["C:\\Work", "\\\\server\\share\\civil"], waitForPluginMs: 600_000 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ profile: "si" }).success).toBe(false);
    expect(schema.safeParse({ profile: "metric", fileRoots: ["relative\\path"] }).success).toBe(false);
    expect(schema.safeParse({ profile: "metric", fileRoots: ["C:\\a;C:\\b"] }).success).toBe(false);
    expect(schema.safeParse({ profile: "metric", waitForPluginMs: 600_001 }).success).toBe(false);
    expect(z.object(HOST_LAUNCH_DOMAIN_DEFINITION.exposures[0].inputShape).safeParse({ profile: "imperial" }).success).toBe(true);
  });
});

describe("default host dependencies", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    execFileMock.mockReset();
    unrefMock.mockReset();
  });

  it("spawns acad.exe detached with stdio ignored and unreferenced", () => {
    spawnMock.mockReturnValue({ pid: 77, unref: unrefMock });
    const env = { CIVIL3D_FILE_ROOTS: "C:\\Work" };

    const child = createDefaultHostDependencies().spawnDetached("C:\\acad.exe", ["/p", "<<C3D_Metric>>"], env);

    expect(child.pid).toBe(77);
    expect(spawnMock).toHaveBeenCalledWith("C:\\acad.exe", ["/p", "<<C3D_Metric>>"], expect.objectContaining({ detached: true, stdio: "ignore", env }));
    expect(unrefMock).toHaveBeenCalled();
  });

  it("queries the 64-bit AutoCAD registry hive and tasklist", async () => {
    execFileMock.mockImplementation((file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      callback(null, file === "tasklist" ? TASKLIST_RUNNING : `${args.join(" ")}\r\n`);
    });
    const deps = createDefaultHostDependencies();

    const registry = await deps.queryRegistry();
    const pids = await deps.listAcadProcessIds();

    expect(registry).toContain("query HKLM\\SOFTWARE\\Autodesk\\AutoCAD /s /v ProductName /reg:64");
    expect(registry).toContain("query HKLM\\SOFTWARE\\Autodesk\\AutoCAD /s /v AcadLocation /reg:64");
    expect(pids).toEqual([14820]);
  });
});

describe("host tools through the MCP handler", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("does not require approval for list_installations or the idempotent launch", () => {
    for (const [definition, action] of [
      [HOST_INSTALLATIONS_DOMAIN_DEFINITION, "list_installations"],
      [HOST_LAUNCH_DOMAIN_DEFINITION, "launch"],
    ] as const) {
      const actionDefinition = definition.actions[action];
      expect(isApprovalRequired({
        toolName: definition.exposures[0].toolName,
        action,
        capabilities: actionDefinition.capabilities,
        safeForRetry: actionDefinition.safeForRetry,
      })).toBe(false);
    }
  });

  it("returns alreadyRunning without contacting the registry when Civil 3D is up", async () => {
    const host = fakeHost({ isPluginHealthy: vi.fn(async () => true), listAcadProcessIds: vi.fn(async () => [14820]) });
    restore = setHostDependencies(host);
    await registerTools(new McpServer({ name: "host-launch", version: "test" }));

    const result = await getToolHandler("civil3d_launch")!({ profile: "metric" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ action: "launch", result: { alreadyRunning: true, launched: false, pid: 14820 } });
    expect(host.queryRegistry).not.toHaveBeenCalled();
  });

  it("lists installations through the registered tool", async () => {
    restore = setHostDependencies(fakeHost());
    await registerTools(new McpServer({ name: "host-installations", version: "test" }));

    const result = await getToolHandler("civil3d_list_installations")!({});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      action: "list_installations",
      result: { installations: [expect.objectContaining({ productName: "Autodesk Civil 3D 2026" }), expect.anything()] },
    });
  });

  it("surfaces the non-Windows error code", async () => {
    restore = setHostDependencies(fakeHost({ platform: "linux" }));
    await registerTools(new McpServer({ name: "host-linux", version: "test" }));

    const result = await getToolHandler("civil3d_list_installations")!({});

    expect(result.isError).toBe(true);
    expect((result as { errorCode?: string }).errorCode).toBe("CIVIL3D.UNAVAILABLE");
  });
});
