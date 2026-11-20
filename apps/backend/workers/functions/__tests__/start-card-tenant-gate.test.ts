
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  handler: null as null | ((ctx: { event: unknown; step: unknown }) => Promise<unknown>),
  gate: vi.fn(async () => null as null | string),
  cancelCard: vi.fn(async () => undefined),
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (cfg: { id: string }, _t: unknown, fn: (ctx: { event: unknown; step: unknown }) => Promise<unknown>) => {
      if (cfg.id === "start-card") h.handler = fn;
      return { id: cfg.id };
    },
    send: vi.fn(async () => undefined),
  },
}));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn(async () => true) }));
vi.mock("@/services/start-card/pipeline", () => ({
  applyProfileToRow: vi.fn(async () => undefined),
  contextFor: vi.fn(() => ({})),
  cancelCard: h.cancelCard,
  failCard: vi.fn(async () => undefined),
  finishCard: vi.fn(async () => undefined),
  runAndWriteStage: vi.fn(async () => ({ part: { state: "done", evidence: {} }, cost_usd: 0.05 })),
  sendQueuedCardEmails: vi.fn(async () => 0),
}));
vi.mock("@/services/start-card/stages", () => ({
  SCORER_VERSION: "1",
  runAiStage: vi.fn(),
  runCompareStage: vi.fn(),
  runDesignStage: vi.fn(),
  runDiagnosisStage: vi.fn(),
  runGoogleStage: vi.fn(),
  runProfileStage: vi.fn(),
  runSeoStage: vi.fn(),
  scoreCard: vi.fn(() => ({ total: 50, out_of: 100 })),
}));
vi.mock("@/services/start-card/queue", () => ({ drainQueue: vi.fn(), retentionCutoffIso: vi.fn() }));
vi.mock("@/services/start-card/store", () => ({
  getCardById: vi.fn(async () => ({ id: "card-1", domain: "vercel.com", status: "running", revoked_at: null, funding_kind: "tenant_credits" })),
  isTenantFunded: vi.fn(() => true),
  listUnsettledTenantCards: vi.fn(),
  purgeStaleQueueRows: vi.fn(),
  updateCard: vi.fn(async () => undefined),
}));
vi.mock("@/services/start-card/site-check-funding", () => ({ TENANT_SETTLE_EVENT: "start-card/tenant.settle", kickTenantSettle: vi.fn() }));
vi.mock("@/services/start-card/site-check-settle", () => ({ settleTenantCardFlow: vi.fn() }));
vi.mock("@/services/start-card/site-check-tool", () => ({ tenantCardStartBlock: h.gate }));

import "../start-card";

function memoStep(memo: Map<string, unknown>) {
  const ran: string[] = [];
  return {
    ran,
    run: async (id: string, fn: () => Promise<unknown>) => {
      if (memo.has(id)) return memo.get(id);
      ran.push(id);
      const v = await fn();
      memo.set(id, v === undefined ? null : v);
      return v;
    },
    sendEvent: vi.fn(async () => undefined),
  };
}

const event = { data: { card_id: "card-1" } };

describe("startCardFn tenant gate (re-review F5)", () => {
  beforeEach(() => {
    h.gate.mockReset();
    h.cancelCard.mockClear();
  });

  it("the tool-enabled decision lives in the tenant-gate step", async () => {
    h.gate.mockResolvedValueOnce("tool_disabled");
    const step = memoStep(new Map());
    const r = await h.handler!({ event, step });
    expect(r).toEqual({ status: "skip", reason: "tool_disabled" });
    expect(step.ran).toContain("tenant-gate");
    expect(h.cancelCard).toHaveBeenCalledWith("card-1", "tool_disabled");
  });

  it("a retry after the gate passed replays it and never cancels, even if the switch is off now", async () => {
    const memo = new Map<string, unknown>();
    h.gate.mockResolvedValueOnce(null);
    const first = memoStep(memo);
    await h.handler!({ event, step: first });
    expect(first.ran).toContain("stage-profile");
    memo.delete("finish");
    h.gate.mockResolvedValue("tool_disabled");
    const retry = memoStep(memo);
    const r = await h.handler!({ event, step: retry });
    expect(retry.ran).not.toContain("tenant-gate");
    expect(h.cancelCard).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "done" });
  });
});
