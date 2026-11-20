import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TENANT = { id: "11111111-1111-4111-8111-111111111111", display_name: "Acme" };

const getBoolSettingMock = vi.fn(async () => true);
vi.mock("@/services/settings", () => ({
  getBoolSetting: (...args: unknown[]) => getBoolSettingMock(...(args as [])),
}));

const isFleetHaltedMock = vi.fn(async () => false);
vi.mock("@/services/agents/fleet-halt", () => ({
  isFleetHalted: () => isFleetHaltedMock(),
}));

const enqueueAgentRunMock = vi.fn(async () => ({ run_id: "run-1" }));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: (...args: unknown[]) => enqueueAgentRunMock(...(args as [])),
}));

const resolveRepoFullNameMock = vi.fn(async () => "rravi149/acme");
vi.mock("@/services/agents/repo-resolver", () => ({
  resolveRepoFullName: (...args: unknown[]) => resolveRepoFullNameMock(...(args as [])),
}));

const enqueueCompetitorScanMock = vi.fn(async () => ({ run_id: "run-2" }));
vi.mock("@/services/competitor-intel/scan", () => ({
  enqueueCompetitorScan: (...args: unknown[]) => enqueueCompetitorScanMock(...(args as [])),
  buildCompetitorAsk: () => "ask",
  COMPETITOR_SCAN_SOURCE: "competitor-intel",
}));

const buildGrowthFanInPayloadMock = vi.fn(async () => ({
  memory: { growth_fan_in: "block" },
  fan_in_note_ids: [] as string[],
}));
vi.mock("@/services/growth/fan-in", () => ({
  buildGrowthFanInPayload: (...args: unknown[]) => buildGrowthFanInPayloadMock(...(args as [])),
  renderFanInBlock: () => "block",
  renderBetOutcomesBlock: () => "bets",
}));

vi.mock("@/agents/research/persist-snapshot", () => ({ mondayUtc: () => "2026-09-07" }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: vi.fn() }) }));
vi.mock("../client", () => ({
  inngest: { createFunction: vi.fn(() => ({ id: "fn" })) },
}));

import { SCHEDULED_AGENTS_ALLOWED, SCHEDULED_WORKERS_ALLOWED, isCronStopped, isWorkerCronStopped } from "@/services/agents/cron-stopped";
import { runForTenant as engineerAuditRunForTenant } from "../engineer-audit-weekly";
import { runForTenant as competitorIntelRunForTenant } from "../competitor-intel-weekly";
import { fanInOneTenant } from "../growth-lead-daily";
import { pulseOneTenant } from "../perfmkt-pulse";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PRAXIS_DISABLE_CRON_STOP;
});
afterEach(() => {
  delete process.env.PRAXIS_DISABLE_CRON_STOP;
});

describe("the stop list names the legacy clocks and nothing else", () => {
  it("stops the fleet-default generalists", () => {
    for (const slug of ["chief-of-staff", "pm", "growth-lead", "performance-marketer", "dispute-response", "qa"]) {
      expect(isCronStopped(slug)).toBe(true);
    }
  });

  it("stops the slugs that were previously EXEMPT, including standing orders", () => {
    expect(isCronStopped("operator")).toBe(true);
    expect(isCronStopped("research")).toBe(true);
    expect(isCronStopped("onboarding-discovery")).toBe(true);
  });

  it("stops channels too — channel-sweep is no longer exempt", () => {
    for (const slug of ["seo", "google_ads", "meta_ads", "reddit_organic", "geo"]) {
      expect(isCronStopped(slug)).toBe(true);
    }
    expect(isWorkerCronStopped("channel-sweep")).toBe(true);
  });

  it("stops every scheduled worker, named or not", () => {
    for (const w of [
      "engineer-audit-weekly", "competitor-intel-weekly", "channel-sweep",
      "readiness-scan", "outbound-sequence-tick", "dispatch-decision-auto-cron",
      "autopilot-digest-push", "autopilot-demote-on-silence",
      "refine-suggestion-scan", "idle-coach-scan",
      "company-brain-heartbeat", "brain-judge-scan", "goal-proposer-scan",
      "slack-channel-summarize", "material-news-scan", "material-news-digest",
      "conductor-tick-autonomy",
      "distill-routine-candidate", "fde-fold-scan", "patterns-nightly",
      "nightly-self-improve",
      "a-worker-that-does-not-exist-yet",
    ]) {
      expect(isWorkerCronStopped(w), w).toBe(true);
    }
  });

  it("does NOT stop the workers that earn their keep", () => {
    const src = (name: string) =>
      readFileSync(join(__dirname, `../${name}.ts`), "utf8");
    for (const w of [
      "score-runs", "dream-cycle", "distill-skill-candidate",
      "meeting-bot-scheduler", "meta-ads-token-health", "self-heal-scan",
      "strategist-review-sweep", "operator-followthrough-sweep",
      "work-queue-drainer", "queued-stuck-scan", "reminder-fire",
    ]) {
      expect(src(w), w).not.toMatch(/isWorkerCronStopped\(/);
    }
  });

  it("the agent allowlist is empty; the worker allowlist holds cgo's daily check and the daily goal measurement (Ravi 2026-09-25, 2026-09-26)", () => {
    expect(SCHEDULED_AGENTS_ALLOWED.size).toBe(0);
    expect([...SCHEDULED_WORKERS_ALLOWED]).toEqual(["cgo-daily-check", "goal-reconcile", "ad-budget-reconcile", "email-results-check", "email-plan-tick", "live-stunt-snapshot", "live-stunt-draft", "cgo-budget-review", "ad-spend-controller", "onboarding-email-sweep", "first-plan-watch"]);
  });
});

describe("each stopped clock returns before touching any dependency", () => {
  it("engineer-audit-weekly: no settings read, no repo resolve, no enqueue", async () => {
    const out = await engineerAuditRunForTenant(TENANT);
    expect(out.status).toBe("skipped");
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
    expect(getBoolSettingMock).not.toHaveBeenCalled();
    expect(resolveRepoFullNameMock).not.toHaveBeenCalled();
    expect(isFleetHaltedMock).not.toHaveBeenCalled();
  });

  it("competitor-intel-weekly: no settings read, no scan enqueue", async () => {
    const out = await competitorIntelRunForTenant(TENANT);
    expect(out.status).toBe("skipped");
    expect(enqueueCompetitorScanMock).not.toHaveBeenCalled();
    expect(getBoolSettingMock).not.toHaveBeenCalled();
  });

  it("growth-lead-daily: no fan-in build, no enqueue", async () => {
    const out = await fanInOneTenant(TENANT, "2026-09-07T00:00:00.000Z");
    expect(out.enqueued).toBe(false);
    expect(out.reason).toBe("cron_stopped");
    expect(buildGrowthFanInPayloadMock).not.toHaveBeenCalled();
    expect(enqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it("perfmkt-pulse: no autopilot read, no Meta call, no enqueue", async () => {
    const deps = {
      isAutopilotOn: vi.fn(async () => true),
      isPulseEnabled: vi.fn(async () => true),
      getCreds: vi.fn(async () => ({ ad_account_id: "act_1" })),
      readWindow: vi.fn(),
      readPixelStatus: vi.fn(),
      enqueue: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await pulseOneTenant({ id: TENANT.id } as any, deps as any);
    expect(out.status).toBe("skipped");
    expect(deps.isAutopilotOn).not.toHaveBeenCalled();
    expect(deps.getCreds).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});

describe("the stop is reversible without a deploy", () => {
  it("PRAXIS_DISABLE_CRON_STOP=1 lifts both sets", () => {
    process.env.PRAXIS_DISABLE_CRON_STOP = "1";
    expect(isCronStopped("pm")).toBe(false);
    expect(isWorkerCronStopped("engineer-audit-weekly")).toBe(false);
  });

  it("with the hatch lifted, a stopped clock reaches its real gates again", async () => {
    process.env.PRAXIS_DISABLE_CRON_STOP = "1";
    getBoolSettingMock.mockResolvedValueOnce(false);
    const out = await engineerAuditRunForTenant(TENANT);
    expect(out.status).toBe("skipped");
    expect(getBoolSettingMock).toHaveBeenCalled();
  });
});
