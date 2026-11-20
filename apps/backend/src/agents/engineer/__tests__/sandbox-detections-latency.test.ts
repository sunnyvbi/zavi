import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../stale-committed-dist", async (importOriginal) => {
  const real = await importOriginal<typeof import("../stale-committed-dist")>();
  return { ...real, detectStaleCommittedDist: vi.fn(real.detectStaleCommittedDist) };
});
const { buildSpy, gateSpy, execSpy } = vi.hoisted(() => ({
  buildSpy: vi.fn(),
  gateSpy: vi.fn(),
  execSpy: vi.fn(),
}));
vi.mock("@/services/sandbox/lifecycle", () => ({ getSandboxIdForRun: async () => "sbx-1" }));
vi.mock("@/services/sandbox/e2b-client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  execCommand: execSpy,
}));
vi.mock("@/services/pr-builder/from-sandbox-fs", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildPrFilesFromSandboxFs: buildSpy,
}));
vi.mock("../ship-gate", async (orig) => {
  const real = await orig<typeof import("../ship-gate")>();
  return {
    ...real,
    evaluateCtoShipGate: (env: unknown) =>
      env && typeof env === "object" && "files" in env ? gateSpy(env) : real.evaluateCtoShipGate(env),
  };
});
vi.mock("@/services/supabase", async (orig) => {
  const empty = { data: null, error: null };
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => void) => resolve(empty) : chain),
    apply: () => chain,
  });
  return { ...(await orig<Record<string, unknown>>()), serviceClient: () => chain };
});
vi.mock("../product-builder-flag", () => ({ isProductBuilderEnabled: async () => false }));
vi.mock("@/services/agents/engineer-large-diff-allowlist", () => ({
  isEngineerLargeDiffAllowlisted: async () => false,
}));
vi.mock("@/services/agents/log-decision-not-taken", () => ({
  logDecisionNotTaken: async () => undefined,
}));
vi.mock("@/services/agents/run-stop", () => ({ isRunStopRequested: async () => false }));

import {
  detectCarriedConstants,
  type FileDiffInput,
  type SandboxRunner,
} from "../helper-detection";
import { detectStaleCommittedDist } from "../stale-committed-dist";
import { runSandboxDetections } from "../sandbox-detections";
import { runCtoPostRun } from "../post-run";

const ROOT = "/home/user/repo";
const ROUND_TRIP_MS = 800;

const REPO: Record<string, string> = {
  "package.json": "{}",
  "packages/core/package.json": "{}",
  "packages/core/dist/index.js": "module.exports = {};\n",
  "apps/web/src/lib/copy-source.ts": 'export const HERO_SUFFIX = ", no text, no logos, no watermarks please";\n',
  "apps/web/src/lib/money.ts": "export function money(n: number) { return `$${n}`; }\n",
  "apps/web/src/lib/money.test.ts": "it('formats', () => {});\n",
};

function answer(cmd: string): { stdout: string; stderr: string; exit_code: number } {
  if (cmd.startsWith("for p in ")) {
    const asked = [...cmd.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const hits = asked.filter((p) => p.startsWith(ROOT + "/") && p.slice(ROOT.length + 1) in REPO);
    return { stdout: hits.map((h) => h + "\n").join(""), stderr: "", exit_code: 0 };
  }
  const head = cmd.match(/^head -c \d+ '([^']*)'$/);
  if (head) {
    const rel = head[1].slice(ROOT.length + 1);
    return rel in REPO
      ? { stdout: REPO[rel], stderr: "", exit_code: 0 }
      : { stdout: "", stderr: "No such file", exit_code: 1 };
  }
  if (cmd.includes("git log -1 --format=%ct")) {
    return { stdout: "1790000000", stderr: "", exit_code: 0 };
  }
  if (cmd.includes("git ls-files -- '*package.json'")) {
    const out = Object.keys(REPO).filter((p) => /(^|\/)package\.json$/.test(p));
    return { stdout: out.join("\n") + "\n", stderr: "", exit_code: 0 };
  }
  if (cmd.includes("git ls-files -- '*dist/*'")) {
    const out = Object.keys(REPO).filter((p) => /(^|\/)dist\//.test(p));
    return { stdout: out.join("\n") + "\n", stderr: "", exit_code: out.length ? 0 : 1 };
  }
  const grep = cmd.match(/grep -F -rl .* -- '((?:[^']|'\\'')*)' \.$/);
  if (grep) {
    const literal = grep[1].replace(/'\\''/g, "'");
    const hits = Object.entries(REPO)
      .filter(([, body]) => body.includes(literal))
      .map(([p]) => `./${p}`);
    return hits.length
      ? { stdout: hits.join("\n") + "\n", stderr: "", exit_code: 0 }
      : { stdout: "", stderr: "", exit_code: 1 };
  }
  return { stdout: "", stderr: "unexpected command", exit_code: 2 };
}

function fakeSandbox() {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const run: SandboxRunner = (cmd) => {
    calls.push(cmd);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) =>
      setTimeout(() => {
        inFlight -= 1;
        resolve(answer(cmd));
      }, ROUND_TRIP_MS),
    );
  };
  return { run, calls, maxInFlight: () => maxInFlight };
}

function firstBuildDiff(): FileDiffInput[] {
  const files: FileDiffInput[] = [];
  const libs = ["@/lib/leads", "@/lib/money", "@/lib/format"];
  for (let i = 0; i < 12; i++) {
    const literal =
      i === 5
        ? ", no text, no logos, no watermarks please"
        : `Section ${i} headline copy for the landing page`;
    files.push({
      path: `app/components/Section${i}.tsx`,
      action: "create",
      content:
        `import { h } from "${libs[i % 3]}";\n` +
        `const HEADLINE_${i} = "${literal}";\n` +
        `export default function Section${i}() { return HEADLINE_${i}; }\n`,
    });
  }
  files.push({
    path: "packages/core/src/index.ts",
    action: "modify",
    diff: "+export const core = 1;\n",
  });
  files.push({
    path: "apps/web/src/lib/admin/panel.ts",
    action: "modify",
    diff: '+import { money } from "@/lib/money";\n+export const p = money(1);\n',
  });
  return files;
}

async function timed<T>(p: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const pending = p();
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) await vi.advanceTimersByTimeAsync(ROUND_TRIP_MS / 4);
  return { value: await pending, ms: Date.now() - start };
}

describe("runSandboxDetections wall-clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(detectStaleCommittedDist).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("costs about the slowest detector, not the sum of both", async () => {
    const files = firstBuildDiff();
    const carriedAlone = await timed(() => detectCarriedConstants({ files, run: fakeSandbox().run }));
    const staleAlone = await timed(() => detectStaleCommittedDist({ files, run: fakeSandbox().run }));
    const serialMs = carriedAlone.ms + staleAlone.ms;
    const slowestMs = Math.max(carriedAlone.ms, staleAlone.ms);

    const sb = fakeSandbox();
    const both = await timed(() => runSandboxDetections({ files, run: sb.run }));

    expect(serialMs).toBeGreaterThanOrEqual(slowestMs + ROUND_TRIP_MS);
    expect(both.ms).toBeLessThanOrEqual(slowestMs + ROUND_TRIP_MS / 4);
    expect(sb.maxInFlight()).toBe(2);
  });

  it("returns exactly what each detector returns on its own (non-regression guard)", async () => {
    const files = firstBuildDiff();
    const carried = await timed(() => detectCarriedConstants({ files, run: fakeSandbox().run }));
    const stale = await timed(() => detectStaleCommittedDist({ files, run: fakeSandbox().run }));

    const both = await timed(() => runSandboxDetections({ files, run: fakeSandbox().run }));

    expect(both.value.carried).toEqual({ status: "fulfilled", value: carried.value });
    expect(both.value.stale).toEqual({ status: "fulfilled", value: stale.value });
    expect(carried.value.carried_constants).toEqual([
      { name: "HEADLINE_5", source_path: "apps/web/src/lib/copy-source.ts" },
    ]);
    expect(stale.value).toEqual([{ pkgRoot: "packages/core", srcFiles: ["packages/core/src/index.ts"] }]);
  });

  it("a detector that rejects early does not cancel or poison the other (non-regression guard)", async () => {
    vi.mocked(detectStaleCommittedDist).mockRejectedValueOnce(new Error("sandbox gone"));
    const files = firstBuildDiff();
    const sb = fakeSandbox();
    const both = await timed(() => runSandboxDetections({ files, run: sb.run, repo_root: ROOT }));

    expect(both.value.stale.status).toBe("rejected");
    expect((both.value.stale as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(both.value.carried.status).toBe("fulfilled");
    expect(
      (both.value.carried as PromiseFulfilledResult<{ carried_constants: unknown[] }>).value
        .carried_constants,
    ).toHaveLength(1);
    expect(sb.calls.filter((c) => c.includes("grep -F -rl"))).toHaveLength(12);
  });
});

describe("runCtoPostRun runs the sandbox checks at the same time", () => {
  const DETECTION_CMD = /^for p in |^head -c |git log -1 --format=%ct|git ls-files -- '|grep -F -rl /;
  const CARRIED = [{ name: "HEADLINE_5", source_path: "apps/web/src/lib/copy-source.ts" }];
  const STALE = [{ pkgRoot: "packages/core", srcFiles: ["packages/core/src/index.ts"] }];

  function postRunSandbox() {
    let inFlight = 0;
    const seen = { detectionCalls: 0, maxDetectionsInFlight: 0 };
    execSpy.mockImplementation(async (_sbx: string, cmd: string) => {
      if (!DETECTION_CMD.test(cmd)) return { stdout: "", stderr: "", exit_code: 0, ms: 0 };
      seen.detectionCalls += 1;
      inFlight += 1;
      seen.maxDetectionsInFlight = Math.max(seen.maxDetectionsInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ...answer(cmd), ms: 5 };
    });
    return seen;
  }

  const envelope = () => ({ repo: "acme/web", base_branch: "main", title: "Landing page", body: "Adds sections." });
  const payload = { repo_hint: "acme/web", task_description: "Build the landing page" };

  async function runToGate() {
    const emitProgress = vi.fn(async () => undefined);
    const ctx = {
      tenant_id: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
      agent: { slug: "engineer" },
      memory: { company: "" },
      emitProgress,
    } as never;
    const atGate: { envelope?: Record<string, unknown> } = {};
    gateSpy.mockImplementation((env: Record<string, unknown>) => {
      atGate.envelope = JSON.parse(JSON.stringify(env)) as Record<string, unknown>;
      throw new Error("stop after the detections");
    });
    await runCtoPostRun(ctx, envelope(), payload, []).catch(() => undefined);
    if (!atGate.envelope) throw new Error("post-run never reached the ship-gate");
    const codes = emitProgress.mock.calls
      .map((c) => (c as unknown[])[1] as { code?: string } | undefined)
      .map((meta) => meta?.code)
      .filter((code) => code === "carried_constant_found" || code === "stale_committed_dist");
    return { merged: atGate.envelope, codes };
  }

  beforeEach(() => {
    buildSpy.mockReset();
    gateSpy.mockReset();
    execSpy.mockReset();
    vi.mocked(detectStaleCommittedDist).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    buildSpy.mockResolvedValue({
      files: firstBuildDiff(),
      total_diff_bytes: 1,
      total_changed_lines: 1,
      total_post_image_bytes: 1,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stamps both results on the envelope the ship-gate reads, with both checks in flight at once", async () => {
    const seen = postRunSandbox();
    const { merged, codes } = await runToGate();

    expect(merged).not.toHaveProperty("referenced_helpers");
    expect(merged.carried_constants).toEqual(CARRIED);
    expect(merged.stale_committed_dist).toEqual(STALE);
    expect(codes).toEqual(["carried_constant_found", "stale_committed_dist"]);
    expect(seen.detectionCalls).toBeGreaterThanOrEqual(12 + 2);
    expect(seen.maxDetectionsInFlight).toBe(2);
  });

  it("a stale-dist check that rejects leaves the other stamp and only warns (non-regression guard)", async () => {
    postRunSandbox();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(detectStaleCommittedDist).mockRejectedValueOnce(new Error("sandbox gone"));
    const { merged, codes } = await runToGate();

    expect(merged).not.toHaveProperty("stale_committed_dist");
    expect(merged.carried_constants).toEqual(CARRIED);
    expect(codes).toEqual(["carried_constant_found"]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      "[engineer post-run] stale-committed-dist detection threw: sandbox gone",
    );
  });
});
