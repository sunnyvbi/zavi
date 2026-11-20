import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  rows: [] as { id: string; tenant_id: string; campaign_binding_id: string }[],
  error: null as unknown,
  resolve: vi.fn(),
  pause: vi.fn(),
  stops: [] as { tenant_id: string; campaign_binding_id: string }[],
  gone: [] as { tenant_id: string; campaign_binding_id: string }[],
  expired: [] as { tenant_id: string; campaign_binding_id: string; created_at: string }[],
  expire: vi.fn(),
  recheck: vi.fn(),
  log: vi.fn(),
  bounds: [] as string[],
  binding: vi.fn(),
  filters: [] as unknown[],
  notes: [] as any[],
  sent: [] as { tenant_id: string; note_id: string }[],
}));
vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_config: unknown, _trigger: unknown, handler: unknown) =>
      handler,
  },
}));
vi.mock("@/services/ads-wallet/bindings", () => ({
  getCampaignBinding: m.binding,
}));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({
  isLinkedinPauseChecking: (e: { meta?: { checking?: boolean } }) => e?.meta?.checking === true,
  reconcileLinkedinOperation: m.resolve,
  pauseLinkedinBoundCampaign: m.pause,
  recheckGoneLinkedinCampaign: m.recheck,
  expireLinkedinGoneRecheck: m.expire,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));
vi.mock("@/services/tenant-client", () => ({
  fleetSweepClient: () => ({
    from: (table: string) => {
      let finalize = false;
      let past = false;
      const q: any = {
        select: () => q,
        order: () => q,
        in: (...args: unknown[]) => {
          m.filters.push(args);
          return q;
        },
        eq: (...args: unknown[]) => {
          m.filters.push(args);
          if (args[0] === "kind" && args[1] === "finalize") finalize = true;
          return q;
        },
        lte: (_c: string, v: string) => ((past = true), m.bounds.push(`lte:${v}`), q),
        lt: (_c: string, v: string) => (finalize && m.bounds.push(`lt:${v}`), q),
        gt: (_c: string, v: string) => (finalize && m.bounds.push(`gt:${v}`), q),
        range: async (start: number, end: number) => ({
          data: (table === "ads_campaign_pending_stops"
            ? m.stops
            : past
              ? m.expired
              : finalize
                ? m.gone
                : m.rows
          ).slice(start, end + 1),
          error: m.error,
        }),
      };
      return q;
    },
  }),
}));
vi.mock("@/services/growth/cgo-blockers", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/services/growth/cgo-blockers")>();
  return {
    ...real,
    alertFounderSafely: vi.fn(
      async (tenant_id: string, _why: string, extra: readonly unknown[]) =>
        real.alertUrgentBlockers(
          tenant_id,
          {
            now: () => new Date(),
            flush: async () => 0,
            sources: async () => ({
              questions: [],
              failedCards: [],
              leftCards: [],
              chainRoots: new Map(),
              connectors: [],
              metaNotReady: null,
              metaAccountBlocked: null,
              runningAds: false,
              spendStaleSince: null,
              stoppedBudgets: [],
              stuck: [],
            }),
            told: async (t: string) =>
              m.notes
                .filter((n) => n.tenant_id === t && n.delivered)
                .map((n) => ({
                  items: n.items,
                  created_at: n.created_at,
                  alarm_keys: n.keys,
                })),
            writeNote: async (t: string, note: any) => {
              if (
                m.notes.some(
                  (n) =>
                    n.tenant_id === t &&
                    n.notification_key === note.notification_key,
                )
              )
                return null;
              const id = `note-${m.notes.length + 1}`;
              m.notes.push({
                id,
                tenant_id: t,
                created_at: new Date().toISOString(),
                delivered: false,
                ...note,
              });
              return id;
            },
            send: async (t: string, note_id: string) => {
              m.sent.push({ tenant_id: t, note_id });
              const n = m.notes.find((x) => x.id === note_id);
              if (n) n.delivered = true;
            },
          },
          extra as any,
        ),
    ),
  };
});
import { adsCampaignOperationsFn } from "../ads-campaign-operations";
import { alertFounderSafely } from "@/services/growth/cgo-blockers";
const run = () =>
  (adsCampaignOperationsFn as unknown as (ctx: unknown) => Promise<unknown>)({
    step: { run: (_name: string, cb: () => unknown) => cb() },
  });
beforeEach(() => {
  vi.clearAllMocks();
  m.resolve.mockReset();
  m.pause.mockReset();
  m.binding.mockReset();
  m.recheck.mockReset();
  m.log.mockReset();
  m.log.mockResolvedValue(undefined);
  m.gone = [];
  m.expired = [];
  m.expire.mockReset();
  m.expire.mockResolvedValue(undefined);
  m.bounds = [];
  m.filters = [];
  m.notes = [];
  m.sent = [];
  m.stops = [];
  m.error = null;
  m.rows = [
    { id: "op", tenant_id: "own-only", campaign_binding_id: "original" },
  ];
  m.binding.mockImplementation(async (_tenant, id) => ({
    id,
    platform: "linkedin",
  }));
});
it("a stop waiting out the five minute 404 check is not a failed tick: no retry, no alarm, no founder alert", async () => {
  m.rows = [];
  m.stops = [{ tenant_id: "t", campaign_binding_id: "own", stop_requested_at: new Date(Date.now() - 86400_000 * 3).toISOString() } as never];
  m.pause.mockRejectedValue(Object.assign(new Error("checking"), { meta: { checking: true } }));
  await expect(run()).resolves.toEqual({ checked: 0 });
  expect(m.pause).toHaveBeenCalledTimes(1);
  expect(alertFounderSafely).not.toHaveBeenCalled();
});
it("a stuck launch whose protective stop is waiting out the 404 check is not a failed tick either", async () => {
  m.resolve.mockRejectedValue(Object.assign(new Error("checking"), { meta: { checking: true } }));
  await expect(run()).resolves.toEqual({ checked: 1 });
  expect(alertFounderSafely).not.toHaveBeenCalled();
});
it("any other pause failure still fails the tick", async () => {
  m.rows = [];
  m.stops = [{ tenant_id: "t", campaign_binding_id: "own" }];
  m.pause.mockRejectedValue(new Error("LinkedIn 500"));
  await expect(run()).rejects.toThrow("need reconciliation");
});
it("re-reads provider-billed gone campaigns from 72 hours to 7 days old, only those marked due", async () => {
  m.rows = [];
  m.gone = [{ tenant_id: "t", campaign_binding_id: "own-gone" }];
  m.recheck.mockResolvedValue("gone");
  const before = Date.now();
  await run();
  expect(m.recheck).toHaveBeenCalledTimes(1);
  expect(m.recheck).toHaveBeenCalledWith("t", "own-gone");
  expect(m.filters).toContainEqual(["payload->>recheck", "due"]);
  const lt = Date.parse(m.bounds.find((b) => b.startsWith("lt:"))!.slice(3));
  const gt = Date.parse(m.bounds.find((b) => b.startsWith("gt:"))!.slice(3));
  expect(before - lt).toBeGreaterThanOrEqual(72 * 3600_000 - 1000);
  expect(before - lt).toBeLessThan(72 * 3600_000 + 5000);
  expect(before - gt).toBeGreaterThanOrEqual(7 * 86400_000 - 1000);
  expect(before - gt).toBeLessThan(7 * 86400_000 + 5000);
});
it("a re-read that fails is logged and neither fails the tick nor blocks the next one", async () => {
  m.rows = [];
  m.gone = [{ tenant_id: "t", campaign_binding_id: "a" }, { tenant_id: "t", campaign_binding_id: "b" }];
  m.recheck.mockRejectedValueOnce(new Error("LinkedIn 500")).mockResolvedValueOnce("gone");
  await expect(run()).resolves.toEqual({ checked: 0 });
  expect(m.recheck).toHaveBeenCalledTimes(2);
  expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ code: "ads_wallet.gone_recheck_failed", tenant_id: "t" }));
});
it("a re-read still failing after 7 days tells the founder once, stops re-reading, and never drops out silently", async () => {
  m.rows = [];
  m.expired = [{ tenant_id: "t-gone", campaign_binding_id: "own-gone", created_at: ago(8 * 24 * 60) }];
  m.recheck.mockRejectedValue(new Error("LinkedIn token revoked"));
  const before = Date.now();
  await expect(run()).resolves.toEqual({ checked: 0 });
  expect(m.sent).toEqual([{ tenant_id: "t-gone", note_id: "note-1" }]);
  expect(m.notes[0].items).toEqual([expect.objectContaining({ blocker_id: "stuck:linkedin_gone_recheck:own-gone", blocker_severity: "urgent", text: expect.stringContaining("may still be spending") })]);
  expect(m.expire).toHaveBeenCalledWith("t-gone", "own-gone");
  const lte = Date.parse(m.bounds.find((b) => b.startsWith("lte:"))!.slice(4));
  expect(before - lte).toBeGreaterThanOrEqual(7 * 86400_000 - 1000);
  expect(before - lte).toBeLessThan(7 * 86400_000 + 5000);
});
it("the last re-read at 7 days still counts: an answer closes it with nothing to tell the founder", async () => {
  m.rows = [];
  m.expired = [{ tenant_id: "t-gone", campaign_binding_id: "own-gone", created_at: ago(8 * 24 * 60) }];
  m.recheck.mockResolvedValue("gone");
  await run();
  expect(m.sent).toEqual([]);
  expect(m.expire).not.toHaveBeenCalled();
});
it("a founder alert that could not go out keeps the re-read due, so it is not closed unseen", async () => {
  m.rows = [];
  m.expired = [{ tenant_id: "t-gone", campaign_binding_id: "own-gone", created_at: ago(8 * 24 * 60) }];
  m.recheck.mockRejectedValue(new Error("LinkedIn 500"));
  vi.mocked(alertFounderSafely).mockResolvedValueOnce(null as never);
  await expect(run()).resolves.toEqual({ checked: 0 });
  expect(m.expire).not.toHaveBeenCalled();
  expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ code: "ads_wallet.gone_recheck_failed", tenant_id: "t-gone" }));
});
it("recovers provider-funded campaigns without relying on a wallet or current account selection", async () => {
  expect(await run()).toEqual({ checked: 1 });
  expect(m.binding).toHaveBeenCalledWith("own-only", "original");
  expect(m.resolve).toHaveBeenCalledWith("own-only", "original");
  expect(m.filters).toContainEqual(["status", ["pending", "uncertain"]]);
  expect(m.filters).toContainEqual(["kind", "activate"]);
});
it("continues other recoveries but reports failures for monitoring and retries", async () => {
  m.rows.push({ id: "op-2", tenant_id: "t2", campaign_binding_id: "c2" });
  m.resolve.mockRejectedValueOnce(new Error("Provider unavailable"));
  await expect(run()).rejects.toThrow(
    "1 campaign operations still need reconciliation",
  );
  expect(m.resolve).toHaveBeenCalledWith("t2", "c2");
});
it("reads every operation page before performing recovery", async () => {
  m.rows = Array.from({ length: 501 }, (_, i) => ({
    id: `op-${i}`,
    tenant_id: "t",
    campaign_binding_id: `c-${i}`,
  }));
  expect(await run()).toEqual({ checked: 501 });
  expect(m.resolve).toHaveBeenCalledTimes(501);
});
it("refuses to treat a database error as an empty recovery queue", async () => {
  m.error = { message: "unavailable" };
  await expect(run()).rejects.toThrow("inventory is unavailable");
  expect(m.resolve).not.toHaveBeenCalled();
});

it("retries consent-withdrawal stops even for customer campaigns without wallet operations", async () => {
  m.rows = [];
  m.stops = [{ tenant_id: "own-only", campaign_binding_id: "original" }];
  await run();
  expect(m.pause).toHaveBeenCalledWith("own-only", "original", false);
});
it("reports provider stop failures for retry without hiding other work", async () => {
  m.stops = [{ tenant_id: "own-only", campaign_binding_id: "original" }];
  m.pause.mockRejectedValue(new Error("timeout"));
  await expect(run()).rejects.toThrow("1 campaign operations");
  expect(m.resolve).toHaveBeenCalled();
});
it("retries a customer-only stop on the next run after a LinkedIn outage", async () => {
  m.rows = [];
  m.stops = [{ tenant_id: "own-only", campaign_binding_id: "original" }];
  m.pause.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  await expect(run()).rejects.toThrow("1 campaign operations");
  await expect(run()).resolves.toEqual({ checked: 0 });
  expect(m.pause).toHaveBeenCalledTimes(2);
  expect(m.pause).toHaveBeenLastCalledWith("own-only", "original", false);
  expect(m.resolve).not.toHaveBeenCalled();
});

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
it("tells the founder once about a LinkedIn pause stuck past the threshold, and not again on the next tick", async () => {
  m.rows = [];
  m.stops = [
    { tenant_id: "t-li", campaign_binding_id: "b-stuck", stop_requested_at: ago(45) } as any,
    { tenant_id: "t-li", campaign_binding_id: "b-fresh", stop_requested_at: ago(5) } as any,
  ];
  m.pause.mockRejectedValue(new Error("LinkedIn unavailable"));
  await expect(run()).rejects.toThrow("2 campaign operations");
  expect(m.sent).toEqual([{ tenant_id: "t-li", note_id: "note-1" }]);
  expect(m.notes).toHaveLength(1);
  expect(m.notes[0].items).toEqual([
    expect.objectContaining({
      blocker_id: "stuck:linkedin_stop:b-stuck",
      blocker_severity: "urgent",
      text: expect.stringContaining("LinkedIn Ads"),
    }),
  ]);
  expect(m.notes[0].items[0].text).toContain(
    "Pause the campaign in LinkedIn Campaign Manager if it must stop now",
  );
  expect(m.notes[0].headline).toMatch(/^Needs you now: .*LinkedIn Ads/);
  expect(JSON.stringify(m.notes)).not.toContain("b-fresh");
  await expect(run()).rejects.toThrow("2 campaign operations");
  expect(m.pause).toHaveBeenCalledTimes(4);
  expect(m.sent).toHaveLength(1);
  expect(m.notes).toHaveLength(1);
});
it("tells the founder when a LinkedIn launch cannot be safely stopped past the threshold", async () => {
  m.rows = [
    { id: "op-old", tenant_id: "t-li", campaign_binding_id: "c1", created_at: ago(40) } as any,
    { id: "op-new", tenant_id: "t-li", campaign_binding_id: "c2", created_at: ago(12) } as any,
  ];
  m.resolve.mockRejectedValue(new Error("LinkedIn unavailable"));
  await expect(run()).rejects.toThrow("2 campaign operations");
  expect(m.sent).toHaveLength(1);
  expect(m.notes[0].items.map((i: any) => i.blocker_id)).toEqual([
    "stuck:linkedin_launch:op-old",
  ]);
  expect(m.notes[0].items[0].text).toContain("LinkedIn Campaign Manager");
});
it("says nothing to the founder when the retry succeeds or the operation is not on LinkedIn", async () => {
  m.rows = [
    { id: "op-meta", tenant_id: "t-meta", campaign_binding_id: "m1", created_at: ago(90) } as any,
  ];
  m.binding.mockImplementation(async (_t, id) => ({ id, platform: "meta" }));
  m.stops = [
    { tenant_id: "t-li", campaign_binding_id: "b-ok", stop_requested_at: ago(90) } as any,
  ];
  m.pause.mockResolvedValue("paused");
  await expect(run()).rejects.toThrow("1 campaign operations");
  expect(alertFounderSafely).not.toHaveBeenCalled();
  expect(m.sent).toEqual([]);
});

const INTERRUPT = Symbol("step-scheduled");
const replayRun = async () => {
  const memo = new Map<string, { ok: true; data: unknown } | { ok: false; error: Error }>();
  const callbacks: string[] = [];
  for (let invocation = 0; invocation < 2000; invocation++) {
    let ranNew = false;
    const step = {
      run: async (id: string, cb: () => unknown) => {
        const saved = memo.get(id);
        if (saved) {
          if (saved.ok) return saved.data;
          throw new Error(saved.error.message);
        }
        if (ranNew) throw INTERRUPT;
        ranNew = true;
        callbacks.push(id);
        try {
          memo.set(id, { ok: true, data: JSON.parse(JSON.stringify((await cb()) ?? null)) });
        } catch (e) {
          memo.set(id, { ok: false, error: e as Error });
        }
        throw INTERRUPT;
      },
    };
    try {
      const value = await (adsCampaignOperationsFn as unknown as (ctx: unknown) => Promise<unknown>)({ step });
      return { outcome: "returned" as const, value, callbacks };
    } catch (e) {
      if (e === INTERRUPT) continue;
      return { outcome: "threw" as const, error: e as Error, callbacks };
    }
  }
  throw new Error("replay did not settle");
};
it("does not tell the founder about a stuck non-LinkedIn launch when Inngest replays the earlier steps", async () => {
  m.rows = [
    { id: "op-meta", tenant_id: "t-meta", campaign_binding_id: "m1", created_at: ago(90) } as any,
    { id: "op-li", tenant_id: "t-li", campaign_binding_id: "l1", created_at: ago(90) } as any,
  ];
  m.binding.mockImplementation(async (_t, id) => ({ id, platform: id === "m1" ? "meta" : "linkedin" }));
  m.resolve.mockRejectedValue(new Error("LinkedIn unavailable"));
  const r = await replayRun();
  expect(r.outcome).toBe("threw");
  expect(r.error?.message).toBe("2 campaign operations still need reconciliation");
  expect(r.callbacks.filter((id) => id === "recover-op-meta")).toHaveLength(1);
  expect(r.callbacks.filter((id) => id === "read-stuck-linkedin-funding")).toHaveLength(1);
  expect(m.binding).toHaveBeenCalledTimes(3);
  expect(m.resolve).toHaveBeenCalledTimes(1);
  expect(m.resolve).toHaveBeenCalledWith("t-li", "l1");
  expect(alertFounderSafely).toHaveBeenCalledTimes(1);
  expect(m.sent).toEqual([{ tenant_id: "t-li", note_id: "note-1" }]);
  expect(m.notes.map((n) => n.tenant_id)).toEqual(["t-li"]);
  expect(JSON.stringify(m.notes)).not.toContain("op-meta");
});
it("still alerts a LinkedIn launch whose binding could not be read, under replay", async () => {
  m.rows = [{ id: "op-x", tenant_id: "t-x", campaign_binding_id: "x1", created_at: ago(90) } as any];
  m.binding.mockRejectedValue(new Error("database unavailable"));
  const r = await replayRun();
  expect(r.error?.message).toBe("1 campaign operations still need reconciliation");
  expect(m.resolve).not.toHaveBeenCalled();
  expect(m.notes.map((n) => n.items.map((i: any) => i.blocker_id))).toEqual([["stuck:linkedin_launch:op-x"]]);
});
it("tells a founder once, with the count, when several LinkedIn pauses are stuck, and does not repeat a launch on a campaign whose pause is already reported", async () => {
  m.stops = [
    { tenant_id: "t-li", campaign_binding_id: "b1", stop_requested_at: ago(50) } as any,
    { tenant_id: "t-li", campaign_binding_id: "b2", stop_requested_at: ago(40) } as any,
    { tenant_id: "t-other", campaign_binding_id: "b3", stop_requested_at: ago(40) } as any,
  ];
  m.rows = [
    { id: "op-b1", tenant_id: "t-li", campaign_binding_id: "b1", created_at: ago(60) } as any,
  ];
  m.pause.mockRejectedValue(new Error("LinkedIn unavailable"));
  m.resolve.mockRejectedValue(new Error("LinkedIn unavailable"));
  const r = await replayRun();
  expect(r.error?.message).toBe("4 campaign operations still need reconciliation");
  expect(m.pause).toHaveBeenCalledTimes(3);
  expect(m.resolve).toHaveBeenCalledTimes(1);
  const li = m.notes.filter((n) => n.tenant_id === "t-li");
  expect(li).toHaveLength(1);
  expect(li[0].items).toHaveLength(1);
  expect(li[0].items[0].text).toContain("2 LinkedIn Ads campaign pauses did not finish");
  expect(li[0].items[0].text).toContain("LinkedIn Campaign Manager");
  expect(li[0].items[0].text).not.toMatch(/b1|b2|op-b1/);
  expect(m.notes.filter((n) => n.tenant_id === "t-other").map((n) => n.items[0].blocker_id)).toEqual(["stuck:linkedin_stop:b3"]);
  expect(m.sent).toHaveLength(2);
  m.sent = [];
  await replayRun();
  expect(m.sent).toEqual([]);
});
it("stays quiet when a stuck LinkedIn set shrinks or holds, and alerts once with the new count when a new campaign gets stuck", async () => {
  m.rows = [];
  m.stops = [
    { tenant_id: "t-li", campaign_binding_id: "b1", stop_requested_at: ago(60) } as any,
    { tenant_id: "t-li", campaign_binding_id: "b2", stop_requested_at: ago(50) } as any,
    { tenant_id: "t-li", campaign_binding_id: "b3", stop_requested_at: ago(40) } as any,
  ];
  m.pause.mockRejectedValue(new Error("LinkedIn unavailable"));
  await expect(run()).rejects.toThrow("3 campaign operations");
  expect(m.sent).toHaveLength(1);
  expect(m.notes[0].items[0].text).toContain("3 LinkedIn Ads campaign pauses did not finish");
  m.stops = m.stops.filter((s) => s.campaign_binding_id !== "b2");
  await expect(run()).rejects.toThrow("2 campaign operations");
  expect(m.sent).toHaveLength(1);
  expect(m.notes).toHaveLength(1);
  m.stops = m.stops.filter((s) => s.campaign_binding_id !== "b3");
  await expect(run()).rejects.toThrow("1 campaign operations");
  await expect(run()).rejects.toThrow("1 campaign operations");
  expect(m.sent).toHaveLength(1);
  expect(m.notes).toHaveLength(1);
  m.stops.push({ tenant_id: "t-li", campaign_binding_id: "b4", stop_requested_at: ago(35) } as any);
  await expect(run()).rejects.toThrow("2 campaign operations");
  expect(m.sent).toHaveLength(2);
  expect(m.notes).toHaveLength(2);
  expect(m.notes[1].items).toHaveLength(1);
  expect(m.notes[1].items[0].text).toContain("2 LinkedIn Ads campaign pauses did not finish");
  await expect(run()).rejects.toThrow("2 campaign operations");
  m.stops = m.stops.filter((s) => s.campaign_binding_id !== "b4");
  await expect(run()).rejects.toThrow("1 campaign operations");
  expect(m.sent).toHaveLength(2);
});
it("a stuck pause on a shared-wallet campaign never sends the founder to LinkedIn Campaign Manager; an own-billing one in the same tick still does", async () => {
  m.rows = [];
  m.stops = [
    { tenant_id: "t-mix", campaign_binding_id: "b-wallet", stop_requested_at: ago(45) } as any,
    { tenant_id: "t-mix", campaign_binding_id: "b-own", stop_requested_at: ago(50) } as any,
  ];
  m.binding.mockImplementation(async (_tenant, id) => ({ id, platform: "linkedin", funding_source: id === "b-wallet" ? "wallet" : "provider" }));
  m.pause.mockRejectedValue(new Error("LinkedIn unavailable"));
  await expect(run()).rejects.toThrow("2 campaign operations");
  const items = m.notes.flatMap((n) => n.items);
  const wallet = items.find((i: any) => i.blocker_id === "stuck:linkedin_stop_wallet:b-wallet");
  const own = items.find((i: any) => i.blocker_id === "stuck:linkedin_stop:b-own");
  expect(wallet?.text).toContain("Zavi ads balance");
  expect(wallet?.text).not.toMatch(/Campaign Manager|ad platform/);
  expect(own?.text).toContain("Pause the campaign in LinkedIn Campaign Manager if it must stop now");
});
it("a stuck wallet launch whose funding cannot be read keeps the own-billing wording rather than staying silent", async () => {
  m.rows = [{ id: "op-w", tenant_id: "t-w", campaign_binding_id: "w1", created_at: ago(90) } as any];
  m.resolve.mockRejectedValue(new Error("LinkedIn unavailable"));
  m.binding.mockImplementationOnce(async (_tenant, id) => ({ id, platform: "linkedin", funding_source: "wallet" })).mockRejectedValue(new Error("database unavailable"));
  await expect(run()).rejects.toThrow("1 campaign operations");
  expect(m.notes.map((n) => n.items.map((i: any) => i.blocker_id))).toEqual([["stuck:linkedin_launch:op-w"]]);
});
