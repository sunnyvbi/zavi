import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  refineProduct: vi.fn(),
  requestConductorTick: vi.fn(async (_client: unknown, _runId: string) => true),
  fixDeps: null as unknown,
  realDepsCalls: 0,
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => {
    throw new Error("the route must not read the database itself");
  },
  serviceClient: () => ({ from: () => ({}), rpc: vi.fn() }),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/agents/conductor-kick", () => ({
  requestConductorTick: mocks.requestConductorTick,
  requestTickForFinishedChild: vi.fn(),
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => true }));
vi.mock("@/services/agents/refine-product", async () => {
  const actual = await vi.importActual<typeof import("@/services/agents/refine-product")>("@/services/agents/refine-product");
  return { ...actual, refineProduct: mocks.refineProduct };
});
vi.mock("@/services/sites/preview-deps-fix", async () => {
  const actual = await vi.importActual<typeof import("@/services/sites/preview-deps-fix")>("@/services/sites/preview-deps-fix");
  return {
    ...actual,
    realPreviewDepsFixDeps: async () => {
      mocks.realDepsCalls += 1;
      if (mocks.fixDeps instanceof Error) throw mocks.fixDeps;
      return mocks.fixDeps;
    },
  };
});

import { postAutopilotRefineProduct } from "../autopilot";
import { STOP_TEMPLATE_DEV_SERVER_CMD } from "@/services/sites/sandbox-ready";

const SESSION = "11111111-1111-4111-8111-111111111111";
const LOCK = '{"packages":{"node_modules/react":{},"node_modules/lucide-react":{}}}';
const FIX = [
  "Fix these 2 errors in the preview:",
  "",
  '1. On /: [plugin:vite:import-analysis] Failed to resolve import "lucide-react" from "src/components/sections/Contact.tsx". Does the file exist?',
  "   at TransformPluginContext._formatError (file:///home/user/repo/node_modules/vite/dist/node/chunks/dep.js:49830:46)",
  "",
  '2. On /: [plugin:vite:import-analysis] Failed to resolve import "lucide-react" from "src/pages/Home.tsx". Does the file exist?',
].join("\n");

let dir: string;
let bin: string;
let scheduled: Array<Promise<unknown>>;
let booted: boolean[];
let stops: number;

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

async function post(body: Record<string, unknown>) {
  const res = mockRes();
  await postAutopilotRefineProduct({ body } as never, res as never);
  return res;
}

function npmCalls(): string[] {
  const log = join(bin, "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

function sandboxDeps(manifest: string) {
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "react"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "react", "package.json"), "{}");
  writeFileSync(join(dir, "node_modules", ".zavi-lock"), "0000000000000000000000000000000000000000\n");
  writeFileSync(join(dir, "package.json"), manifest);
  writeFileSync(join(dir, "package-lock.json"), LOCK);
  return {
    loadSite: vi.fn(async (tenant_id: string) => ({ id: "site-1", tenant_id, github_full_name: "Zavi-Latest-Build/brightsmile", status: "building" })),
    siteRunActive: vi.fn(async () => false),
    loadSandbox: vi.fn(async () => ({ e2b_sandbox_id: "it9amvtt44lxln8ivjejc", status: "active" })),
    claimLease: vi.fn(async () => "tok"),
    releaseLease: vi.fn(async () => undefined),
    exec: vi.fn(async (_id: string, cmd: string, _timeoutMs: number) => {
      if (cmd === STOP_TEMPLATE_DEV_SERVER_CMD) {
        stops += 1;
        return { stdout: "__stop=stopped\n", stderr: "", exit_code: 0 };
      }
      const r = spawnSync("bash", ["-c", `(set -e; ${cmd.split("/home/user/repo").join(dir)}\n)`], {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      return { stdout: r.stdout, stderr: r.stderr, exit_code: r.status ?? 1 };
    }),
    startPreview: vi.fn(async (_id: string, port: number) => {
      booted.push(existsSync(join(dir, "node_modules", "lucide-react", "package.json")));
      return { url: `https://${port}-it9amvtt44lxln8ivjejc.e2b.app`, port };
    }),
    recordPreview: vi.fn(async () => true),
    probeReady: vi.fn(async () => true),
    sleep: async () => undefined,
    schedule: (p: Promise<unknown>) => void scheduled.push(p),
    log: () => undefined,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zroute-"));
  bin = mkdtempSync(join(tmpdir(), "zroute-bin-"));
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho "$@" >> '${join(bin, "calls.log")}'\nfor p in react lucide-react; do mkdir -p "node_modules/$p"; echo '{}' > "node_modules/$p/package.json"; done\nexit $(cat '${join(bin, "exit")}' 2>/dev/null || echo 0)\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "timeout"), `#!/bin/sh\nshift\nexec "$@"\n`, { mode: 0o755 });
  scheduled = [];
  booted = [];
  stops = 0;
  mocks.realDepsCalls = 0;
  mocks.fixDeps = null;
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tnt-1", user_id: "u1", access_token: "tok" });
  mocks.requestConductorTick.mockClear();
  mocks.refineProduct.mockReset().mockResolvedValue({ conductor_run_id: "cr-new", parent_conductor_run_id: SESSION, target: "repo" });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.mocked(console.warn).mockRestore();
  rmSync(dir, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

describe("POST /refine-product: Fix error on a package the site declares but the sandbox never installed", () => {
  it("installs and restarts the preview directly: no agent run, no credits, no conductor tick", async () => {
    const d = sandboxDeps('{"dependencies":{"react":"18.3.1","lucide-react":"0.469.0"}}');
    mocks.fixDeps = d;
    const res = await post({ message: FIX, conductor_run_id: SESSION });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, conductor_run_id: null, fast_fix: { kind: "deps_reinstall", packages: ["lucide-react"] } });
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    expect(mocks.requestConductorTick).not.toHaveBeenCalled();
    expect(d.loadSite).toHaveBeenCalledWith("tnt-1", SESSION);
    await Promise.all(scheduled);
    expect(stops).toBe(1);
    expect(npmCalls()).toHaveLength(1);
    expect(npmCalls()[0]).toMatch(/^ci\b/);
    expect(booted).toEqual([true]);
    expect(d.recordPreview).toHaveBeenLastCalledWith(expect.objectContaining({ status: "live" }));
  });

  it("an undeclared package goes to the agent exactly as before, and the sandbox is left alone", async () => {
    const d = sandboxDeps('{"dependencies":{"react":"18.3.1"}}');
    mocks.fixDeps = d;
    const res = await post({ message: FIX, conductor_run_id: SESSION });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, conductor_run_id: "cr-new" });
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
    expect(mocks.refineProduct.mock.calls[0][0]).toMatchObject({ tenant_id: "tnt-1", conductor_run_id: SESSION });
    expect(mocks.refineProduct.mock.calls[0][0].message).toContain("Failed to resolve import");
    expect(mocks.requestConductorTick).toHaveBeenCalledWith(expect.anything(), "cr-new");
    expect(scheduled).toHaveLength(0);
    expect(stops).toBe(0);
    expect(npmCalls()).toHaveLength(0);
    expect(d.claimLease).not.toHaveBeenCalled();
  });

  it("any other preview error goes to the agent without reading the sandbox", async () => {
    const res = await post({ message: "Fix this error in the preview:\n\nOn /: TypeError: Cannot read properties of undefined (reading 'map')", conductor_run_id: SESSION });
    expect(res.statusCode).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
    expect(mocks.realDepsCalls).toBe(0);
  });

  it("a fast path that throws falls back to the agent instead of failing the click", async () => {
    mocks.fixDeps = new Error("e2b down");
    const res = await post({ message: FIX, conductor_run_id: SESSION });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ conductor_run_id: "cr-new" });
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
  });

  const SUBPATH_FIX = 'Fix this error in the preview:\n\nOn /: [plugin:vite:import-analysis] Failed to resolve import "lucide-react/icons/made-up" from "src/pages/Home.tsx". Does the file exist?';

  it("a made-up icon path under an installed, declared package goes to the agent and the sandbox is left alone", async () => {
    const d = sandboxDeps('{"dependencies":{"react":"18.3.1","lucide-react":"0.469.0"}}');
    mkdirSync(join(dir, "node_modules", "lucide-react"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "lucide-react", "package.json"), "{}");
    mocks.fixDeps = d;
    const res = await post({ message: SUBPATH_FIX, conductor_run_id: SESSION });
    expect(res.body).toMatchObject({ ok: true, conductor_run_id: "cr-new" });
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
    expect(mocks.requestConductorTick).toHaveBeenCalledWith(expect.anything(), "cr-new");
    expect(stops).toBe(0);
    expect(npmCalls()).toHaveLength(0);
    expect(d.claimLease).not.toHaveBeenCalled();
  });

  it("a second Fix error click on the same error after a fast fix reaches the agent", async () => {
    const d = sandboxDeps('{"dependencies":{"react":"18.3.1","lucide-react":"0.469.0"}}');
    mocks.fixDeps = d;
    const first = await post({ message: FIX, conductor_run_id: SESSION });
    expect(first.body).toMatchObject({ conductor_run_id: null, fast_fix: { kind: "deps_reinstall" } });
    await Promise.all(scheduled);
    rmSync(join(dir, "node_modules", "lucide-react"), { recursive: true, force: true });
    const second = await post({ message: FIX, conductor_run_id: SESSION });
    expect(second.body).toMatchObject({ ok: true, conductor_run_id: "cr-new" });
    expect(second.body).not.toHaveProperty("fast_fix");
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
    expect(stops).toBe(1);
    expect(npmCalls()).toHaveLength(1);
  });

  it("an install check that fails goes to the agent", async () => {
    const d = sandboxDeps('{"dependencies":{"react":"18.3.1","lucide-react":"0.469.0"}}');
    const real = d.exec.getMockImplementation()!;
    d.exec.mockImplementation(async (id: string, cmd: string, t: number) => {
      if (cmd.includes("__deps=")) throw new Error("e2b 502");
      return real(id, cmd, t);
    });
    mocks.fixDeps = d;
    const res = await post({ message: FIX, conductor_run_id: SESSION });
    expect(res.body).toMatchObject({ conductor_run_id: "cr-new" });
    expect(stops).toBe(0);
    expect(d.claimLease).not.toHaveBeenCalled();
  });

  it("an install that fails after the response starts the agent on the same error, so the founder sees it in the chat", async () => {
    const d = sandboxDeps('{"dependencies":{"react":"18.3.1","lucide-react":"0.469.0"}}');
    writeFileSync(join(bin, "exit"), "1");
    mocks.fixDeps = d;
    const res = await post({ message: FIX, conductor_run_id: SESSION, max_usd: 2 });
    expect(res.body).toMatchObject({ conductor_run_id: null, fast_fix: { kind: "deps_reinstall" } });
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    await Promise.all(scheduled);
    expect(d.startPreview).not.toHaveBeenCalled();
    expect(d.releaseLease).toHaveBeenCalledTimes(1);
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
    expect(mocks.refineProduct.mock.calls[0][0]).toMatchObject({ tenant_id: "tnt-1", conductor_run_id: SESSION, max_usd: 2, retry_of: null });
    expect(mocks.refineProduct.mock.calls[0][0].message).toContain("Failed to resolve import");
    expect(mocks.requestConductorTick).toHaveBeenCalledWith(expect.anything(), "cr-new");
    expect(d.releaseLease.mock.invocationCallOrder[0]).toBeLessThan(mocks.refineProduct.mock.invocationCallOrder[0]);
  });

  it("a fast fix that restarts the preview never starts the agent", async () => {
    mocks.fixDeps = sandboxDeps('{"dependencies":{"react":"18.3.1","lucide-react":"0.469.0"}}');
    await post({ message: FIX, conductor_run_id: SESSION });
    await Promise.all(scheduled);
    expect(booted).toEqual([true]);
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    expect(mocks.requestConductorTick).not.toHaveBeenCalled();
  });

  it("a Home workspace edit never takes the fast path", async () => {
    await post({ message: FIX, app: "workspace" });
    expect(mocks.realDepsCalls).toBe(0);
  });
});
