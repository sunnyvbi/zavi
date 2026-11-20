import { beforeEach, describe, expect, it, vi } from "vitest";

const e2bCalls = vi.hoisted(() => [] as string[]);

vi.mock("@/services/sandbox/e2b-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/sandbox/e2b-client")>()),
  wipeEnv: vi.fn(async (id: string) => {
    e2bCalls.push(`wipeEnv:${id}`);
  }),
  revokeSandboxGithubToken: vi.fn(async (id: string) => {
    e2bCalls.push(`revoke:${id}`);
  }),
}));

import {
  __resetVersionPreviewJobs,
  ERR_BOOT_FAILED,
  getVersionPreview,
  realVersionPreviewDeps,
  startVersionPreview,
  type VersionPreviewDeps,
  type VersionPreviewJob,
} from "@/services/build/version-preview";

const SHA = "3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c";
const PORT = 3400;
const TARGET = { github_full_name: "praxis-built/acme", default_branch: "main" };
const INPUT = { tenant_id: "t1", conductor_run_id: "cr_abcdefgh_1234" };
const TOKEN = "ghs_fresh";

type Box = { env: string | null; remote: string | null };
type Seen = { step: string; env: string | null; remote: string | null };

function fixture(over: Partial<VersionPreviewDeps> = {}) {
  const box: Box = { env: null, remote: null };
  const seen: Seen[] = [];
  const snap = (step: string) => seen.push({ step, env: box.env, remote: box.remote });
  const deps: VersionPreviewDeps = {
    resolveVersionCommit: vi.fn().mockResolvedValue({ commit_sha: SHA, label: "Darker hero", target: TARGET, installation_id: -1 }),
    mintInstallationToken: vi.fn().mockResolvedValue(TOKEN),
    resolveSandbox: vi.fn(async (args: { installation_token?: string }) => {
      if (args.installation_token) box.remote = args.installation_token;
      snap("resolve-sandbox");
      return { row_id: "row1", e2b_sandbox_id: "sb1" };
    }),
    injectSecrets: vi.fn(async (_id: string, secrets: Record<string, string>) => {
      box.env = secrets.GITHUB_TOKEN ?? null;
      snap("inject");
    }),
    wipeSecrets: vi.fn(async () => {
      box.env = null;
      box.remote = null;
      snap("wipe");
    }),
    pauseSandbox: vi.fn(async () => {
      snap("pause");
    }),
    bootstrapRepo: vi.fn(async () => {
      snap("bootstrap");
    }),
    exec: vi.fn(async (_id: string, script: string) => {
      const step = String(script).includes("git fetch") ? "fetch" : String(script).includes("mypg") ? "stop-previous" : "exec";
      snap(step);
      if (step === "fetch" && !box.remote) return { stdout: "", stderr: "fatal: could not read Username", exit_code: 128 };
      return { stdout: "", stderr: "", exit_code: 0 };
    }),
    startPreview: vi.fn(async () => {
      snap("install-and-serve");
      return { url: `https://${PORT}-sb1.e2b.app`, port: PORT };
    }),
    probe: vi.fn().mockResolvedValue(true),
    now: vi.fn(() => 1_000_000),
    ...over,
  };
  return { deps, box, seen };
}

async function settled(d: VersionPreviewDeps): Promise<VersionPreviewJob> {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setImmediate(r));
    const job = await getVersionPreview(INPUT, d);
    if (job && job.status !== "starting") return job;
  }
  throw new Error("job never left starting");
}

beforeEach(() => {
  __resetVersionPreviewJobs();
  e2bCalls.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("version preview: the GitHub token leaves the sandbox before the app's install scripts run", () => {
  it("the fetch runs with the token, then the token is gone from the env and the git remote before the stop script and the install", async () => {
    const { deps, seen } = fixture();
    startVersionPreview(INPUT, deps);
    const job = await settled(deps);
    expect(job.status).toBe("live");

    const fetch = seen.find((s) => s.step === "fetch");
    expect(fetch).toMatchObject({ env: TOKEN, remote: TOKEN });

    const install = seen.find((s) => s.step === "install-and-serve");
    expect(install).toBeTruthy();
    expect(install).toMatchObject({ env: null, remote: null });
    const stop = seen.find((s) => s.step === "stop-previous");
    expect(stop).toMatchObject({ env: null, remote: null });

    const steps = seen.map((s) => s.step);
    expect(steps.indexOf("wipe")).toBeGreaterThan(steps.indexOf("fetch"));
    expect(steps.indexOf("wipe")).toBeLessThan(steps.indexOf("stop-previous"));
    expect(steps.indexOf("wipe")).toBeLessThan(steps.indexOf("install-and-serve"));
    expect(deps.pauseSandbox).not.toHaveBeenCalled();
  });

  it("when the wipe fails, nothing is installed or served, the job dies and the box is force-paused with the token still inside", async () => {
    const { deps, seen } = fixture({
      wipeSecrets: vi.fn().mockRejectedValue(new Error("write failed")),
    });
    startVersionPreview(INPUT, deps);
    const job = await settled(deps);

    expect(job).toMatchObject({ status: "dead", url: null, error: ERR_BOOT_FAILED });
    expect(deps.startPreview).not.toHaveBeenCalled();
    expect(seen.map((s) => s.step)).not.toContain("stop-previous");
    expect(deps.pauseSandbox).toHaveBeenCalledTimes(1);
    expect(deps.pauseSandbox).toHaveBeenCalledWith({ row_id: "row1", e2b_sandbox_id: "sb1" }, { force: true });
  });

  it("a step that fails before the wipe and a cleanup wipe that also fails force-pauses the box", async () => {
    const { deps } = fixture({
      bootstrapRepo: vi.fn().mockRejectedValue(new Error("clone failed")),
      wipeSecrets: vi.fn().mockRejectedValue(new Error("write failed")),
    });
    startVersionPreview(INPUT, deps);
    const job = await settled(deps);
    expect(job.status).toBe("dead");
    expect(deps.wipeSecrets).toHaveBeenCalledTimes(1);
    expect(deps.pauseSandbox).toHaveBeenCalledWith({ row_id: "row1", e2b_sandbox_id: "sb1" }, { force: true });
  });

  it("leaves a token it did not mint alone: no wipe, no revoke, no force-pause, and the draft sandbox keeps serving", async () => {
    const { deps, seen, box } = fixture({
      mintInstallationToken: vi.fn().mockResolvedValue(null),
      wipeSecrets: vi.fn().mockRejectedValue(new Error("write failed")),
    });
    box.remote = "ghs_held_by_a_concurrent_build";
    box.env = "ghs_held_by_a_concurrent_build";
    startVersionPreview(INPUT, deps);
    const job = await settled(deps);
    expect(job.status).toBe("live");
    expect(deps.injectSecrets).not.toHaveBeenCalled();
    expect(deps.wipeSecrets).not.toHaveBeenCalled();
    expect(deps.pauseSandbox).not.toHaveBeenCalled();
    expect(seen.map((s) => s.step)).not.toContain("pause");
    expect(box).toEqual({ env: "ghs_held_by_a_concurrent_build", remote: "ghs_held_by_a_concurrent_build" });
  });

  it("a mint failure followed by a failed fetch still does not wipe or pause the shared sandbox", async () => {
    const { deps } = fixture({
      mintInstallationToken: vi.fn().mockRejectedValue(new Error("github 502")),
      wipeSecrets: vi.fn().mockRejectedValue(new Error("write failed")),
    });
    startVersionPreview(INPUT, deps);
    const job = await settled(deps);
    expect(job.status).toBe("dead");
    expect(deps.wipeSecrets).not.toHaveBeenCalled();
    expect(deps.pauseSandbox).not.toHaveBeenCalled();
  });

  it("the real wipe scrubs the git remote URL as well as the env file, like the live-edit wake path", async () => {
    await realVersionPreviewDeps.wipeSecrets!("sbx_1");
    expect(e2bCalls).toEqual(["revoke:sbx_1"]);
    expect(typeof realVersionPreviewDeps.pauseSandbox).toBe("function");
  });
});

describe("version preview: a fetch that fails still leaves no token behind", () => {
  it("wipes once on the failure path and exactly once on the success path", async () => {
    const failing = fixture({
      exec: vi.fn(async (_id: string, script: string) =>
        String(script).includes("git fetch") ? { stdout: "", stderr: "boom", exit_code: 1 } : { stdout: "", stderr: "", exit_code: 0 },
      ),
    });
    startVersionPreview(INPUT, failing.deps);
    expect((await settled(failing.deps)).status).toBe("dead");
    expect(failing.deps.wipeSecrets).toHaveBeenCalledTimes(1);
    expect(failing.deps.startPreview).not.toHaveBeenCalled();

    __resetVersionPreviewJobs();
    const ok = fixture();
    startVersionPreview(INPUT, ok.deps);
    expect((await settled(ok.deps)).status).toBe("live");
    expect(ok.deps.wipeSecrets).toHaveBeenCalledTimes(1);
  });
});
