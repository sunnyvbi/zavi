import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>) => undefined),
  getBoolSetting: vi.fn(async (_k: string, _t?: string) => true),
}));

vi.mock("@/services/logging/logEvent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/logging/logEvent")>()),
  logEvent: h.logEvent,
}));
vi.mock("@/services/settings", () => ({ getBoolSetting: h.getBoolSetting, getNumberSetting: vi.fn(async () => 1) }));

import { logSiteDeployTiming, logSiteEditTiming } from "../site-timing";
import { makeSiteDeployDeps } from "../site-deploy-deps";
import { fakeStore } from "./site-fakes";
import { conductorTick, type ConductorNode, type ConductorTickDeps, type SiteDeployDeps } from "@/services/agents/conductor";
import { LOG_META_KEYS } from "@/services/logging/logEvent";

const T1 = "11111111-1111-4111-8111-111111111111";
const RUN = "c0ffee00-0000-4000-8000-000000000042";
const SITE = "aaaaaaaa-0000-4000-8000-000000000001";
const REQUESTED = "2026-10-01T10:00:00.000Z";

beforeEach(() => {
  h.logEvent.mockClear();
  h.getBoolSetting.mockReset();
  h.getBoolSetting.mockImplementation(async () => true);
});

describe("site timing rows", () => {
  it("site_deploy_timing: the breakdown is in the message, only ms/build_stage/gate_verdict in meta", async () => {
    await logSiteDeployTiming({
      tenant_id: T1,
      site_id: SITE,
      conductor_run_id: RUN,
      started_at: 0,
      migrations_ms: null,
      stage_ms: 31_000,
      gate: "light",
      gate_ms: 1_200,
      activate_ms: 2_500,
      total_ms: 35_000,
    });
    expect(h.getBoolSetting).toHaveBeenCalledWith("site_edit_timing_log", T1);
    expect(h.logEvent).toHaveBeenCalledTimes(1);
    const e = h.logEvent.mock.calls[0][0] as { code: string; run_id: string; message: string; meta: Record<string, unknown>; tenant_id: string };
    expect(e).toMatchObject({ code: "site_deploy_timing", tenant_id: T1, run_id: RUN });
    expect(e.message).toBe(`site=${SITE} migrations=skipped stage=31000ms gate=light:1200ms activate=2500ms total=35000ms`);
    expect(e.meta).toEqual({ ms: 35_000, build_stage: "site_deploy", gate_verdict: "light" });
    for (const k of Object.keys(e.meta)) expect(LOG_META_KEYS as readonly string[]).toContain(k);
  });

  it("site_edit_timing: ms is request to live", async () => {
    await logSiteEditTiming({ tenant_id: T1, site_id: SITE, conductor_run_id: RUN, refine_requested_at: REQUESTED, now: () => Date.parse(REQUESTED) + 58_000 });
    const e = h.logEvent.mock.calls[0][0] as { code: string; meta: Record<string, unknown>; message: string };
    expect(e.code).toBe("site_edit_timing");
    expect(e.meta).toEqual({ ms: 58_000, build_stage: "site_edit" });
    expect(e.message).toContain("request_to_live=58000ms");
  });

  it("with site_edit_timing_log off, or a bad timestamp, nothing is written", async () => {
    h.getBoolSetting.mockImplementation(async () => false);
    await logSiteDeployTiming({ tenant_id: T1, site_id: SITE, conductor_run_id: RUN, started_at: 0, migrations_ms: 5, stage_ms: 1, gate: "full", gate_ms: 1, activate_ms: 1, total_ms: 8 });
    await logSiteEditTiming({ tenant_id: T1, site_id: SITE, conductor_run_id: RUN, refine_requested_at: REQUESTED });
    h.getBoolSetting.mockImplementation(async () => true);
    await logSiteEditTiming({ tenant_id: T1, site_id: SITE, conductor_run_id: RUN, refine_requested_at: "not a date" });
    expect(h.logEvent).not.toHaveBeenCalled();
  });
});

describe("a site refine that goes live logs site_edit_timing", () => {
  function graph(): ConductorNode[] {
    return [
      {
        id: "refine-1",
        status: "done",
        target_agent_slug: "engineer",
        payload: { stage: "build", refine_mode: true, fast_edit: true, site_id: SITE, refine_requested_at: REQUESTED, target: { github_full_name: "praxis-built/alpha" } },
        estimate_usd: 0.5,
        child_run_id: "child-1",
      },
      {
        id: "refine-deploy-1",
        status: "pending",
        target_agent_slug: "",
        payload: { stage: "deploy", site_id: SITE, refine_requested_at: REQUESTED },
        estimate_usd: 0,
        child_run_id: null,
      },
    ];
  }

  async function tick(settle: SiteDeployDeps["settle"]) {
    let g = graph();
    const site: SiteDeployDeps = {
      step: vi.fn(async () => ({ kind: "live" as const, url: "https://alpha.zaviagent.com", verified_at: "2026-10-01T10:00:58.000Z" })),
      headSha: vi.fn(async () => "2222222"),
      markDesired: vi.fn(async () => undefined),
      settle,
      repairMaxAttempts: vi.fn(async () => 1),
    };
    const deps: ConductorTickDeps = {
      load: async () => ({ id: RUN, tenant_id: T1, objective: "[refine] x", status: "active", max_usd: 5, spend_usd: 0, kind: "build_app", goal_graph: g }),
      childStatus: async () => "success",
      consumeBudget: vi.fn(async () => "charged" as const),
      dispatch: vi.fn(async () => ({ ok: true as const, child_run_id: "x" })),
      saveGraph: async (_id: string, next: ConductorNode[]) => {
        g = next;
      },
      setStatus: async () => undefined,
      siteDeploy: site,
    } as unknown as ConductorTickDeps;
    return conductorTick(RUN, deps);
  }

  it("the conductor hands the run id and refine_requested_at to settle when the site goes live", async () => {
    const settle = vi.fn(async () => undefined);
    expect(await tick(settle)).toEqual({ action: "completed", final: "done" });
    expect(settle).toHaveBeenCalledWith({ tenant_id: T1, site_id: SITE, outcome: "live", conductor_run_id: RUN, refine_requested_at: REQUESTED });
  });

  it("the real settle marks the site live and writes the site_edit_timing row", async () => {
    const store = fakeStore();
    const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "root-1", company_name: "Alpha", started_by_user_id: null });
    await store.transition(T1, s.id, ["provisioning"], "publishing");
    const logEditTiming = vi.fn(async () => undefined);
    const d = makeSiteDeployDeps({ store, logEditTiming });
    await d.settle!({ tenant_id: T1, site_id: s.id, outcome: "live", conductor_run_id: RUN, refine_requested_at: REQUESTED });
    expect(store.sites.get(s.id)?.status).toBe("live");
    expect(logEditTiming).toHaveBeenCalledWith({ tenant_id: T1, site_id: s.id, conductor_run_id: RUN, refine_requested_at: REQUESTED });
    await d.settle!({ tenant_id: T1, site_id: s.id, outcome: "live" });
    expect(logEditTiming).toHaveBeenCalledTimes(1);
  });

  it("the default settle logger writes through site-timing", async () => {
    const store = fakeStore();
    const s = await store.getOrCreateForRun({ tenant_id: T1, root_conductor_run_id: "root-2", company_name: "Beta", started_by_user_id: null });
    const d = makeSiteDeployDeps({ store });
    await d.settle!({ tenant_id: T1, site_id: s.id, outcome: "live", conductor_run_id: RUN, refine_requested_at: REQUESTED });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "site_edit_timing", run_id: RUN, tenant_id: T1 }));
  });
});
