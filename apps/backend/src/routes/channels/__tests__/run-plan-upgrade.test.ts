
import type { Request, Response } from "express";
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  runChannelRecipe: vi.fn(),
  ensureAgentRunnable: vi.fn(),
  enqueueAgentRun: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "t-1", user_id: "u-1", access_token: "tok" }),
}));
vi.mock("@/services/channels/engine", () => ({ runChannelRecipe: m.runChannelRecipe }));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: m.enqueueAgentRun,
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
  AgentNotFoundError: class extends Error {},
  SafetyGateError: class extends Error {},
  BudgetExceededError: class extends Error {},
  BuildCreditsExhaustedError: class extends Error {},
}));
vi.mock("@/services/agents/fleet-halt", () => ({ FleetHaltedError: class extends Error {} }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));
vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => ({ user_id: "u-staff", email: "staff@zaviagent.com" }),
}));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: async () => {} }));
vi.mock("@/services/readiness/fde-events", () => ({ logFdeEvent: async () => {}, GAP_DIMENSIONS: [] }));
vi.mock("@/services/readiness/compute", () => ({ readReadiness: async () => null }));
vi.mock("@/services/agents/ensure-runnable", () => ({ ensureAgentRunnable: m.ensureAgentRunnable }));

import { channelRun, startChannelRun } from "../run";
import { staffFdeDispatch } from "../../admin/fde-dispatch";

const BODY = {
  error: { code: "plan_upgrade_required", required_tier: "pro", message: "Meta Ads needs the Pro plan ($240/mo)." },
};
const refusal = () =>
  Object.assign(new Error(BODY.error.message), {
    code: "plan_upgrade_required",
    agent_slug: "meta_ads",
    required_tier: "pro",
    body: BODY,
  });

function mkRes() {
  const r = { statusCode: 200, body: null as unknown };
  const res = {
    status(c: number) {
      r.statusCode = c;
      return res;
    },
    json(b: unknown) {
      r.body = b;
      return res;
    },
  } as unknown as Response;
  return { res, r };
}

beforeEach(() => {
  m.runChannelRecipe.mockReset();
  m.ensureAgentRunnable.mockReset();
  m.enqueueAgentRun.mockReset();
});

describe("POST /api/channels/:slug/run — plan_upgrade_required", () => {
  it("tier refusal from the enqueue → 403 upgrade body", async () => {
    m.runChannelRecipe.mockRejectedValue(refusal());
    const { res, r } = mkRes();
    await channelRun({ params: { slug: "meta_ads" }, body: {} } as unknown as Request, res);
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual(BODY);
  });

  it("an ordinary throw still 500s (the mapping is narrow)", async () => {
    m.runChannelRecipe.mockRejectedValue(new Error("db constraint"));
    const { res, r } = mkRes();
    await channelRun({ params: { slug: "meta_ads" }, body: {} } as unknown as Request, res);
    expect(r.statusCode).toBe(500);
  });

  it("a server failure reaches the founder as a plain line, never the raw exception, which is still logged", async () => {
    const raw = 'duplicate key value violates unique constraint "agent_runs_pkey" (SQLSTATE 23505) at enqueue_agent_run';
    m.runChannelRecipe.mockRejectedValue(new Error(raw));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { res, r } = mkRes();
    await startChannelRun(res, { tenant_id: "t-1", user_id: "u-1", access_token: "tok" } as never, "generated_video", { requestId: "ai-ugc-starters-1" });
    expect(r.statusCode).toBe(500);
    expect(r.body).toEqual({ error: { code: "enqueue_failed", message: "Zavi couldn't start this one. Try again in a minute." } });
    expect(JSON.stringify(r.body)).not.toContain("SQLSTATE");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(raw));
    logged.mockRestore();
  });
});

describe("POST staff FDE dispatch — plan_upgrade_required", () => {
  const req = (slug: string) =>
    ({ params: { tenant_id: "t-1" }, body: { agent_slug: slug, prompt: "do it" } }) as unknown as Request;

  it("pre-flight gate refusal → 403 upgrade body, no enqueue", async () => {
    m.ensureAgentRunnable.mockResolvedValue({
      runnable: false,
      reason: "plan_upgrade_required",
      required_tier: "pro",
      detail: BODY.error.message,
    });
    const { res, r } = mkRes();
    await staffFdeDispatch(req("meta_ads"), res);
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual(BODY);
    expect(m.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("enqueue-time refusal (DB backstop) → 403 upgrade body", async () => {
    m.ensureAgentRunnable.mockResolvedValue({ runnable: true, agent: { slug: "meta_ads" } });
    m.enqueueAgentRun.mockRejectedValue(refusal());
    const { res, r } = mkRes();
    await staffFdeDispatch(req("meta_ads"), res);
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual(BODY);
  });
});
