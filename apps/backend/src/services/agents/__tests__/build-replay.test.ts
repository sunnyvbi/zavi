import { describe, it, expect, vi } from "vitest";
import type { AgentContext } from "../types";
import { getStringSettingStrict } from "@/services/settings";
import { execCommand, writeFile } from "@/services/sandbox/e2b-client";
import { getSandboxIdForRun } from "@/services/sandbox/lifecycle";

vi.mock("@/services/settings", () => ({ getStringSettingStrict: vi.fn() }));
vi.mock("@/services/sandbox/e2b-client", () => ({ execCommand: vi.fn(), writeFile: vi.fn() }));
vi.mock("@/services/sandbox/lifecycle", () => ({ getSandboxIdForRun: vi.fn() }));
vi.mock("@/services/sandbox/tool-registry", () => ({
  shellSingleQuote: (s: string) => `'${s.replace(/'/g, `'\\''`)}'`,
}));

import {
  replayBuildStage,
  resolveBuildReplayFixture,
  wasBuildReplayed,
  type BuildReplayDeps,
} from "../build-replay";

const STACK = "nextjs-supabase-tailwind";

function ctxFor(slug: string, extra: Partial<AgentContext> = {}): AgentContext {
  return { runId: `run-${slug}`, tenant_id: "t-1", agent: { slug }, ...extra } as unknown as AgentContext;
}

function scaffoldFixture(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    agent: "engineer",
    stage: "scaffold",
    stack: STACK,
    source_run_id: "src-run-1",
    output_text: "built the booking app",
    parsed: { title: "Booking app", rendered_markdown: "done", repo: "Praxis-build/other-tenant-repo", head_branch: "engineer/old" },
    files: [
      { path: "app/page.tsx", action: "create", content: "export default function Page() { return null }" },
      { path: "lib/db.ts", action: "modify", content: "export const db = 1" },
      { path: "public/old.txt", action: "delete" },
      { path: "public/logo.png", action: "create", content: "iVBORw0KGgo=", encoding: "base64" },
    ],
    ...overrides,
  });
}

function makeDeps(over: Partial<BuildReplayDeps> = {}) {
  const writes: Array<{ sandbox: string; file: string; content: string }> = [];
  const execs: Array<{ sandbox: string; command: string }> = [];
  const logs: string[] = [];
  const deps: BuildReplayDeps = {
    env: () => ({ NODE_ENV: "development" }),
    readSetting: vi.fn(async () => "db-app"),
    readFixture: vi.fn(async () => scaffoldFixture()),
    sandboxIdFor: vi.fn(async () => "sbx-1"),
    exec: vi.fn(async (sandbox: string, command: string) => {
      execs.push({ sandbox, command });
      return { exit_code: 0, stderr: "" };
    }),
    write: vi.fn(async (sandbox: string, file: string, content: string) => {
      writes.push({ sandbox, file, content });
    }),
    log: (line: string) => logs.push(line),
    ...over,
  };
  return { deps, writes, execs, logs };
}

const scaffoldPayload = { stage: "scaffold", stack: STACK, repo_hint: "praxis-built/acme-1234" };

describe("build replay never runs on a production or staging backend", () => {
  it("NODE_ENV=production with the setting on: no replay, no fixture read, no sandbox write", async () => {
    const { deps, writes, logs } = makeDeps({ env: () => ({ NODE_ENV: "production" }) });
    const result = await replayBuildStage(ctxFor("engineer"), scaffoldPayload, deps);
    expect(result).toBeNull();
    expect(deps.readFixture).not.toHaveBeenCalled();
    expect(deps.sandboxIdFor).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/never runs in production/);
  });

  it("a staging box (NODE_ENV=production + EXECUTION_ENV=staging) does not replay", async () => {
    const { deps } = makeDeps({ env: () => ({ NODE_ENV: "production", EXECUTION_ENV: "staging" }) });
    expect(await replayBuildStage(ctxFor("engineer"), scaffoldPayload, deps)).toBeNull();
    expect(deps.readFixture).not.toHaveBeenCalled();
  });

  it("any EXECUTION_ENV value blocks replay even without NODE_ENV=production", async () => {
    const { deps } = makeDeps({ env: () => ({ EXECUTION_ENV: "prod" }) });
    expect(await replayBuildStage(ctxFor("engineer"), scaffoldPayload, deps)).toBeNull();
  });

  it("the replay mark is not set on a blocked run, so the critic still runs", async () => {
    const ctx = ctxFor("engineer");
    const { deps } = makeDeps({ env: () => ({ NODE_ENV: "production" }) });
    await replayBuildStage(ctx, scaffoldPayload, deps);
    expect(wasBuildReplayed(ctx)).toBe(false);
  });
});

describe("build replay on a dev backend", () => {
  it("writes every saved file into the run's worktree and returns a zero-cost result", async () => {
    const ctx = ctxFor("engineer");
    const { deps, writes, execs } = makeDeps();
    const result = await replayBuildStage(
      ctx,
      { ...scaffoldPayload, _mt_repo_root: "/home/user/wt/run-1/" },
      deps,
    );

    expect(deps.readFixture).toHaveBeenCalledWith(
      expect.stringMatching(/dev-fixtures\/build-replay\/db-app\/nextjs-supabase-tailwind\/scaffold\.json$/),
    );
    expect(deps.sandboxIdFor).toHaveBeenCalledWith("t-1", "praxis-built/acme-1234");
    expect(writes.map((w) => w.file)).toEqual([
      "/home/user/wt/run-1/app/page.tsx",
      "/home/user/wt/run-1/lib/db.ts",
      "/home/user/wt/run-1/public/logo.png.replay-b64",
    ]);
    expect(writes.every((w) => w.sandbox === "sbx-1")).toBe(true);
    expect(execs.map((e) => e.command)).toContain("rm -f '/home/user/wt/run-1/public/old.txt'");
    expect(execs.map((e) => e.command)).toContain(
      "base64 -d '/home/user/wt/run-1/public/logo.png.replay-b64' > '/home/user/wt/run-1/public/logo.png' && rm -f '/home/user/wt/run-1/public/logo.png.replay-b64'",
    );

    expect(result).not.toBeNull();
    expect(result!.parse_ok).toBe(true);
    expect(result!.parsed).toEqual({
      title: "Booking app",
      rendered_markdown: "done",
      repo: "praxis-built/acme-1234",
      head_branch: "engineer/replay-scaffold-run-engi",
    });
    expect(result!.output_text).toBe("built the booking app");
    expect(result!.usage).toEqual({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    expect(wasBuildReplayed(ctx)).toBe(true);
    expect(wasBuildReplayed(ctxFor("engineer"))).toBe(false);
  });

  it("defaults to /home/user/repo and refuses a worktree root that escapes /home/user", async () => {
    const { deps, writes } = makeDeps();
    await replayBuildStage(ctxFor("engineer"), { ...scaffoldPayload, _mt_repo_root: "/home/user/../../etc" }, deps);
    expect(writes[0].file).toBe("/home/user/repo/app/page.tsx");
  });

  it("an unsafe path anywhere in the fixture stops the replay before ANY file is written", async () => {
    const { deps, writes, execs } = makeDeps({
      readFixture: vi.fn(async () =>
        scaffoldFixture({
          files: [
            { path: "app/page.tsx", action: "create", content: "ok" },
            { path: "../../etc/cron.d/x", action: "create", content: "pwn" },
          ],
        }),
      ),
    });
    await expect(replayBuildStage(ctxFor("engineer"), scaffoldPayload, deps)).rejects.toThrow(/unsafe fixture path/);
    expect(writes).toHaveLength(0);
    expect(execs).toHaveLength(0);
  });

  it("an absolute fixture path is refused", async () => {
    const { deps, writes } = makeDeps({
      readFixture: vi.fn(async () =>
        scaffoldFixture({ files: [{ path: "/etc/passwd", action: "create", content: "x" }] }),
      ),
    });
    await expect(replayBuildStage(ctxFor("engineer"), scaffoldPayload, deps)).rejects.toThrow(/unsafe fixture path/);
    expect(writes).toHaveLength(0);
  });

  it("replays the pm spec as text only, with no sandbox touch", async () => {
    const { deps, writes } = makeDeps({
      readFixture: vi.fn(async () =>
        JSON.stringify({
          agent: "pm",
          stage: "spec",
          stack: STACK,
          source_run_id: "src-spec",
          output_text: "PRD: dog grooming bookings",
          parsed: null,
        }),
      ),
    });
    const result = await replayBuildStage(ctxFor("pm"), { stage: "spec", idea: "dog grooming bookings" }, deps);
    expect(deps.readFixture).toHaveBeenCalledWith(expect.stringMatching(/nextjs-supabase-tailwind\/spec\.json$/));
    expect(result!.output_text).toBe("PRD: dog grooming bookings");
    expect(deps.sandboxIdFor).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("fails loudly when the sandbox is gone, so a broken replay never falls through to a paid model run", async () => {
    const { deps, writes } = makeDeps({ sandboxIdFor: vi.fn(async () => null) });
    await expect(replayBuildStage(ctxFor("engineer"), scaffoldPayload, deps)).rejects.toThrow(/no active sandbox/);
    expect(writes).toHaveLength(0);
  });

  it("fails loudly when the fixture has no file for this stage", async () => {
    const { deps } = makeDeps({ readFixture: vi.fn(async () => null) });
    await expect(
      replayBuildStage(ctxFor("engineer"), { ...scaffoldPayload, stage: "build" }, deps),
    ).rejects.toThrow(/has no nextjs-supabase-tailwind\/build\.json/);
  });

  it("refuses a fixture recorded for a different stage", async () => {
    const { deps, writes } = makeDeps();
    await expect(
      replayBuildStage(ctxFor("engineer"), { ...scaffoldPayload, stage: "build" }, deps),
    ).rejects.toThrow(/records engineer\/scaffold/);
    expect(writes).toHaveLength(0);
  });

  it("a failed sandbox delete aborts the replay", async () => {
    const { deps } = makeDeps({
      exec: vi.fn(async (_s: string, command: string) =>
        command.startsWith("rm -f") ? { exit_code: 1, stderr: "busy" } : { exit_code: 0, stderr: "" },
      ),
    });
    await expect(replayBuildStage(ctxFor("engineer"), scaffoldPayload, deps)).rejects.toThrow(/delete public\/old\.txt failed/);
  });
});

describe("which runs replay", () => {
  it.each([
    ["repair_mode", { ...scaffoldPayload, repair_mode: true }],
    ["refine_mode", { ...scaffoldPayload, refine_mode: true }],
  ])("%s runs on a replay tenant fail closed instead of running the paid model", async (_name, payload) => {
    const { deps, writes, execs } = makeDeps();
    await expect(replayBuildStage(ctxFor("engineer"), payload, deps)).rejects.toThrow(/refusing a paid model run/);
    expect(deps.readFixture).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(execs).toEqual([]);
  });

  it.each([
    ["repair_mode", { ...scaffoldPayload, repair_mode: true }],
    ["refine_mode", { ...scaffoldPayload, refine_mode: true }],
  ])("%s runs with replay off still use the real model", async (_name, payload) => {
    const { deps } = makeDeps({ readSetting: vi.fn(async () => "off") });
    expect(await replayBuildStage(ctxFor("engineer"), payload, deps)).toBeNull();
  });

  it("an agent that does not own the stage is never replayed", async () => {
    const { deps } = makeDeps();
    expect(await replayBuildStage(ctxFor("pm"), scaffoldPayload, deps)).toBeNull();
    expect(await replayBuildStage(ctxFor("qa"), { stage: "qa", stack: STACK }, deps)).toBeNull();
    expect(deps.readSetting).not.toHaveBeenCalled();
  });

  it("draft and shadow runs are never replayed", async () => {
    const { deps } = makeDeps();
    expect(await replayBuildStage(ctxFor("engineer", { draft_mode: true }), scaffoldPayload, deps)).toBeNull();
    expect(await replayBuildStage(ctxFor("engineer", { shadow_mode: true }), scaffoldPayload, deps)).toBeNull();
  });

  it("a codegen payload without a stack is never replayed", async () => {
    const { deps } = makeDeps();
    expect(await replayBuildStage(ctxFor("engineer"), { stage: "scaffold" }, deps)).toBeNull();
  });

  it("'off' and an empty value run the real model", async () => {
    for (const v of ["off", "", "  "]) {
      const { deps } = makeDeps({ readSetting: vi.fn(async () => v) });
      expect(await replayBuildStage(ctxFor("engineer"), scaffoldPayload, deps)).toBeNull();
      expect(deps.readFixture).not.toHaveBeenCalled();
    }
  });

  it("a setting read error runs the real model rather than failing the build", async () => {
    const { deps, logs } = makeDeps({ readSetting: vi.fn(async () => Promise.reject(new Error("db down"))) });
    expect(await replayBuildStage(ctxFor("engineer"), scaffoldPayload, deps)).toBeNull();
    expect(logs.join("\n")).toMatch(/setting read failed.*db down/);
  });

  it("an unknown fixture name fails loudly", async () => {
    const { deps } = makeDeps({ readSetting: vi.fn(async () => "../../secrets") });
    await expect(resolveBuildReplayFixture(ctxFor("engineer"), scaffoldPayload, deps)).rejects.toThrow(/unknown fixture/);
  });

  it("reads the setting fresh on every run, so turning it off mid-build stops the next stage", async () => {
    const values = ["db-app", "off"];
    const { deps } = makeDeps({ readSetting: vi.fn(async () => values.shift()!) });
    expect(await replayBuildStage(ctxFor("engineer"), scaffoldPayload, deps)).not.toBeNull();
    expect(await replayBuildStage(ctxFor("engineer"), { ...scaffoldPayload, stage: "build" }, deps)).toBeNull();
    expect(deps.readSetting).toHaveBeenCalledTimes(2);
  });
});

describe("a replay tenant's new-flow site build never reaches the paid model", () => {
  async function realDiskDeps() {
    const { promises: fs } = await import("node:fs");
    const reads: string[] = [];
    const made = makeDeps({
      readFixture: vi.fn(async (file: string) => {
        reads.push(file);
        try {
          return await fs.readFile(file, "utf8");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw e;
        }
      }),
    });
    return { ...made, reads };
  }

  async function siteBuildNodePayload() {
    const { buildSiteGoalGraph } = await import("../product-pipeline");
    const graph = buildSiteGoalGraph(
      { tenant_id: "7d00bd34-0000-0000-0000-000000000000", company_name: "Acme Clinic", idea: "a booking app" },
      {
        site_id: "site-1",
        target: { github_full_name: "praxis-built/acme-clinic", repo_url: "https://github.com/praxis-built/acme-clinic" },
        seed_sha: "abc123",
        publish_on_request: false,
      },
    );
    const build = graph.find((n) => (n.payload as { stage?: unknown }).stage === "build")!;
    return { ...(build.payload as Record<string, unknown>), repo_hint: "praxis-built/acme-clinic" };
  }

  it("the first fast build pass fails closed on the missing vite fixture, and the conductor's repair of it fails closed too", async () => {
    const first = await siteBuildNodePayload();
    expect(first).toMatchObject({ stage: "build", fast_single_pass: true, stack: "vite-react-supabase" });
    const { deps, writes, execs, reads } = await realDiskDeps();
    await expect(replayBuildStage(ctxFor("engineer"), first, deps)).rejects.toThrow(/has no vite-react-supabase\/build\.json/);
    expect(reads).toHaveLength(1);

    const repair = { ...first, stage: "build", repair_mode: true, repair_attempt: 1, failure_signal: "build replay failed" };
    await expect(replayBuildStage(ctxFor("engineer"), repair, deps)).rejects.toThrow(/refusing a paid model run/);
    const acceptance = { ...first, stage: "build", refine_mode: true, repair_mode: true, acceptance_repair: true };
    await expect(replayBuildStage(ctxFor("engineer"), acceptance, deps)).rejects.toThrow(/refusing a paid model run/);
    expect(reads).toHaveLength(1);
    expect(writes).toEqual([]);
    expect(execs).toEqual([]);
  });

  it("the conductor's repair of a failed qa node from an older graph on a replay tenant fails closed instead of running the paid qa agent", async () => {
    const { STAGE_AGENT } = await import("../autopilot-pipeline-contract");
    const legacyQaNodePayload = { stage: "qa", target: { github_full_name: "praxis-built/acme-clinic" } };
    const repair = {
      ...legacyQaNodePayload,
      refine_mode: true,
      repair_mode: true,
      repair_attempt: 1,
      failure_signal: "qa failed",
    };
    const { deps, writes, execs, reads } = await realDiskDeps();
    await expect(replayBuildStage(ctxFor(STAGE_AGENT.qa), repair, deps)).rejects.toThrow(/refusing a paid model run/);
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
    expect(execs).toEqual([]);
    const { deps: offDeps } = makeDeps({ readSetting: vi.fn(async () => "off") });
    expect(await replayBuildStage(ctxFor(STAGE_AGENT.qa), repair, offDeps)).toBeNull();
    expect(await replayBuildStage(ctxFor(STAGE_AGENT.qa), legacyQaNodePayload, makeDeps().deps)).toBeNull();
  });

  it("a stackless first-publish site fix on a replay tenant fails closed instead of running the paid model", async () => {
    const { deps, writes } = await realDiskDeps();
    const fix = {
      refine_mode: true,
      site_id: "site-1",
      target: { github_full_name: "praxis-built/acme-clinic" },
      stage: "build",
      repair_mode: true,
      repair_attempt: 1,
    };
    await expect(replayBuildStage(ctxFor("engineer"), fix, deps)).rejects.toThrow(/refusing a paid model run/);
    expect(writes).toEqual([]);
    const { deps: offDeps } = makeDeps({ readSetting: vi.fn(async () => "off") });
    expect(await replayBuildStage(ctxFor("engineer"), fix, offDeps)).toBeNull();
  });
});

describe("offered build replay fixtures", () => {
  it("every fixture offered by the setting and the config has a recorded directory", async () => {
    const { existsSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { BUILD_REPLAY_FIXTURES, BUILD_REPLAY_OFF } = await import("../build-replay-config");
    const { APP_SETTINGS } = await import("@/services/settings/registry");
    const root = join(__dirname, "..", "..", "..", "..", "dev-fixtures", "build-replay");
    const options = (APP_SETTINGS.build_replay_fixture as { options: readonly string[] }).options.filter((o) => o !== BUILD_REPLAY_OFF);
    expect([...options].sort()).toEqual([...BUILD_REPLAY_FIXTURES].sort());
    for (const fixture of new Set<string>([...options, ...BUILD_REPLAY_FIXTURES])) {
      const dir = join(root, fixture);
      expect(existsSync(dir) && statSync(dir).isDirectory(), `${fixture} has no ${dir}`).toBe(true);
    }
  });
});

describe("build replay with its default dependencies", () => {
  it("looks the sandbox up by the run's tenant AND the payload's repo, then writes the recorded files into it", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EXECUTION_ENV", "");
    vi.mocked(getStringSettingStrict).mockResolvedValue("db-app");
    vi.mocked(getSandboxIdForRun).mockImplementation(async (tenant_id: string, repo: string) =>
      tenant_id === "t-1" && repo === "praxis-built/acme-1234" ? "sbx-default" : null,
    );
    vi.mocked(execCommand).mockResolvedValue({ exit_code: 0, stdout: "", stderr: "" } as never);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    try {
      const result = await replayBuildStage(ctxFor("engineer"), scaffoldPayload);
      expect(getSandboxIdForRun).toHaveBeenCalledWith("t-1", "praxis-built/acme-1234");
      expect(result?.parse_ok).toBe(true);
      expect((result?.parsed as { repo?: string }).repo).toBe("praxis-built/acme-1234");
      expect(vi.mocked(writeFile).mock.calls.length).toBeGreaterThan(0);
      expect(vi.mocked(writeFile).mock.calls.every((c) => c[0] === "sbx-default")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
