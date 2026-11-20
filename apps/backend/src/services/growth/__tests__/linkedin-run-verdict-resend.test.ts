import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "44444444-4444-4444-4444-444444444444";

const m = vi.hoisted(() => ({
  cards: new Map<string, Record<string, unknown>>(),
  events: new Map<string, number>(),
  sends: [] as Array<{ id: string; ok: boolean }>,
  failSends: 0,
  alert: vi.fn(),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  tenantClient: () => ({
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => ((f[c] = v), chain),
        is: (c: string, v: unknown) => ((f[c] = v), chain),
        maybeSingle: async () => {
          if (table === "agent_runs") return { data: { fit_verdict: "here", enqueued_at: "2026-11-03T10:00:00Z" }, error: null };
          return { data: m.cards.get(String(f.id)) ?? null, error: null };
        },
        then: (ok: (r: unknown) => unknown) =>
          ok({
            data: [...m.cards.entries()]
              .filter(([, r]) => r.status === f.status && r.exec_status === f.exec_status && r.exec_class === f.exec_class)
              .map(([id, r]) => ({ id, ...r })),
            error: null,
          }),
      };
      return chain;
    },
  }),
}));
vi.mock("@/services/decisions/ad-budget", async (orig) => ({ ...(await orig<Record<string, unknown>>()), readActiveAdBudget: async () => ({ id: "b1" }) }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: async () => true }));
vi.mock("../unattended-policy", () => ({
  isExecutableAdClass: () => true,
  authorizeUnattended: async () => ({ verdict: "allow", reasons: [] }),
  askFounderAboutHeld: async () => true,
  recordCardHold: async () => true,
}));
vi.mock("../cgo-auto-run", () => ({ tenantOwnerId: async () => "owner-1" }));
vi.mock("@/services/channels/exec-actions", () => ({
  approveChannelAction: async (_t: string, a: { actionId: string; eventKey: string }) => {
    const card = m.cards.get(a.actionId)!;
    if (card.exec_status === "queued") return { ok: true, attempt: m.events.get(a.actionId) ?? 1, alreadyQueued: true, stillQueued: true, replayed: true };
    card.exec_status = "queued";
    card.approved_by_source = "cgo";
    m.events.set(a.actionId, 1);
    return { ok: true, attempt: 1, alreadyQueued: false, stillQueued: false, replayed: false };
  },
}));
vi.mock("@/../workers/client", () => ({
  inngest: {
    send: async (e: { id: string }) => {
      if (m.failSends > 0) {
        m.failSends--;
        m.sends.push({ id: e.id, ok: false });
        throw new Error("event bus down");
      }
      m.sends.push({ id: e.id, ok: true });
    },
  },
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("../cgo-blockers", () => ({ alertFounderSafely: (...a: unknown[]) => m.alert(...a) }));

import { settleLinkedinRunLaunchCards } from "../linkedin-run-verdict";

const launch = (run_id = "run-1") => ({
  channel_slug: "linkedin_ads",
  run_id,
  created_at: "2026-11-03T10:05:00Z",
  title: "Launch a LinkedIn campaign",
  exec_class: "linkedin_ads.launch_campaign",
  exec_payload: { origin: "agent", daily_budget_usd: 50 },
  exec_status: null,
  status: "pending",
  approved_by_source: null,
  edited_body: null,
  body: {},
});

beforeEach(() => {
  m.cards = new Map([["l1", launch()], ["l2", launch()]]);
  m.events = new Map();
  m.sends = [];
  m.failSends = 0;
  m.alert.mockReset();
  m.alert.mockResolvedValue({ sent: 1, urgent_ids: [] });
});

describe("Autopilot launch approval whose start event is lost (real cgo door)", () => {
  it("must-catch: one lost send is re-sent with the same event id, so the queued launch actually starts", async () => {
    m.failSends = 1;
    const out = await settleLinkedinRunLaunchCards(T, "run-1", { verdict: "here" });
    expect(out).toEqual({ approved: ["l1", "l2"], closed: [], unsent: [] });
    expect(m.sends).toEqual([
      { id: "approve:l1:1", ok: false },
      { id: "approve:l1:1", ok: true },
      { id: "approve:l2:1", ok: true },
    ]);
    expect(m.alert).not.toHaveBeenCalled();
  });

  it("must-catch: a send that keeps failing tells the founder and the next launch card is still approved and started", async () => {
    m.failSends = 2;
    const out = await settleLinkedinRunLaunchCards(T, "run-1", { verdict: "here" });
    expect(out).toEqual({ approved: ["l2"], closed: [], unsent: ["l1"] });
    expect(m.sends.filter((s) => s.ok).map((s) => s.id)).toEqual(["approve:l2:1"]);
    expect(m.alert).toHaveBeenCalledTimes(1);
    expect(m.alert.mock.calls[0][0]).toBe(T);
    expect(m.alert.mock.calls[0][2]).toEqual([expect.objectContaining({ id: "stuck:l1", action_id: "l1", notify_now: true })]);
    expect(String(m.alert.mock.calls[0][2][0].what)).not.toMatch(/inngest|event|queue|error/i);
  });
});
