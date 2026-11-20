
import { beforeEach, describe, it, expect } from "vitest";
import {
  __resetEarlyProbeCache,
  applyEarlyProbeToPreview,
  probeEarlyPreviewCached,
  derivePreview,
  parseRepoFullName,
  probePreviewLiveness,
  realAppShipped,
  tenantAppIsLive,
} from "../autopilot";

const STAGES_BUILDING = [
  { stage: "provision", status: "done" },
  { stage: "spec", status: "done" },
  { stage: "scaffold", status: "done" },
  { stage: "build", status: "running" },
  { stage: "qa", status: "pending" },
] as const;

const STAGES_DONE = [
  { stage: "provision", status: "done" },
  { stage: "spec", status: "done" },
  { stage: "scaffold", status: "done" },
  { stage: "build", status: "done" },
  { stage: "qa", status: "done" },
] as const;

describe("derivePreview — truthful-liveness gate (no false-live)", () => {
  it("emits NO url while hosting is still 'provisioning', even if a url is on the row", () => {
    const p = derivePreview("provisioning", "https://app.onrender.com", STAGES_BUILDING, "active");
    expect(p).toEqual({ url: null, kind: "none" });
  });

  it("emits NO url while hosting is 'pending'", () => {
    const p = derivePreview("pending", "https://app.onrender.com", STAGES_BUILDING, "active");
    expect(p).toEqual({ url: null, kind: "none" });
  });

  it("emits NO url when 'ready' but the url is missing (URL re-fetch still in flight)", () => {
    const p = derivePreview("ready", null, STAGES_DONE, "completed");
    expect(p).toEqual({ url: null, kind: "none" });
  });

  it("emits NO url for a 'failed' hosting row", () => {
    const p = derivePreview("failed", "https://app.onrender.com", STAGES_BUILDING, "active");
    expect(p).toEqual({ url: null, kind: "none" });
  });
});

describe("derivePreview — early preview while build/qa still run", () => {
  it("surfaces an EARLY preview once the scaffold serves a 2xx (status ready) but build is still running", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_BUILDING, "active");
    expect(p).toEqual({ url: "https://app.onrender.com", kind: "early" });
  });

  it("treats a 'ready' row with qa still pending as an early preview", () => {
    const stages = [
      { stage: "provision", status: "done" },
      { stage: "spec", status: "done" },
      { stage: "scaffold", status: "done" },
      { stage: "build", status: "done" },
      { stage: "qa", status: "running" },
    ];
    const p = derivePreview("ready", "https://app.onrender.com", stages, "active");
    expect(p).toEqual({ url: "https://app.onrender.com", kind: "early" });
  });
});

describe("derivePreview — final preview once the pipeline completes", () => {
  it("is 'final' when scaffold serves AND build+qa are both done", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_DONE, "active");
    expect(p).toEqual({ url: "https://app.onrender.com", kind: "final" });
  });

  it("is 'final' when the run itself is terminal even if a stage row lags", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_BUILDING, "completed");
    expect(p).toEqual({ url: "https://app.onrender.com", kind: "final" });
  });
});

describe("derivePreview — instant sandbox preview (Lovable-parity, before Render)", () => {
  const SB_LIVE = { url: "https://3000-abc123.e2b.app", status: "live", port: 3000 };

  it("emits 'instant' from a live sandbox preview while Render is still provisioning", () => {
    const p = derivePreview("provisioning", null, STAGES_BUILDING, "active", SB_LIVE);
    expect(p).toEqual({ url: "https://3000-abc123.e2b.app", kind: "instant" });
  });

  it("emits 'instant' even when Render has no hosting row yet (null status)", () => {
    const p = derivePreview(null, null, STAGES_BUILDING, "active", SB_LIVE);
    expect(p).toEqual({ url: "https://3000-abc123.e2b.app", kind: "instant" });
  });

  it("while the build still runs, a live sandbox beats Render's early copy so hot reload stays visible", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_BUILDING, "active", SB_LIVE);
    expect(p).toEqual({ url: SB_LIVE.url, kind: "instant" });
  });

  it("while the build still runs with no live sandbox, Render's early copy still shows", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_BUILDING, "active", { ...SB_LIVE, status: "dead" });
    expect(p).toEqual({ url: "https://app.onrender.com", kind: "early" });
    expect(derivePreview("ready", "https://app.onrender.com", STAGES_BUILDING, "active", null)).toEqual({
      url: "https://app.onrender.com",
      kind: "early",
    });
  });

  it("a failed build never falls back to the sandbox once Render is ready", () => {
    expect(derivePreview("ready", "https://app.onrender.com", STAGES_BUILDING, "failed", SB_LIVE)).toEqual({ url: null, kind: "none" });
  });

  it("SWAP: Render 'ready' + pipeline done overrides a live sandbox preview → 'final'", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_DONE, "active", SB_LIVE);
    expect(p).toEqual({ url: "https://app.onrender.com", kind: "final" });
  });

  it("does NOT emit a 'starting' sandbox preview (not yet serving)", () => {
    const p = derivePreview(null, null, STAGES_BUILDING, "active", {
      url: "https://3000-abc123.e2b.app",
      status: "starting",
      port: 3000,
    });
    expect(p).toEqual({ url: null, kind: "none" });
  });

  it("does NOT emit a 'swapped'/'dead' sandbox preview even if a stale url lingers", () => {
    for (const status of ["swapped", "dead"]) {
      const p = derivePreview(null, null, STAGES_BUILDING, "active", {
        url: "https://3000-abc123.e2b.app",
        status,
        port: 3000,
      });
      expect(p).toEqual({ url: null, kind: "none" });
    }
  });

  it("does NOT emit a 'live' sandbox preview whose url is null", () => {
    const p = derivePreview(null, null, STAGES_BUILDING, "active", {
      url: null,
      status: "live",
      port: 3000,
    });
    expect(p).toEqual({ url: null, kind: "none" });
  });

  it("no sandbox + Render not ready → 'none' (unchanged back-compat)", () => {
    const p = derivePreview("provisioning", "https://app.onrender.com", STAGES_BUILDING, "active", null);
    expect(p).toEqual({ url: null, kind: "none" });
  });

  it("undefined sandboxPreview arg is byte-identical to the old 4-arg call", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_DONE, "active");
    expect(p).toEqual({ url: "https://app.onrender.com", kind: "final" });
  });
});

describe("probePreviewLiveness — read-time sandbox liveness re-probe", () => {
  const URL = "https://3000-abc123.e2b.app";

  it("returns true on a 2xx response (still serving)", async () => {
    const fetchFn = async () => ({ status: 200 });
    await expect(probePreviewLiveness(URL, fetchFn)).resolves.toBe(true);
  });

  it("returns true on a 204 (lower 2xx boundary)", async () => {
    const fetchFn = async () => ({ status: 204 });
    await expect(probePreviewLiveness(URL, fetchFn)).resolves.toBe(true);
  });

  it("returns false on a 4xx (e.g. 404 no-server FALSE-LIVE)", async () => {
    const fetchFn = async () => ({ status: 404 });
    await expect(probePreviewLiveness(URL, fetchFn)).resolves.toBe(false);
  });

  it("returns false on a 5xx (dev-server crashed)", async () => {
    const fetchFn = async () => ({ status: 502 });
    await expect(probePreviewLiveness(URL, fetchFn)).resolves.toBe(false);
  });

  it("returns false on a 3xx (not a 2xx — treat as not-live)", async () => {
    const fetchFn = async () => ({ status: 302 });
    await expect(probePreviewLiveness(URL, fetchFn)).resolves.toBe(false);
  });

  it("returns false when fetch throws (sandbox destroyed / network error)", async () => {
    const fetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(probePreviewLiveness(URL, fetchFn)).resolves.toBe(false);
  });

  it("returns false on an abort/timeout (never hangs, never throws)", async () => {
    const fetchFn = (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<{ status: number }>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    await expect(probePreviewLiveness(URL, fetchFn)).resolves.toBe(false);
  });
});

describe("applyEarlyProbeToPreview — an early URL that isn't serving is not emitted", () => {
  const RENDER = "https://build-a-responsive-quiz-d8f84c19.onrender.com";
  const SANDBOX = { url: "https://3000-abc.e2b.app", status: "live" };

  it("passes an early preview through untouched when the probe says it IS serving", () => {
    const p = applyEarlyProbeToPreview("ready", RENDER, STAGES_BUILDING, "active", null, false);
    expect(p).toEqual({ url: RENDER, kind: "early" });
  });

  it("emits 'none' instead of the dead URL when the probe fails and there is no sandbox", () => {
    const p = applyEarlyProbeToPreview("ready", RENDER, STAGES_BUILDING, "active", null, true);
    expect(p).toEqual({ url: null, kind: "none" });
  });

  it("falls back to a live sandbox preview rather than framing the 404", () => {
    const p = applyEarlyProbeToPreview("ready", RENDER, STAGES_BUILDING, "active", SANDBOX, true);
    expect(p).toEqual({ url: SANDBOX.url, kind: "instant" });
  });

  it("does not fall back to a sandbox that is itself not serving", () => {
    const dead = { url: "https://3000-abc.e2b.app", status: "dead" };
    const p = applyEarlyProbeToPreview("ready", RENDER, STAGES_BUILDING, "active", dead, true);
    expect(p).toEqual({ url: null, kind: "none" });
  });

  it("leaves a FINAL preview alone when the flag is false (the only way it's called)", () => {
    const p = applyEarlyProbeToPreview("ready", RENDER, STAGES_DONE, "done", null, false);
    expect(p).toEqual({ url: RENDER, kind: "final" });
  });

  it("is identical to derivePreview whenever the flag is false", () => {
    for (const stages of [STAGES_BUILDING, STAGES_DONE]) {
      for (const status of ["active", "done", "failed"]) {
        expect(applyEarlyProbeToPreview("ready", RENDER, stages, status, SANDBOX, false)).toEqual(
          derivePreview("ready", RENDER, stages, status, SANDBOX),
        );
      }
    }
  });
});

describe("probeEarlyPreviewCached — bounded probe cost under a 1.5s poll", () => {
  const URL = "https://acme-123.onrender.com";
  beforeEach(() => __resetEarlyProbeCache());

  it("probes once and reuses the result inside the TTL", async () => {
    let calls = 0;
    const probe = async () => {
      calls++;
      return true;
    };
    for (const t of [0, 1500, 3000, 4500, 4999]) {
      await expect(probeEarlyPreviewCached(URL, t, probe)).resolves.toBe(true);
    }
    expect(calls).toBe(1);
  });

  it("re-probes once the TTL lapses, so a redeploy coming up is picked up", async () => {
    const results = [false, true];
    let calls = 0;
    const probe = async () => results[calls++] ?? true;
    await expect(probeEarlyPreviewCached(URL, 0, probe)).resolves.toBe(false);
    await expect(probeEarlyPreviewCached(URL, 4999, probe)).resolves.toBe(false);
    await expect(probeEarlyPreviewCached(URL, 5000, probe)).resolves.toBe(true);
    expect(calls).toBe(2);
  });

  it("caches per URL — one tenant's dead preview can't mask another's live one", async () => {
    const probe = async (u: string) => u.includes("live");
    await expect(probeEarlyPreviewCached("https://dead.onrender.com", 0, probe)).resolves.toBe(
      false,
    );
    await expect(probeEarlyPreviewCached("https://live.onrender.com", 0, probe)).resolves.toBe(
      true,
    );
  });
});

const STAGES_SPEC_FAILED = [
  { stage: "provision", status: "done" },
  { stage: "spec", status: "failed" },
  { stage: "scaffold", status: "pending" },
  { stage: "build", status: "pending" },
  { stage: "qa", status: "pending" },
] as const;

describe("realAppShipped — truthful 'real app live' gate", () => {
  it("is true when build + qa are both 'done'", () => {
    expect(realAppShipped(STAGES_DONE)).toBe(true);
  });

  it("is true when build done + qa 'skipped' (pipeline with no qa node)", () => {
    expect(
      realAppShipped([
        { stage: "build", status: "done" },
        { stage: "qa", status: "skipped" },
      ]),
    ).toBe(true);
  });

  it("is true when the RUN is success-terminal even if stage rows lag reconcile", () => {
    expect(realAppShipped(STAGES_BUILDING, "done")).toBe(true);
    expect(realAppShipped(STAGES_BUILDING, "completed")).toBe(true);
    expect(realAppShipped(STAGES_BUILDING, "succeeded")).toBe(true);
  });

  it("is FALSE for a 'halted' run (cost-cap stop, not a success) with build not done", () => {
    expect(realAppShipped(STAGES_BUILDING, "halted")).toBe(false);
  });

  it("is FALSE for a spec-stage failure (the placeholder-on-fail bug: build never ran)", () => {
    expect(realAppShipped(STAGES_SPEC_FAILED)).toBe(false);
    expect(realAppShipped(STAGES_SPEC_FAILED, "failed")).toBe(false);
  });

  it("is FALSE while the build is still in flight (build running)", () => {
    expect(realAppShipped(STAGES_BUILDING, "active")).toBe(false);
  });

  it("is FALSE when build done but qa not yet cleared", () => {
    expect(
      realAppShipped([
        { stage: "build", status: "done" },
        { stage: "qa", status: "running" },
      ]),
    ).toBe(false);
  });

  it("is FALSE for a failed/cancelled run with build not done", () => {
    expect(realAppShipped(STAGES_BUILDING, "cancelled")).toBe(false);
    expect(realAppShipped(STAGES_BUILDING, "canceled")).toBe(false);
  });

  const STAGES_DEPLOY_PENDING = [
    { stage: "build", status: "done" },
    { stage: "qa", status: "done" },
    { stage: "deploy", status: "pending" },
  ] as const;
  const STAGES_DEPLOYED = [
    { stage: "build", status: "done" },
    { stage: "qa", status: "done" },
    { stage: "deploy", status: "done" },
  ] as const;

  it("is FALSE when build+qa done but the deploy node is still pending", () => {
    expect(realAppShipped(STAGES_DEPLOY_PENDING, "active")).toBe(false);
  });

  it("is FALSE when the deploy node failed", () => {
    expect(
      realAppShipped(
        [
          { stage: "build", status: "done" },
          { stage: "qa", status: "done" },
          { stage: "deploy", status: "failed" },
        ],
        "active",
      ),
    ).toBe(false);
  });

  it("is true once the deploy node is 'done'", () => {
    expect(realAppShipped(STAGES_DEPLOYED, "active")).toBe(true);
  });

  it("a success-terminal 'done' run overrides a still-pending deploy node", () => {
    expect(realAppShipped(STAGES_DEPLOY_PENDING, "done")).toBe(true);
  });

  it("is FALSE for a NON-build run (no build/deploy nodes) even at status 'done'", () => {
    expect(realAppShipped([{ stage: "goal", status: "done" }], "done")).toBe(false);
    expect(realAppShipped([], "done")).toBe(false);
  });
});

describe("derivePreview — placeholder-on-fail (no fake-live on a failed build)", () => {
  it("a FAILED run on a 'ready' placeholder emits NO url (was wrongly 'final')", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_SPEC_FAILED, "failed");
    expect(p).toEqual({ url: null, kind: "none" });
  });

  it("a CANCELLED run on a 'ready' placeholder emits NO url", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_SPEC_FAILED, "cancelled");
    expect(p).toEqual({ url: null, kind: "none" });
  });

  it("a HALTED run (cost-cap stop, build not shipped) emits NO url", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_BUILDING, "halted");
    expect(p).toEqual({ url: null, kind: "none" });
  });

  it("a success-terminal 'done' run is 'final' even if stage rows lag reconcile", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_BUILDING, "done");
    expect(p).toEqual({ url: "https://app.onrender.com", kind: "final" });
  });

  it("an in-flight run on a 'ready' scaffold is still EARLY (not suppressed)", () => {
    const p = derivePreview("ready", "https://app.onrender.com", STAGES_BUILDING, "active");
    expect(p).toEqual({ url: "https://app.onrender.com", kind: "early" });
  });

  it("a NON-build run (no build/deploy node) never surfaces the placeholder as a preview", () => {
    const p = derivePreview("ready", "https://app.onrender.com", [{ stage: "goal", status: "running" }], "active");
    expect(p).toEqual({ url: null, kind: "none" });
  });
});

const freshDone = { status: "done", goal_graph: [{ payload: { stage: "provision" } }] };
const freshActive = { status: "active", goal_graph: [{ payload: { stage: "build" } }] };
const freshFailed = { status: "failed", goal_graph: [{ payload: { stage: "spec" } }] };
const refineActive = { status: "active", goal_graph: [{ payload: { refine_mode: true, stage: "refine" } }] };
const refineDone = { status: "done", goal_graph: [{ payload: { refine_mode: true } }] };

describe("tenantAppIsLive — is the tenant's app CURRENTLY live (vs placeholder)", () => {
  it("empty / null → not live", () => {
    expect(tenantAppIsLive(null)).toBe(false);
    expect(tenantAppIsLive(undefined)).toBe(false);
    expect(tenantAppIsLive([])).toBe(false);
  });

  it("latest fresh build DONE → live", () => {
    expect(tenantAppIsLive([freshDone])).toBe(true);
  });

  it("in-flight fresh REBUILD on top of a prior done build → NOT live (re-seeded placeholder)", () => {
    expect(tenantAppIsLive([freshActive, freshDone])).toBe(false);
  });

  it("FAILED fresh rebuild on top of a prior done build → NOT live (placeholder re-seeded at enqueue)", () => {
    expect(tenantAppIsLive([freshFailed, freshDone])).toBe(false);
  });

  it("refine on top of a DONE fresh build → live (refine edits the real app in place)", () => {
    expect(tenantAppIsLive([refineActive, freshDone])).toBe(true);
    expect(tenantAppIsLive([refineDone, freshDone])).toBe(true);
  });

  it("CODEX CASE: refine on top of a FAILED fresh rebuild → NOT live (refine edits the placeholder)", () => {
    expect(tenantAppIsLive([refineActive, freshFailed, freshDone])).toBe(false);
    expect(tenantAppIsLive([refineDone, freshFailed, freshDone])).toBe(false);
  });

  it("skips a refine streak to find the latest fresh build", () => {
    expect(tenantAppIsLive([refineDone, refineDone, refineActive, freshDone])).toBe(true);
  });

  it("only refines in the window (no fresh build found) → not live (conservative)", () => {
    expect(tenantAppIsLive([refineActive, refineDone])).toBe(false);
  });

  it("tolerates a missing/empty goal_graph (treats as fresh, gates on status)", () => {
    expect(tenantAppIsLive([{ status: "done", goal_graph: null }])).toBe(true);
    expect(tenantAppIsLive([{ status: "active", goal_graph: [] }])).toBe(false);
  });
});

describe("parseRepoFullName", () => {
  it("parses owner/repo from an https github url", () => {
    expect(parseRepoFullName("https://github.com/praxis-built/acme")).toBe("praxis-built/acme");
  });
  it("strips a trailing .git", () => {
    expect(parseRepoFullName("https://github.com/praxis-built/acme.git")).toBe("praxis-built/acme");
  });
  it("strips a trailing slash", () => {
    expect(parseRepoFullName("https://github.com/praxis-built/acme/")).toBe("praxis-built/acme");
  });
  it("handles an scp-style git@ url", () => {
    expect(parseRepoFullName("git@github.com:praxis-built/acme.git")).toBe("praxis-built/acme");
  });
  it("returns null for null / non-github / malformed", () => {
    expect(parseRepoFullName(null)).toBeNull();
    expect(parseRepoFullName("https://gitlab.com/x/y")).toBeNull();
    expect(parseRepoFullName("not a url")).toBeNull();
  });
});
