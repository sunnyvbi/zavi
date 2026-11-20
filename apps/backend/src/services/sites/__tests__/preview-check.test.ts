import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { runPreviewCheck, PREVIEW_CHECK_FLAG, type PreviewCheckDeps, type PreviewCheckRun } from "../preview-check";
import { runPreviewScan } from "../site-gate";
import { GATE_CONFIG_PATH, GATE_RUNNER_PATH, type GateRunnerExec } from "../gate-runner/sandbox-runner";
import { GATE_RUNNER_SOURCE } from "../gate-runner/runner-source.generated";
import type { GateRunnerConfig } from "../gate-runner/config";
import { fakeLaunch, type FakeSite } from "../gate-runner/__tests__/fake-browser";
import type { SiteVisionReview } from "../site-vision-review";

const req = createRequire(__filename);
const runner = req("../gate-runner/runner.cjs") as {
  runGate: (o: { baseUrl: string; config: GateRunnerConfig; launch: () => Promise<unknown> }) => Promise<Record<string, unknown> & { ok: boolean }>;
};

const TENANT = "11111111-1111-4111-8111-111111111111";
const SITE = "22222222-2222-4222-8222-222222222222";
const BUILD_RUN = "33333333-3333-4333-8333-333333333333";
const FIX_RUN = "44444444-4444-4444-8444-444444444444";
const ORIGIN = "https://5173-sbxpreview01.e2b.app";
const ON = { [PREVIEW_CHECK_FLAG]: "1" } as NodeJS.ProcessEnv;

const buildGraph = [
  { payload: { stage: "provision", site_id: SITE } },
  { payload: { stage: "build", site_id: SITE, fast_single_pass: true } },
];
const refineGraph = [{ payload: { stage: "build", site_id: SITE, refine_mode: true } }];

type Harness = {
  site: FakeSite;
  configs: GateRunnerConfig[];
  scans: number;
  fixMessages: string[];
  clock: number;
  deps: Partial<PreviewCheckDeps>;
  fixStatuses: string[];
};

function harness(
  routes: FakeSite["routes"],
  opts: { onFix?: (h: Harness) => void; env?: NodeJS.ProcessEnv; probe?: (n: number) => boolean; visionReview?: SiteVisionReview; visionMode?: string } = {},
): Harness {
  const h = {} as Harness;
  h.site = { origin: ORIGIN, routes };
  h.configs = [];
  h.scans = 0;
  h.fixMessages = [];
  h.clock = 0;
  h.fixStatuses = ["active", "active", "done"];
  const env = opts.env ?? ON;
  const exec: GateRunnerExec = async (input) => {
    expect(input.files[GATE_RUNNER_PATH]).toBe(GATE_RUNNER_SOURCE);
    expect(input.env).toEqual({ GATE_BASE_URL: `${ORIGIN}/` });
    const config = JSON.parse(input.files[GATE_CONFIG_PATH]) as GateRunnerConfig;
    h.configs.push(config);
    const out = await runner.runGate({ baseUrl: input.env.GATE_BASE_URL, config, launch: fakeLaunch(h.site).launch });
    return { exitCode: out.ok ? 0 : 1, stdout: `${JSON.stringify(out)}\n`, stderr: "" };
  };
  let probes = 0;
  h.deps = {
    env,
    claimOnce: vi.fn(async () => true),
    loadRun: vi.fn(async (_t: string, id: string): Promise<PreviewCheckRun | null> => {
      if (id === BUILD_RUN) return { goal_graph: buildGraph, status: "done" };
      if (id === FIX_RUN) return { goal_graph: refineGraph, status: h.fixStatuses.shift() ?? "done" };
      return null;
    }),
    loadSite: vi.fn(async () => ({ previewUrl: `${ORIGIN}/`, siteName: "Bloom Bakery" })),
    probe: vi.fn(async () => (opts.probe ? opts.probe(probes++) : true)),
    scan: vi.fn(async (input) => {
      h.scans++;
      return runPreviewScan(input, {
        runner: exec,
        env,
        visionMode: async () => opts.visionMode ?? "observe",
        ...(opts.visionReview ? { visionReview: opts.visionReview as never } : {}),
      });
    }),
    startFixPass: vi.fn(async ({ message }: { message: string }) => {
      h.fixMessages.push(message);
      opts.onFix?.(h);
      return { runId: FIX_RUN };
    }),
    sleep: vi.fn(async (ms: number) => {
      h.clock += ms;
    }),
    now: () => h.clock,
    readyTimeoutMs: 60_000,
    readyPollMs: 5_000,
    fixTimeoutMs: 600_000,
    fixPollMs: 10_000,
  };
  return h;
}

let warn: { mockRestore: () => void };
let logs: string[];
beforeEach(() => {
  logs = [];
  warn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
});
afterEach(() => warn.mockRestore());

const previewLogs = () => logs.filter((l) => l.startsWith("[preview-check]"));

const bakery = (home: string, extra: FakeSite["routes"] = {}): FakeSite["routes"] => ({
  "/": { status: 200, text: home, links: ["/menu", "https://instagram.com/bloom", "/__zavi-x"] },
  "/menu": { status: 200, text: "Our menu\nSourdough" },
  ...extra,
});

describe("runPreviewCheck", () => {
  it("error text on the preview starts exactly one fix pass, waits for it, then re-scans and reports fixed", async () => {
    const h = harness(bakery("Bloom Bakery\nSomething went wrong. Please try again."), {
      onFix: (x) => {
        x.site.routes["/"] = { ...x.site.routes["/"], text: "Bloom Bakery\nFresh bread every morning" };
      },
    });
    const out = await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps);
    expect(out).toEqual({ status: "fixed", fix_run_id: FIX_RUN });
    expect(h.deps.startFixPass).toHaveBeenCalledTimes(1);
    expect(h.deps.startFixPass).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, runId: BUILD_RUN, siteId: SITE }));
    expect(h.fixMessages[0]).toContain('visible error text on /: "Something went wrong. Please try again."');
    expect(h.scans).toBe(2);
    expect(h.deps.loadRun).toHaveBeenCalledWith(TENANT, FIX_RUN);
    expect(h.clock).toBeGreaterThanOrEqual(20_000);
    expect(h.configs.every((c) => c.scan_only === true && c.read_only === true && c.allow_writes === false && c.journeys.length === 0)).toBe(true);
    const events = previewLogs().map((l) => /event=(\S+)/.exec(l)?.[1]);
    expect(events).toEqual(["errors", "fix_started", "fixed"]);
    expect(previewLogs()[0]).toContain(`tenant=${TENANT} site=${SITE} run=${BUILD_RUN}`);
  });

  it("a clean preview starts no fix pass and scans the routes the home page links to", async () => {
    const h = harness(bakery("Bloom Bakery\nFresh bread every morning"));
    const out = await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps);
    expect(out).toEqual({ status: "clean" });
    expect(h.deps.startFixPass).not.toHaveBeenCalled();
    expect(h.scans).toBe(1);
    expect(previewLogs()).toEqual([expect.stringContaining("event=clean")]);
    expect(previewLogs()[0]).toContain("routes=2");
  });

  it("an error only on a linked page is still found", async () => {
    const h = harness(bakery("Bloom Bakery\nFresh bread", { "/menu": { status: 200, text: "Our menu\nFailed to load the menu" } }), {
      onFix: () => undefined,
    });
    const out = await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps);
    expect(out).toMatchObject({ status: "still_erroring" });
    expect(h.fixMessages[0]).toContain("/menu");
  });

  it("still erroring after the fix pass is logged and never starts a second pass", async () => {
    const h = harness(bakery("Bloom Bakery\nThis can't be saved right now. Please contact us"));
    const out = await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps);
    expect(out).toMatchObject({ status: "still_erroring", fix_run_id: FIX_RUN });
    expect(h.deps.startFixPass).toHaveBeenCalledTimes(1);
    expect(h.scans).toBe(2);
    expect(previewLogs().at(-1)).toMatch(/event=still_erroring .*fix_run=4444/);
  });

  it("the fix pass's own completion never checks again (it is an edit run), so the check cannot loop", async () => {
    const h = harness(bakery("Bloom Bakery\nSomething went wrong"));
    const out = await runPreviewCheck({ tenantId: TENANT, runId: FIX_RUN }, h.deps);
    expect(out).toEqual({ status: "skipped", reason: "edit_run" });
    expect(h.deps.claimOnce).not.toHaveBeenCalled();
    expect(h.scans).toBe(0);
    expect(h.deps.startFixPass).not.toHaveBeenCalled();
  });

  it("a second call for the same build is refused by the once-claim", async () => {
    const h = harness(bakery("Bloom Bakery\nSomething went wrong"));
    h.deps.claimOnce = vi.fn(async () => false);
    const out = await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps);
    expect(out).toEqual({ status: "skipped", reason: "already_checked" });
    expect(h.scans).toBe(0);
  });

  it("a build that publishes itself is left to the publish gate", async () => {
    const h = harness(bakery("Bloom Bakery\nSomething went wrong"));
    h.deps.loadRun = vi.fn(async () => ({ goal_graph: [...buildGraph, { payload: { stage: "deploy", site_id: SITE } }], status: "done" }));
    expect(await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps)).toEqual({ status: "skipped", reason: "publishes_itself" });
    expect(h.scans).toBe(0);
  });

  it("flag off: nothing runs, not even the once-claim or a run read", async () => {
    const h = harness(bakery("Bloom Bakery\nSomething went wrong"), { env: {} as NodeJS.ProcessEnv });
    for (const value of [undefined, "0", "true", ""]) {
      const env = value === undefined ? ({} as NodeJS.ProcessEnv) : ({ [PREVIEW_CHECK_FLAG]: value } as NodeJS.ProcessEnv);
      expect(await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, { ...h.deps, env })).toEqual({ status: "disabled" });
    }
    for (const fn of [h.deps.claimOnce, h.deps.loadRun, h.deps.loadSite, h.deps.probe, h.deps.scan, h.deps.startFixPass, h.deps.sleep]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(previewLogs()).toEqual([]);
  });

  it("a failed Google Fonts or other third-party request is not an error, but a missing file on the preview's own origin is", async () => {
    const fonts = [
      { url: "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" },
      { url: "https://fonts.gstatic.com/s/inter/v13/abc.woff2", text: "Failed to load resource: net::ERR_INTERNET_DISCONNECTED" },
      { url: "https://images.unsplash.com/photo-1509440159596.jpg", text: "Failed to load resource: the server responded with a status of 404 ()" },
    ];
    const h = harness({ "/": { status: 200, text: "Bloom Bakery\nFresh bread", resourceErrors: fonts } });
    expect(await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps)).toEqual({ status: "clean" });
    expect(h.deps.startFixPass).not.toHaveBeenCalled();

    logs.length = 0;
    const own = harness({ "/": { status: 200, text: "Bloom Bakery\nFresh bread", resourceErrors: [...fonts, { url: `${ORIGIN}/src/assets/hero.png` }] } });
    const out = await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, own.deps);
    expect(out).toMatchObject({ status: "still_erroring", reason: "a file failed to load (/src/assets/hero.png) on /" });
  });

  it("a Vite build-error overlay counts as an error even though the page text looks fine", async () => {
    const h = harness({ "/": { status: 200, text: "Bloom Bakery", overlay: true } });
    const out = await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps);
    expect(out).toMatchObject({ status: "still_erroring", reason: "the preview shows a build error on /" });
  });

  it("a preview still compiling is waited on, then scanned once it serves", async () => {
    const h = harness(bakery("Bloom Bakery\nFresh bread"), { probe: (n) => n >= 3 });
    const out = await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps);
    expect(out).toEqual({ status: "clean" });
    expect(h.deps.probe).toHaveBeenCalledTimes(4);
    expect(h.deps.probe).toHaveBeenCalledWith(ORIGIN);
    expect(h.deps.sleep).toHaveBeenCalledTimes(3);
    expect(h.scans).toBe(1);
    expect(previewLogs()[0]).toMatch(/event=ready .*waited_ms=15000/);
  });

  it("a preview that never finishes compiling is skipped at the timeout and never scanned", async () => {
    const h = harness(bakery("Bloom Bakery\nSomething went wrong"), { probe: () => false });
    const out = await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps);
    expect(out).toEqual({ status: "skipped", reason: "still_compiling" });
    expect(h.scans).toBe(0);
    expect(h.deps.startFixPass).not.toHaveBeenCalled();
    expect(h.clock).toBe(60_000);
    expect(previewLogs().map((l) => /event=(\S+)/.exec(l)?.[1])).toEqual(["not_ready", "skipped"]);
    expect(previewLogs()[1]).toContain("reason=still_compiling");
  });

  it("a fix pass that cannot start (no credits, another edit running) is logged and the check stops", async () => {
    const h = harness(bakery("Bloom Bakery\nSomething went wrong"));
    h.deps.startFixPass = vi.fn(async () => {
      const e = new Error("You've used your 2 free edits.");
      e.name = "FreeEditsUsed";
      throw e;
    });
    const out = await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps);
    expect(out).toEqual({ status: "fix_not_started", reason: "FreeEditsUsed: You've used your 2 free edits." });
    expect(h.scans).toBe(1);
    expect(previewLogs().at(-1)).toContain("event=fix_not_started");
  });

  it("a fix pass that fails or never ends is logged and not re-scanned", async () => {
    const failed = harness(bakery("Bloom Bakery\nSomething went wrong"));
    failed.fixStatuses = ["active", "failed"];
    expect(await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, failed.deps)).toEqual({ status: "fix_failed", reason: "run_failed" });
    expect(failed.scans).toBe(1);

    const stuck = harness(bakery("Bloom Bakery\nSomething went wrong"));
    stuck.fixStatuses = Array(1000).fill("active");
    expect(await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, stuck.deps)).toEqual({ status: "fix_failed", reason: "timed_out" });
    expect(stuck.scans).toBe(1);
    expect(stuck.clock).toBe(600_000);
  });

  it("a runner that cannot start never starts a fix pass", async () => {
    const h = harness(bakery("Bloom Bakery\nSomething went wrong"));
    h.deps.scan = vi.fn((input) => runPreviewScan(input, { runner: async () => { throw new Error("e2b: sandbox quota"); }, env: ON }));
    const out = await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps);
    expect(out).toMatchObject({ status: "unscannable" });
    expect(h.deps.startFixPass).not.toHaveBeenCalled();
  });

  it("never throws into the caller, even when a dependency does", async () => {
    const h = harness(bakery("Bloom Bakery"));
    h.deps.loadRun = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps)).resolves.toEqual({ status: "skipped", reason: "error" });
    expect(previewLogs()[0]).toContain('event=error tenant=');
  });

  it("vision review runs only when its own flag is on, and never changes the outcome", async () => {
    const review = vi.fn(async (_input: unknown) => ({ ok: false, issues: ["Screenshot 1: looks unfinished"] }));
    const off = harness(bakery("Bloom Bakery\nFresh bread"), { visionReview: review });
    expect(await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, off.deps)).toEqual({ status: "clean" });
    expect(review).not.toHaveBeenCalled();
    expect(off.configs[0].screenshots).toBeUndefined();

    const on = harness(bakery("Bloom Bakery\nFresh bread"), { visionReview: review, env: { ...ON, SITE_GATE_VISION_REVIEW: "1" } as NodeJS.ProcessEnv });
    expect(await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, on.deps)).toEqual({ status: "clean" });
    expect(review).toHaveBeenCalledTimes(1);
    const sent = review.mock.calls[0][0] as unknown as { expected_name: string; screenshots: Array<{ path: string }> };
    expect(sent.expected_name).toBe("Bloom Bakery");
    expect(sent.screenshots.map((s) => s.path)).toEqual(["/", "/menu"]);
  });

  it("the tenant's review mode off: no screenshots and no model call, even with the env flag on", async () => {
    const review = vi.fn(async (_input: unknown) => ({ ok: true, issues: [] }));
    const h = harness(bakery("Bloom Bakery\nFresh bread"), { visionReview: review, env: { ...ON, SITE_GATE_VISION_REVIEW: "1" } as NodeJS.ProcessEnv, visionMode: "off" });
    expect(await runPreviewCheck({ tenantId: TENANT, runId: BUILD_RUN }, h.deps)).toEqual({ status: "clean" });
    expect(review).not.toHaveBeenCalled();
    expect(h.configs[0]!.screenshots).toBeUndefined();
  });
});

describe("scan-only runner mode", () => {
  const scan = (routes: FakeSite["routes"]) => {
    const fb = fakeLaunch({ origin: ORIGIN, routes });
    const config: GateRunnerConfig = {
      version: 1, starter: "dedicated", routes: ["/"], journeys: [], allow_writes: false, write: null,
      protected_lists: [], tag: "zavi-smoke-0123456789abcdef", read_only: true, scan_only: true,
    };
    return { fb, run: () => runner.runGate({ baseUrl: `${ORIGIN}/`, config, launch: fb.launch }) };
  };

  it("runs only the scan and the error-text check: no mobile, brand, manifest, owner or write journeys", async () => {
    const { run } = scan(bakery("Bloom Bakery"));
    const out = await run();
    expect((out.journeys as Array<{ name: string }>).map((j) => j.name)).toEqual(["zavi:scan", "zavi:error-text"]);
    expect(out.scanned_routes).toEqual(["/", "/menu"]);
    expect(out.ok).toBe(true);
  });

  it("keeps the dev server's own hot-reload socket open but closes every other socket and still answers writes 403", async () => {
    const { fb, run } = scan(bakery("Bloom Bakery"));
    await run();
    const ws = fb.calls.wsRoutes[0];
    const outcome = async (url: string) => {
      let did = "";
      await ws.handle({ url: () => url, connectToServer: () => (did = "open"), close: async () => (did = "closed") });
      return did;
    };
    expect(await outcome("wss://5173-sbxpreview01.e2b.app/?token=abc")).toBe("open");
    expect(await outcome("wss://realtime.supabase.co/socket")).toBe("closed");
    expect(await outcome("wss://5173-sbxpreview01.e2b.app.evil.example/")).toBe("closed");
    let fulfilled: unknown = null;
    await fb.calls.routes[0].handle({
      request: () => ({ method: () => "POST", url: () => `${ORIGIN}/api/x`, postData: () => "{}", headers: () => ({}) }),
      continue: async () => undefined,
      fulfill: async (o: unknown) => (fulfilled = o),
    });
    expect(fulfilled).toMatchObject({ status: 403 });
  });

  it("the full publish gate still closes every socket, its own origin included", async () => {
    const fb = fakeLaunch({ origin: ORIGIN, routes: bakery("Bloom Bakery") });
    const config: GateRunnerConfig = {
      version: 1, starter: "dedicated", routes: ["/"], journeys: [{ name: "home", path: "/" }], allow_writes: false, write: null,
      protected_lists: [], tag: "zavi-smoke-0123456789abcdef", read_only: true,
    };
    await runner.runGate({ baseUrl: `${ORIGIN}/`, config, launch: fb.launch });
    let did = "";
    await fb.calls.wsRoutes[0].handle({ url: () => `wss://5173-sbxpreview01.e2b.app/`, connectToServer: () => (did = "open"), close: async () => (did = "closed") });
    expect(did).toBe("closed");
  });
});
