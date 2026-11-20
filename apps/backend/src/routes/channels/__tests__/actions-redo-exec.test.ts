import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const ID = "0f4d7c1a-2b3c-4d5e-8f90-123456789abc";

let row: Record<string, unknown> | null = null;
const { enqueueAgentRun, tenantRpc } = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(async () => ({ run_id: "r-1" })),
  tenantRpc: vi.fn(async (_t: string, name: string) =>
    name === "claim_channel_run"
      ? { data: { ok: true, duplicate: false, claim_id: "claim-1" }, error: null }
      : { data: { ok: true }, error: null },
  ),
}));

vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: TENANT, user_id: "u-1", access_token: "tok" })),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc,
  globalClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
  tenantClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () =>
          table === "agent_runs"
            ? Promise.resolve({ data: [], error: null })
            : table === "channel_run_claims"
              ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }
              : { maybeSingle: async () => ({ data: row, error: null }) },
      }),
    }),
  }),
}));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun, InsufficientCreditsError: class InsufficientCreditsError extends Error {} }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));

import { channelActionRedo } from "../actions";
import { resetTenantPlan, tenantPlan } from "@/__tests__/helpers/tenant-plan";

function res() {
  const r: { _status: number; _body: unknown; status: (n: number) => typeof r; json: (b: unknown) => typeof r } = {
    _status: 200,
    _body: undefined,
    status(n) { r._status = n; return r; },
    json(b) { r._body = b; return r; },
  };
  return r;
}

const req = () =>
  ({ params: { id: ID }, body: { note: "too vague" } }) as unknown as Request;

const base = {
  id: ID,
  channel_slug: "google_ads",
  run_id: "run-1",
  position: 1,
  run_of: 3,
  title: "Raise the budget on Brand",
  title_key: "raise-the-budget-on-brand",
  status: "pending",
  exec_status: null,
  exec_class: null as string | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetTenantPlan();
  tenantRpc.mockImplementation(async (_t: string, name: string) =>
    name === "claim_channel_run"
      ? { data: { ok: true, duplicate: false, claim_id: "claim-1" }, error: null }
      : { data: { ok: true }, error: null },
  );
  row = { ...base };
});

describe("POST /api/channel-actions/:id/redo on an executable card", () => {
  it("refuses, and does NOT enqueue a run that would eat the proposal", async () => {
    row = { ...base, exec_class: "google_ads.budget_change" };
    const r = res();
    await channelActionRedo(req(), r as unknown as Response);
    expect(r._status).toBe(409);
    expect((r._body as { error: { code: string } }).error.code).toBe("exec_action_use_revise");
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("a card already closed elsewhere is refused in plain words, never the raw status", async () => {
    for (const status of ["acted", "redone", "displaced"]) {
      row = { ...base, status };
      const r = res();
      await channelActionRedo(req(), r as unknown as Response);
      expect(r._status).toBe(409);
      expect(r._body).toEqual({ error: { code: "not_open", message: "This card was already handled." } });
    }
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("names Revise, so the founder is not dead-ended", async () => {
    row = { ...base, exec_class: "meta_ads.status_change" };
    const r = res();
    await channelActionRedo(req(), r as unknown as Response);
    expect((r._body as { error: { message: string } }).error.message).toMatch(/Revise/);
  });

  it("still redoes a NON-executable card", async () => {
    row = { ...base, channel_slug: "seo", exec_class: null };
    const r = res();
    await channelActionRedo(req(), r as unknown as Response);
    expect(r._status).not.toBe(409);
    expect(enqueueAgentRun).toHaveBeenCalled();
    const setAt = tenantRpc.mock.invocationCallOrder[
      tenantRpc.mock.calls.findIndex((c) => c[1] === "set_channel_action")
    ];
    expect(setAt).toBeLessThan(enqueueAgentRun.mock.invocationCallOrder[0]);
  });

  it("does not start a run when the redo click is refused", async () => {
    row = { ...base, channel_slug: "seo", exec_class: null };
    tenantRpc.mockImplementation(async (_t: string, name: string) =>
      name === "set_channel_action"
        ? { data: { ok: false, code: "illegal_transition" }, error: null }
        : { data: { ok: true }, error: null },
    );
    const r = res();
    await channelActionRedo(req(), r as unknown as Response);
    expect(r._status).toBe(409);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("treats an empty exec_class as not executable", async () => {
    row = { ...base, channel_slug: "seo", exec_class: "" };
    const r = res();
    await channelActionRedo(req(), r as unknown as Response);
    expect(r._status).not.toBe(409);
  });
});

describe("POST /api/channel-actions/:id/redo and the plan", () => {
  it("Free: 403 with the upgrade body, NO redo_requested event and no run", async () => {
    tenantPlan.tier = "free";
    row = { ...base, channel_slug: "seo", exec_class: null };
    const r = res();
    await channelActionRedo(req(), r as unknown as Response);
    expect(r._status).toBe(403);
    expect(r._body).toMatchObject({ error: { code: "plan_upgrade_required", required_tier: "starter" } });
    expect(tenantRpc.mock.calls.filter((c) => c[1] === "set_channel_action")).toEqual([]);
    expect(tenantRpc).not.toHaveBeenCalled();
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("Starter: the click is recorded and the run starts, as before", async () => {
    tenantPlan.tier = "starter";
    row = { ...base, channel_slug: "seo", exec_class: null };
    const r = res();
    await channelActionRedo(req(), r as unknown as Response);
    expect(r._status).toBe(202);
    const sets = (tenantRpc.mock.calls as unknown[][]).filter((c) => c[1] === "set_channel_action");
    expect(sets.map((c) => (c[2] as { p_status?: string }).p_status)).toEqual(["redo_requested"]);
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it("another tenant's card still reads as missing, whatever the plan", async () => {
    tenantPlan.tier = "free";
    row = null;
    const r = res();
    await channelActionRedo(req(), r as unknown as Response);
    expect(r._status).toBe(404);
  });
});
