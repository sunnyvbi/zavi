import { describe, expect, it, vi } from "vitest";
import { conductorTick, type ConductorNode, type ConductorRow, type ConductorTickDeps, type SiteDeployDeps, type SiteDeployStepOutcome } from "../conductor";
import { SITE_VISION_CHECKPOINT_KEY, VISION_FIX_MARK, type SiteVisionFinding } from "@/services/sites/site-vision-review";
import { createSiteDeployHandler, type SiteDeployDeps as HandlerDeps } from "@/services/sites/site-deploy";
import { nodePayloadCheckpoints, runWithNodeCheckpoints } from "@/services/sites/deploy-checkpoints";
import type { SiteGateResult, SiteRow, SiteSandbox, StagedDeploy } from "@/services/sites/contract";
import type { SiteGateInput } from "@/services/sites/site-gate";
import { fakeGenerations, fakeSiteStore, siteRow, T1 } from "@/services/sites/__tests__/fake-site-store";
import { isVisionFixPayload } from "../fast-build-prompt";
import { APP_SETTINGS } from "@/services/settings/registry";

const SITE = "site-a";
const KEY_A1 = "repair:site:d:e0:a1";

function nodes(site_id = SITE): ConductorNode[] {
  return [
    { id: "p", status: "done", target_agent_slug: "__provision_gate__", payload: { stage: "provision", site_id }, estimate_usd: 0.1, child_run_id: null },
    {
      id: "b",
      status: "done",
      target_agent_slug: "engineer",
      payload: { stage: "build", fast_single_pass: true, site_id, idea: "a booking site", target: { github_full_name: "praxis-built/shop-aaa111" } },
      estimate_usd: 3,
      child_run_id: "child-build",
    },
    { id: "d", status: "pending", target_agent_slug: "__deploy_gate__", payload: { stage: "deploy", site_id, seed_sha: "seed" }, estimate_usd: 0, child_run_id: null },
  ];
}

type StepInput = Parameters<SiteDeployDeps["step"]>[0];

type VisionClaim = Awaited<ReturnType<NonNullable<SiteDeployDeps["claimVisionFix"]>>>;
const VISION_TOKEN = "11111111-2222-4333-8444-555555555555";

function harness(opts: {
  maxRepairs?: number | Error;
  step?: (i: StepInput) => Promise<SiteDeployStepOutcome>;
  outcomes?: SiteDeployStepOutcome[];
  site_id?: string;
  head?: string;
  noDispatch?: boolean;
  visionClaim?: VisionClaim | Error | null;
  dispatchFails?: boolean;
  republish?: boolean;
}) {
  let graph = nodes(opts.site_id).filter((n) => !opts.republish || n.id === "d");
  const outcomes = [...(opts.outcomes ?? [])];
  const stepCalls: StepInput[] = [];
  const charges: Array<{ estimate: number; key: string }> = [];
  const dispatchRepair = vi.fn(async (i: { attempt: number; payload: Record<string, unknown> }) =>
    opts.dispatchFails ? ({ ok: false as const, reason: "boom" }) : ({ ok: true as const, child_run_id: `fix-${i.attempt}` }),
  );
  const claimVisionFix = vi.fn(async (): Promise<VisionClaim> => {
    const c = opts.visionClaim === undefined ? ({ status: "claimed", token: VISION_TOKEN } as const) : opts.visionClaim;
    if (c instanceof Error) throw c;
    return c!;
  });
  const releaseVisionFix = vi.fn(async () => undefined);
  const site: SiteDeployDeps = {
    step: vi.fn(async (i: StepInput): Promise<SiteDeployStepOutcome> => {
      stepCalls.push(JSON.parse(JSON.stringify({ ...i, checkpoint: undefined })));
      if (opts.step) return opts.step(i);
      return outcomes.shift() ?? { kind: "waiting" };
    }),
    headSha: vi.fn(async () => opts.head ?? "head1"),
    markDesired: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    repairMaxAttempts: vi.fn(async () => {
      if (opts.maxRepairs instanceof Error) throw opts.maxRepairs;
      return opts.maxRepairs ?? 1;
    }),
    ...(opts.visionClaim === null ? {} : { claimVisionFix, releaseVisionFix }),
  };
  const statuses: string[] = [];
  const deps: ConductorTickDeps = {
    load: async (): Promise<ConductorRow> => ({ id: "cond-1", tenant_id: T1, objective: "build", status: "active", max_usd: 100, spend_usd: 0, kind: "build_app", goal_graph: graph }),
    childStatus: async () => "success",
    consumeBudget: vi.fn(async () => "charged" as const),
    consumeBudgetOnce: vi.fn(async (_run: string, estimate: number, key: string) => {
      charges.push({ estimate, key });
      return "charged" as const;
    }),
    refundBudgetOnce: vi.fn(async () => undefined),
    dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "x" })),
    ...(opts.noDispatch ? {} : { dispatchRepair: dispatchRepair as unknown as ConductorTickDeps["dispatchRepair"] }),
    saveGraph: async (_id, g) => {
      graph = JSON.parse(JSON.stringify(g));
    },
    setStatus: async (_id, s) => {
      statuses.push(s);
    },
    hostingStatus: vi.fn(async () => "ready" as const),
    staticPublish: { plan: vi.fn(), request: vi.fn(), rollback: vi.fn() },
    siteDeploy: site,
  };
  return { deps, site, stepCalls, charges, dispatchRepair, claimVisionFix, releaseVisionFix, statuses, node: (id: string) => graph.find((n) => n.id === id)! };
}

const visualRepair: SiteDeployStepOutcome = {
  kind: "repair",
  signal: "The site works, but a screenshot review found visible problems",
  journeys: { names: ["home"], must_pass: [VISION_FIX_MARK], fingerprints: { home: "h1" } },
};

describe("conductor: the visual fix rides the existing site repair path", () => {
  it("is free (Zavi pays): claimed for this run, dispatched with its token, nothing charged to the budget", async () => {
    const visual = harness({ outcomes: [visualRepair] });
    const functional = harness({ outcomes: [{ kind: "repair", signal: "journey book failed" }] });
    expect(await conductorTick("cond-1", visual.deps)).toMatchObject({ action: "site_repair_dispatched", attempt: 1 });
    await conductorTick("cond-1", functional.deps);
    expect(visual.claimVisionFix).toHaveBeenCalledWith({ tenant_id: T1, site_id: SITE, conductor_run_id: "cond-1", attempt: 1 });
    expect(visual.charges).toEqual([]);
    expect(functional.charges).toEqual([{ estimate: 3, key: KEY_A1 }]);
    expect(functional.claimVisionFix).not.toHaveBeenCalled();
    expect(visual.deps.consumeBudget).not.toHaveBeenCalled();
    expect(visual.dispatchRepair).toHaveBeenCalledTimes(1);
    const payload = (visual.dispatchRepair.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({ repair_mode: true, repair_attempt: 1, failure_signal: visualRepair.signal, vision_fix: true, vision_fix_token: VISION_TOKEN, site_id: SITE });
    expect(payload).not.toHaveProperty("brief_journey_fix");
    const fnPayload = (functional.dispatchRepair.mock.calls[0]![0] as { payload: Record<string, unknown> }).payload;
    expect(fnPayload).not.toHaveProperty("vision_fix_token");
    expect(visual.node("d")).toMatchObject({ site_repair_attempts: 1, last_charge_key: KEY_A1, last_charge_usd: 0 });
    expect(visual.node("d").payload.site_vision_fix_used).toBe(true);
    expect(functional.node("d").payload.site_vision_fix_used).toBeUndefined();
  });

  it("the next gate is told the visual fix was used, with every journey kept", async () => {
    const h = harness({ maxRepairs: 3, outcomes: [visualRepair, { kind: "waiting" }] });
    await conductorTick("cond-1", h.deps);
    await conductorTick("cond-1", h.deps);
    await conductorTick("cond-1", h.deps);
    expect(h.stepCalls.map((c) => c.attempt).slice(0, 2)).toEqual([1, 2]);
    expect(h.stepCalls[1]!.kept_journeys).toEqual({ names: ["home"], must_pass: [VISION_FIX_MARK], fingerprints: { home: "h1" } });
  });

  it("the step's visual fix is a fact: the conductor dispatches it without re-reading the budget or applying its own fallback", async () => {
    for (const maxRepairs of [0, new Error("settings down")]) {
      const h = harness({ maxRepairs, outcomes: [visualRepair] });
      expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "site_repair_dispatched", attempt: 1 });
      expect(h.site.repairMaxAttempts).not.toHaveBeenCalled();
      expect(h.charges).toEqual([]);
    }
  });

  it("no way to dispatch: nothing charged, the node never fails, the record says declined, and the next step keeps the same attempt and checkpoint", async () => {
    const h = harness({
      noDispatch: true,
      step: async (i) => {
        if (i.kept_journeys?.must_pass.includes(VISION_FIX_MARK)) return { kind: "waiting" };
        i.checkpoint[SITE_VISION_CHECKPOINT_KEY] = { status: "reviewed", action: "repair" };
        i.checkpoint["k1"] = { phase: "gated", sha: "head1" };
        return visualRepair;
      },
    });
    const r = await conductorTick("cond-1", h.deps);
    expect(r).toEqual({ action: "waiting", in_flight: 0 });
    expect(h.charges).toEqual([]);
    expect(h.node("d").status).toBe("pending");
    expect(h.node("d").payload.site_vision_fix_used).toBe(true);
    expect(h.node("d").payload.site_vision).toEqual({ status: "reviewed", action: "declined" });
    expect(h.node("d").payload.site_checkpoint).toEqual({ k1: { phase: "gated", sha: "head1" } });
    await conductorTick("cond-1", h.deps);
    expect(h.stepCalls[1]!.attempt).toBe(1);
    expect(h.stepCalls[1]!.kept_journeys).toEqual({ names: [], must_pass: [VISION_FIX_MARK], fingerprints: {} });
  });

  it("fix passes that kept dying before any work: the visual fix is declined and the gated commit publishes, never a platform failure", async () => {
    const h = harness({
      maxRepairs: 3,
      step: async (i) => {
        if (i.kept_journeys?.must_pass.includes(VISION_FIX_MARK)) return { kind: "waiting" };
        i.checkpoint[SITE_VISION_CHECKPOINT_KEY] = { status: "reviewed", action: "repair" };
        return visualRepair;
      },
    });
    Object.assign(h.node("d").payload, { site_repair_no_work: 2, site_repair_no_work_epoch: { e: 0, n: 2 } });
    h.node("d").site_repair_attempts = 2;
    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 0 });
    expect(h.dispatchRepair).not.toHaveBeenCalled();
    expect(h.charges).toEqual([]);
    expect(h.node("d").status).toBe("pending");
    expect(h.node("d").payload.site_vision).toEqual({ status: "reviewed", action: "declined" });
    expect(h.statuses).not.toContain("failed");
  });

  it("fix passes that kept dying before any work: a functional repair still fails as the platform's, with no third dispatch", async () => {
    const h = harness({ maxRepairs: 3, outcomes: [{ kind: "repair", signal: "journey book failed" }] });
    Object.assign(h.node("d").payload, { site_repair_no_work: 2, site_repair_no_work_epoch: { e: 0, n: 2 } });
    h.node("d").site_repair_attempts = 2;
    await conductorTick("cond-1", h.deps);
    expect(h.dispatchRepair).not.toHaveBeenCalled();
    expect(h.node("d")).toMatchObject({ status: "failed", failure_class: "deploy_failed" });
    expect(String(h.node("d").error)).toContain("could not be prepared");
  });

  it("a second visual repair for the same node is never dispatched, even with passes left", async () => {
    const h = harness({ maxRepairs: 3, outcomes: [visualRepair, visualRepair] });
    await conductorTick("cond-1", h.deps);
    await conductorTick("cond-1", h.deps);
    await conductorTick("cond-1", h.deps);
    expect(h.dispatchRepair).toHaveBeenCalledTimes(1);
    expect(h.claimVisionFix).toHaveBeenCalledTimes(1);
    expect(h.charges).toHaveLength(0);
    expect(h.node("d").status).toBe("pending");
  });

  it("a claim that is not this run's (already used, unavailable, throwing, or no claim on the server) never becomes a charged pass: the fix is declined", async () => {
    for (const visionClaim of [{ status: "already_used" } as const, { status: "unavailable", reason: "reserved" } as const, new Error("db down"), null]) {
      const h = harness({
        visionClaim,
        step: async (i) => {
          if (i.kept_journeys?.must_pass.includes(VISION_FIX_MARK)) return { kind: "waiting" };
          i.checkpoint[SITE_VISION_CHECKPOINT_KEY] = { status: "reviewed", action: "repair" };
          return visualRepair;
        },
      });
      expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 0 });
      expect(h.dispatchRepair).not.toHaveBeenCalled();
      expect(h.charges).toEqual([]);
      expect(h.node("d").payload.site_vision_fix_used).toBe(true);
      expect(h.node("d").payload.site_vision).toEqual({ status: "reviewed", action: "declined" });
      expect(h.statuses).not.toContain("failed");
    }
  });

  it("a republish has no build to fix from: the finding never fails the publish, the free claim goes back, nothing is dispatched or charged, and the same commit goes live", async () => {
    const h = harness({
      republish: true,
      step: async (i) => (i.kept_journeys?.must_pass.includes(VISION_FIX_MARK) ? { kind: "live", url: "https://shop.zaviagent.com", verified_at: "2026-10-30T13:30:00.000Z" } : visualRepair),
    });
    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 0 });
    expect(h.node("d").status).toBe("pending");
    expect(h.node("d").error ?? null).toBeNull();
    expect(h.node("d").payload.site_vision_fix_used).toBe(true);
    expect(h.releaseVisionFix).toHaveBeenCalledTimes(1);
    expect(h.releaseVisionFix).toHaveBeenCalledWith(expect.objectContaining({ token: VISION_TOKEN }));
    expect(h.dispatchRepair).not.toHaveBeenCalled();
    expect(h.charges).toEqual([]);
    expect(await conductorTick("cond-1", h.deps)).toMatchObject({ action: "completed", final: "done" });
    expect(h.statuses).toEqual(["done"]);
    expect(h.stepCalls[1]!.attempt).toBe(h.stepCalls[0]!.attempt);
    expect(h.site.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "live" }));
  });

  it("a republish whose functional check fails still fails: only a screenshot finding is waived", async () => {
    const h = harness({ republish: true, outcomes: [{ kind: "repair", signal: "journey book failed" }] });
    await conductorTick("cond-1", h.deps);
    expect(h.statuses).toEqual(["failed"]);
    expect(h.node("d").payload.site_vision_fix_used).toBeUndefined();
    expect(h.claimVisionFix).not.toHaveBeenCalled();
    expect(h.dispatchRepair).not.toHaveBeenCalled();
  });

  it("a dispatch that did not start gives the free pass back", async () => {
    const h = harness({ outcomes: [visualRepair], dispatchFails: true });
    await conductorTick("cond-1", h.deps);
    expect(h.releaseVisionFix).toHaveBeenCalledWith({ tenant_id: T1, site_id: SITE, conductor_run_id: "cond-1", token: VISION_TOKEN });
    expect(h.charges).toEqual([]);
  });

  it("the step's vision record is lifted onto the node and survives the repair dropping the checkpoint", async () => {
    const h = harness({
      step: async (i) => {
        i.checkpoint[SITE_VISION_CHECKPOINT_KEY] = { status: "reviewed", action: "repair" };
        i.checkpoint["k1"] = { phase: "begun" };
        return visualRepair;
      },
    });
    await conductorTick("cond-1", h.deps);
    expect(h.node("d").payload.site_vision).toEqual({ status: "reviewed", action: "repair" });
    expect(h.node("d").payload.site_checkpoint).toBeUndefined();
  });
});

describe("end to end: conductor ticks driving the real deploy handler in correct mode", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const SHA = "abcdef1234567";
  const finding: SiteVisionFinding = {
    screenshot: "3 (mobile /)",
    page: "/",
    category: "mobile",
    severity: "high",
    class: "defect",
    confidence: 0.95,
    evidence: "the Book button covers the menu",
    suggestion: "stack header actions below 640px",
  };

  function realHandler(handlerMax: number, gates: Array<Partial<SiteGateResult>> = []) {
    const { store, sites } = fakeSiteStore([siteRow({ id: A, label: "smile", name: "Millbrook Smiles", supabase_project_ref: null, supabase_url: null })]);
    const kv: Record<string, string> = {};
    const sandbox = { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })), readFile: vi.fn(), listFiles: vi.fn() } as unknown as SiteSandbox;
    const gateInputs: SiteGateInput[] = [];
    const review = vi.fn();
    const runGate = vi.fn(async (i: SiteGateInput): Promise<SiteGateResult> => {
      gateInputs.push(i);
      review();
      return {
        ok: true,
        reason: "smoke journeys passed",
        evidence: "{}",
        owner_journey: "not_required",
        journeys: ["home"],
        all_fingerprints: { home: "h1" },
        vision: { status: "reviewed", ok: true, findings: [finding] },
        ...gates[gateInputs.length - 1],
      };
    });
    const deps: HandlerDeps = {
      store,
      sandboxes: { forSite: vi.fn(async () => sandbox) },
      supabase: { applySql: vi.fn(async () => "applied" as const), verifyCatalog: vi.fn(async () => []) },
      publisher: {
        stage: vi.fn(async (i: { sha: string }) => ({ deploy_id: `d00000000${gateInputs.length}-0000000${gateInputs.length}`, preview_url: "https://p/__zavi_preview/x/?t=tok-1-abcdefgh", sha: i.sha })),
        previewUrl: async () => "https://unused.example/",
      },
      generations: fakeGenerations(sites).generations,
      requestActivate: vi.fn(async (i: { tenant_id: string; site_id: string; deploy_id: string; sha: string }) => {
        if (await store.activateIfDesired(i.tenant_id, i.site_id, i.sha, i.deploy_id, "https://smile.zaviagent.com")) kv.host = i.deploy_id;
      }),
      activationState: (site: SiteRow, staged: Pick<StagedDeploy, "deploy_id" | "sha">) =>
        site.live_deploy_id === staged.deploy_id ? "live" : site.desired_sha !== staged.sha ? "superseded" : "pending",
      verifySiteDeploy: vi.fn(async (_h: string, id: string) => (kv.host === id ? ({ ok: true } as const) : ({ ok: false, error: "no" } as const))),
      checkpoints: nodePayloadCheckpoints(),
      runGate: runGate as unknown as HandlerDeps["runGate"],
      sleep: async () => {},
      activationWaitMs: 0,
      env: { SITE_GATE_VISION_REVIEW: "1" },
      visionMode: async () => "correct",
      repairMaxAttempts: async () => handlerMax,
    };
    const handler = createSiteDeployHandler(deps);
    const step = ({ checkpoint, ...i }: StepInput) => runWithNodeCheckpoints(checkpoint, () => handler.step(i));
    return { step, runGate, gateInputs, review, stage: deps.publisher.stage as ReturnType<typeof vi.fn> };
  }

  const quiet = () => {
    const w = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const i = vi.spyOn(console, "info").mockImplementation(() => undefined);
    return () => {
      w.mockRestore();
      i.mockRestore();
    };
  };

  it("the shipped default mode is correct: the free fix pass is on for everyone (Ravi 2026-10-07)", () => {
    expect(APP_SETTINGS.site_vision_review_mode.defaultValue).toBe("correct");
  });

  it("with the default single fix pass, a phone-width defect gets ONE bounded visual fix, then the site goes live and the fix's duration and outcome are recorded", async () => {
    const done = quiet();
    const real = realHandler(1, [{}, { vision: { status: "reviewed", ok: true, findings: [] } }]);
    const h = harness({ site_id: A, head: SHA, step: real.step, maxRepairs: 1 });
    let clock = Date.parse("2026-10-07T10:00:00Z");
    h.deps.now = () => clock;
    for (let i = 0; i < 8 && !h.statuses.length; i++) {
      await conductorTick("cond-1", h.deps);
      clock += 45_000;
    }
    done();
    expect(h.statuses).toEqual(["done"]);
    expect(h.dispatchRepair).toHaveBeenCalledTimes(1);
    expect(h.charges).toEqual([]);
    const call = h.dispatchRepair.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(call.payload.vision_fix).toBe(true);
    expect(isVisionFixPayload(call.payload)).toBe(true);
    expect(String(call.payload.failure_signal)).toContain("screenshot 3 (mobile /), mobile");
    expect(real.runGate).toHaveBeenCalledTimes(2);
    const rec = h.node("d").payload.site_vision_fix as Record<string, unknown>;
    expect(rec).toMatchObject({ attempt: 1, qualifying_before: 1, qualifying_after: 0, outcome: "fixed" });
    expect(rec.ms).toBeGreaterThan(0);
  });

  it("a fix for a section shown twice is re-checked by the page check alone when the screenshot review times out", async () => {
    const seed = "Customers say the team arrives on time, explains every step and leaves the place spotless.";
    let long = seed;
    while (long.length < 360) long += ` ${seed}`;
    const block = { len: 360, head: long.slice(0, 160) };
    const timeout = { status: "not_reviewed" as const, reason: "timeout" as const, findings: [] };
    const done = quiet();
    const real = realHandler(1, [
      { vision: timeout, page_text: [{ path: "/", text: long, sections: [], blocks: [block, block] }] },
      { vision: timeout, page_text: [{ path: "/", text: long, sections: [], blocks: [block] }] },
    ]);
    const h = harness({ site_id: A, head: SHA, step: real.step, maxRepairs: 1 });
    for (let i = 0; i < 10 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    done();
    expect(h.statuses).toEqual(["done"]);
    expect(h.dispatchRepair).toHaveBeenCalledTimes(1);
    const call = h.dispatchRepair.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(String(call.payload.failure_signal)).toContain("page / (read from the page's text), repetition");
    expect(h.node("d").payload.site_vision_fix).toMatchObject({ page_only: true, qualifying_before: 1, qualifying_after: 0, outcome: "fixed" });
  });

  it("a page-only fix is judged by the page check alone: a new screenshot finding after it is not still_flagged", async () => {
    const seed = "Customers say the team arrives on time, explains every step and leaves the place spotless.";
    let long = seed;
    while (long.length < 360) long += ` ${seed}`;
    const block = { len: 360, head: long.slice(0, 160) };
    const done = quiet();
    const real = realHandler(1, [
      { vision: { status: "reviewed", ok: true, findings: [] }, page_text: [{ path: "/", text: long, sections: [], blocks: [block, block] }] },
      { page_text: [{ path: "/", text: long, sections: [], blocks: [block] }] },
    ]);
    const h = harness({ site_id: A, head: SHA, step: real.step, maxRepairs: 1 });
    for (let i = 0; i < 10 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    done();
    expect(h.statuses).toEqual(["done"]);
    expect(h.dispatchRepair).toHaveBeenCalledTimes(1);
    expect(h.node("d").payload.site_vision_fix).toMatchObject({ page_only: true, qualifying_after: 0, outcome: "fixed" });
  });

  it("the visual fix never runs twice: a review that still flags the defect after it publishes the fixed commit and records still_flagged", async () => {
    const done = quiet();
    const real = realHandler(1);
    const h = harness({ site_id: A, head: SHA, step: real.step, maxRepairs: 1 });
    for (let i = 0; i < 10 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    done();
    expect(h.statuses).toEqual(["done"]);
    expect(h.dispatchRepair).toHaveBeenCalledTimes(1);
    expect(h.charges).toHaveLength(0);
    expect(real.runGate).toHaveBeenCalledTimes(2);
    expect(h.node("d").payload.site_vision_fix).toMatchObject({ outcome: "still_flagged", qualifying_after: 1 });
  });

  it("with the default single fix pass, a visual fix whose commit fails its checks still gets its functional repair, which is not a vision fix", async () => {
    const done = quiet();
    const real = realHandler(1, [{}, { ok: false, reason: "journey home failed", failed_journeys: ["home"], fingerprints: { home: "h1" } }, {}]);
    const h = harness({ site_id: A, head: SHA, step: real.step, maxRepairs: 1 });
    for (let i = 0; i < 12 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    done();
    expect(h.statuses).toEqual(["done"]);
    expect(h.dispatchRepair).toHaveBeenCalledTimes(2);
    const second = h.dispatchRepair.mock.calls[1]![0] as { payload: Record<string, unknown> };
    expect(second.payload.vision_fix).toBeUndefined();
    expect(isVisionFixPayload(second.payload)).toBe(false);
    expect(h.node("d").payload.site_vision_fix).toMatchObject({ outcome: "checks_failed" });
    expect(real.runGate).toHaveBeenCalledTimes(3);
  });

  it("after the visual fix and the functional pass are both spent, a commit that still fails ends the build instead of buying a third pass", async () => {
    const done = quiet();
    const broken = { ok: false, reason: "journey home failed", failed_journeys: ["home"], fingerprints: { home: "h1" } };
    const real = realHandler(1, [{}, broken, broken, broken]);
    const h = harness({ site_id: A, head: SHA, step: real.step, maxRepairs: 1 });
    for (let i = 0; i < 12 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    done();
    expect(h.dispatchRepair).toHaveBeenCalledTimes(2);
    expect(h.charges).toHaveLength(1);
    expect(h.node("d").status).toBe("failed");
  });

  it("a declined visual fix grants no extra functional pass", async () => {
    const h = harness({ noDispatch: true, maxRepairs: 1, outcomes: [visualRepair] });
    await conductorTick("cond-1", h.deps);
    expect(h.node("d").payload.site_vision_fix_used).toBe(true);
    expect(h.node("d").payload.site_vision_fix).toBeUndefined();
  });

  it("with two passes, a visual fix whose commit then fails its checks still gets its functional repair and goes live", async () => {
    const done = quiet();
    const real = realHandler(2, [{}, { ok: false, reason: "journey home failed", failed_journeys: ["home"], fingerprints: { home: "h1" } }, {}]);
    const h = harness({ site_id: A, head: SHA, step: real.step, maxRepairs: 2 });
    for (let i = 0; i < 10 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    done();
    expect(h.statuses).toEqual(["done"]);
    expect(h.dispatchRepair).toHaveBeenCalledTimes(2);
    expect(real.runGate).toHaveBeenCalledTimes(3);
    expect(h.node("d").status).toBe("done");
  });

  it("dispatch unavailable: the declined visual fix publishes the gated commit without staging, gating or reviewing it again", async () => {
    const done = quiet();
    const real = realHandler(2);
    const h = harness({ site_id: A, head: SHA, step: real.step, maxRepairs: 2, noDispatch: true });
    for (let i = 0; i < 6 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    done();
    expect(h.statuses).toEqual(["done"]);
    expect(real.stage).toHaveBeenCalledTimes(1);
    expect(real.runGate).toHaveBeenCalledTimes(1);
    expect(real.review).toHaveBeenCalledTimes(1);
    expect(h.charges).toEqual([]);
    expect(h.node("d").payload.site_vision).toMatchObject({ action: "declined" });
  });

  it("republish: a screenshot finding on the real deploy handler publishes the gated commit, without staging, gating or reviewing it again", async () => {
    const done = quiet();
    const real = realHandler(2);
    const h = harness({ site_id: A, head: SHA, step: real.step, maxRepairs: 2, republish: true });
    for (let i = 0; i < 6 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    done();
    expect(h.statuses).toEqual(["done"]);
    expect(real.stage).toHaveBeenCalledTimes(1);
    expect(real.runGate).toHaveBeenCalledTimes(1);
    expect(real.review).toHaveBeenCalledTimes(1);
    expect(h.dispatchRepair).not.toHaveBeenCalled();
    expect(h.charges).toEqual([]);
    expect(h.node("d").payload.site_vision).toMatchObject({ action: "declined" });
  });

  it("one free visual fix, then the gate re-runs with journeys kept, the review observes, and the site goes live", async () => {
    const done = quiet();
    const real = realHandler(2);
    const h = harness({ site_id: A, head: SHA, step: real.step, maxRepairs: 2 });
    for (let i = 0; i < 6 && !h.statuses.length; i++) await conductorTick("cond-1", h.deps);
    done();
    expect(h.statuses).toEqual(["done"]);
    expect(h.dispatchRepair).toHaveBeenCalledTimes(1);
    expect(h.charges).toEqual([]);
    expect(real.runGate).toHaveBeenCalledTimes(2);
    expect(real.gateInputs[1]!.kept_journeys).toEqual({ names: ["home"], must_pass: [VISION_FIX_MARK], fingerprints: { home: "h1" } });
    expect(real.gateInputs[1]!.vision?.mode).toBe("correct");
    expect(h.node("d").payload.site_vision).toMatchObject({ status: "reviewed", action: "skipped_used", attempt: 2, counts: { qualifying: 1 } });
    expect(h.node("d").status).toBe("done");
  });

});
