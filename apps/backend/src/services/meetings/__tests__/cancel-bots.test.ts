import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  cancelBot: vi.fn(async (..._a: unknown[]): Promise<string> => "removed"),
  logEvent: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("@/services/meetings/recall", () => ({ cancelBot: m.cancelBot }));
vi.mock("../recall", () => ({ cancelBot: m.cancelBot }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.logEvent }));

import {
  cancelSentBots,
  cancelResponse,
  attachBotOrCallBack,
  CANCELLED_NOTE,
  IN_CALL_KEPT_NOTE,
  CANCEL_FAILED_MESSAGE,
  CANCEL_CHECK_FAILED_MESSAGE,
} from "../cancel-bots";

type Row = Record<string, unknown>;

function fakeDb(rows: Row[], opts: { lookupError?: string; failUpdates?: number } = {}) {
  const from = (_table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let patch: Row | null = null;
    const match = (r: Row) =>
      filters.every(([op, col, val]) => {
        if (op === "eq") return r[col] === val;
        if (op === "in") return (val as unknown[]).includes(r[col]);
        if (op === "is") return (r[col] ?? null) === val;
        if (op === "gte") return String(r[col]) >= String(val);
        return true;
      });
    const run = () => {
      const hit = rows.filter(match);
      if (patch) for (const r of hit) Object.assign(r, patch);
      return hit;
    };
    const awaited = () => {
      if (patch && (opts.failUpdates ?? 0) > 0) {
        opts.failUpdates = (opts.failUpdates ?? 0) - 1;
        return { data: null, error: { message: "connection reset" } };
      }
      return { data: run().map((r) => ({ id: r.id })), error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Row) => ((patch = p), b),
      eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), b),
      in: (c: string, v: unknown) => (filters.push(["in", c, v]), b),
      is: (c: string, v: unknown) => (filters.push(["is", c, v]), b),
      gte: (c: string, v: unknown) => (filters.push(["gte", c, v]), b),
      order: () => b,
      limit: async (n: number) =>
        opts.lookupError ? { data: null, error: { message: opts.lookupError } } : { data: run().slice(0, n).map((r) => ({ ...r })), error: null },
      maybeSingle: async () => {
        const r = run()[0];
        return { data: r ? { ...r } : null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) => resolve(awaited()),
    };
    return b;
  };
  return { from } as never;
}

const RECENT = "2026-10-27T15:55:00.000Z";
const bot = (over: Row): Row => ({
  tenant_id: "t-1",
  source: "scheduled",
  status: "scheduled",
  error: null,
  provider_bot_id: `r-${String(over.id)}`,
  scheduled_for: RECENT,
  media_deleted_at: null,
  ...over,
});

beforeEach(() => {
  m.cancelBot.mockReset();
  m.cancelBot.mockResolvedValue("removed");
  m.logEvent.mockClear();
});

describe("cancelSentBots — Notetaker turned off", () => {
  it("calls back this tenant's live bots, scheduled and summoned, joining or in the call, however old; never another tenant's or an ended one", async () => {
    const rows = [
      bot({ id: "a" }),
      bot({ id: "b", source: "adhoc", status: "in_call" }),
      bot({ id: "c", status: "ingested" }),
      bot({ id: "d", status: "failed", error: "meeting_not_found" }),
      bot({ id: "e", status: "call_ended" }),
      bot({ id: "f", tenant_id: "t-2" }),
      bot({ id: "g", status: "in_call", scheduled_for: "2026-10-26T10:00:00.000Z" }),
      bot({ id: "h", status: "in_call", scheduled_for: "2026-10-27T10:00:00.000Z" }),
    ];
    const before = JSON.parse(JSON.stringify(rows)) as Row[];
    const summary = await cancelSentBots(fakeDb(rows), "t-1", "notetaker_off");

    expect(summary).toEqual({ cancelled: 4, failed: 0, kept_in_call: 0 });
    expect(m.cancelBot.mock.calls).toEqual([
      ["r-a", { leaveIfInCall: true }],
      ["r-b", { leaveIfInCall: true }],
      ["r-g", { leaveIfInCall: true }],
      ["r-h", { leaveIfInCall: true }],
    ]);
    for (const id of ["a", "b", "g", "h"]) {
      expect(rows.find((r) => r.id === id)).toMatchObject({ status: "cancelled", error: "cancelled_notetaker_off" });
    }
    for (const id of ["c", "d", "e", "f"]) {
      expect(rows.find((r) => r.id === id)).toEqual(before.find((r) => r.id === id));
    }
    expect(cancelResponse(summary)).toEqual({ note: CANCELLED_NOTE });
    expect(m.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "info", code: "meeting_bot.cancelled", tenant_id: "t-1", meta: expect.objectContaining({ object_id: "a" }) }),
    );
  });

  it("a bot deleted before it joined has no media at Recall; one told to leave keeps its media for the cleanup sweep", async () => {
    const rows = [bot({ id: "a" }), bot({ id: "b", source: "adhoc", status: "joining" })];
    m.cancelBot.mockImplementation(async (id: unknown) => (id === "r-a" ? "deleted" : "removed"));
    await cancelSentBots(fakeDb(rows), "t-1", "notetaker_off");
    expect(rows[0].media_deleted_at).toEqual(expect.any(String));
    expect(rows[1].media_deleted_at).toBeNull();
  });

  it("a row whose Recall bot is not attached yet is cancelled without calling Recall (the scheduler calls it back)", async () => {
    const rows = [bot({ id: "a", provider_bot_id: null })];
    const summary = await cancelSentBots(fakeDb(rows), "t-1", "notetaker_off");
    expect(summary.cancelled).toBe(1);
    expect(m.cancelBot).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: "cancelled", error: "cancelled_notetaker_off" });
  });

  it("Recall failure: the row is still cancelled (nothing from it is saved), the failure is logged, the save says remove it by hand, and the next save retries", async () => {
    const rows = [bot({ id: "a", status: "joining" })];
    m.cancelBot.mockRejectedValueOnce(new Error("recall leave call 400: nope"));

    const first = await cancelSentBots(fakeDb(rows), "t-1", "notetaker_off");
    expect(first).toEqual({ cancelled: 0, failed: 1, kept_in_call: 0 });
    expect(rows[0]).toMatchObject({ status: "cancelled", error: "cancel_failed" });
    expect(cancelResponse(first)).toEqual({ cancel_error: CANCEL_FAILED_MESSAGE });
    expect(m.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", code: "meeting_bot.cancel_failed", tenant_id: "t-1", meta: expect.objectContaining({ object_id: "a", stage: "failed" }) }),
    );

    const retry = await cancelSentBots(fakeDb(rows), "t-1", "notetaker_off");
    expect(retry).toEqual({ cancelled: 1, failed: 0, kept_in_call: 0 });
    expect(rows[0]).toMatchObject({ status: "cancelled", error: "cancelled_notetaker_off" });

    m.cancelBot.mockClear();
    const third = await cancelSentBots(fakeDb(rows), "t-1", "notetaker_off");
    expect(third).toEqual({ cancelled: 0, failed: 0, kept_in_call: 0 });
    expect(m.cancelBot).not.toHaveBeenCalled();
    expect(cancelResponse(third)).toEqual({});
  });

  it("rows already handled never use up the row cap: a live bot behind 25 cancelled ones is still called back", async () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => bot({ id: `x${i}`, status: "cancelled", error: "cancelled_notetaker_off" })),
      bot({ id: "live", status: "joining" }),
    ];
    expect(await cancelSentBots(fakeDb(rows), "t-1", "notetaker_off")).toEqual({ cancelled: 1, failed: 0, kept_in_call: 0 });
    expect(m.cancelBot.mock.calls).toEqual([["r-live", { leaveIfInCall: true }]]);
  });

  it("a row a webhook moved to failed while Recall was being called is still marked cancelled", async () => {
    const rows = [bot({ id: "a", status: "in_call" })];
    m.cancelBot.mockImplementationOnce(async () => {
      rows[0].status = "failed";
      return "removed";
    });
    expect(await cancelSentBots(fakeDb(rows), "t-1", "notetaker_off")).toEqual({ cancelled: 1, failed: 0, kept_in_call: 0 });
    expect(rows[0]).toMatchObject({ status: "cancelled", error: "cancelled_notetaker_off" });
  });

  it("a failed lookup throws, and the save says it could not check", async () => {
    await expect(cancelSentBots(fakeDb([], { lookupError: "timeout" }), "t-1", "notetaker_off")).rejects.toThrow(/timeout/);
    expect(cancelResponse(null)).toEqual({ cancel_error: CANCEL_CHECK_FAILED_MESSAGE });
  });
});

describe("cancelSentBots — meeting link cleared (Notetaker stays on)", () => {
  it("calls back only the scheduled bot that has not got in; summoned bots are untouched", async () => {
    const rows = [bot({ id: "a", status: "joining" }), bot({ id: "b", source: "adhoc", status: "scheduled" })];
    const summary = await cancelSentBots(fakeDb(rows), "t-1", "link_cleared");
    expect(summary).toEqual({ cancelled: 1, failed: 0, kept_in_call: 0 });
    expect(m.cancelBot.mock.calls).toEqual([["r-a", { leaveIfInCall: false }]]);
    expect(rows[0]).toMatchObject({ status: "cancelled", error: "cancelled_link_cleared" });
    expect(rows[1].status).toBe("scheduled");
  });

  it("keeps a scheduled bot already in the call, and tells the team how to remove it", async () => {
    const inCall = [bot({ id: "a", status: "in_call" })];
    const kept = await cancelSentBots(fakeDb(inCall), "t-1", "link_cleared");
    expect(kept).toEqual({ cancelled: 0, failed: 0, kept_in_call: 1 });
    expect(m.cancelBot).not.toHaveBeenCalled();
    expect(inCall[0].status).toBe("in_call");
    expect(cancelResponse(kept)).toEqual({ note: IN_CALL_KEPT_NOTE });

    m.cancelBot.mockResolvedValueOnce("in_call");
    const lagging = [bot({ id: "b", status: "joining" })];
    expect(await cancelSentBots(fakeDb(lagging), "t-1", "link_cleared")).toEqual({ cancelled: 0, failed: 0, kept_in_call: 1 });
    expect(lagging[0].status).toBe("joining");
  });
});

describe("attachBotOrCallBack — a bot made while a save lands", () => {
  it("attaches Recall's bot while the row is still scheduled", async () => {
    const rows = [bot({ id: "a", provider_bot_id: null })];
    expect(await attachBotOrCallBack(fakeDb(rows), "t-1", "a", "r-new", "test")).toBe("attached");
    expect(rows[0]).toMatchObject({ status: "scheduled", provider_bot_id: "r-new" });
    expect(m.cancelBot).not.toHaveBeenCalled();
  });

  it("never attaches to another tenant's row", async () => {
    const rows = [bot({ id: "a", tenant_id: "t-2", provider_bot_id: null })];
    expect(await attachBotOrCallBack(fakeDb(rows), "t-1", "a", "r-new", "test")).toBe("cancelled");
    expect(rows[0].provider_bot_id).toBeNull();
    expect(m.cancelBot).toHaveBeenCalledWith("r-new", { leaveIfInCall: true });
  });

  it("the row was cancelled meanwhile: calls the bot back and keeps Recall's id on the cancelled row", async () => {
    const rows = [bot({ id: "a", status: "cancelled", error: "cancelled_notetaker_off", provider_bot_id: null })];
    expect(await attachBotOrCallBack(fakeDb(rows), "t-1", "a", "r-new", "test")).toBe("cancelled");
    expect(m.cancelBot).toHaveBeenCalledWith("r-new", { leaveIfInCall: true });
    expect(rows[0]).toMatchObject({ status: "cancelled", error: "cancelled_notetaker_off", provider_bot_id: "r-new" });
  });

  it("the attach write fails: the untracked bot is called back and the row becomes cancelled (attach_failed)", async () => {
    const rows = [bot({ id: "a", provider_bot_id: null })];
    expect(await attachBotOrCallBack(fakeDb(rows, { failUpdates: 1 }), "t-1", "a", "r-new", "test")).toBe("attach_failed");
    expect(m.cancelBot).toHaveBeenCalledWith("r-new", { leaveIfInCall: true });
    expect(rows[0]).toMatchObject({ status: "cancelled", error: "attach_failed", provider_bot_id: "r-new" });
  });

  it("if the row cannot be written even after a retry, the Recall bot id is logged loudly", async () => {
    const rows = [bot({ id: "a", provider_bot_id: null })];
    expect(await attachBotOrCallBack(fakeDb(rows, { failUpdates: 3 }), "t-1", "a", "r-new", "test")).toBe("attach_failed");
    expect(m.cancelBot).toHaveBeenCalledWith("r-new", { leaveIfInCall: true });
    expect(m.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", code: "meeting_bot.untracked", tenant_id: "t-1", message: expect.stringContaining("r-new") }),
    );
  });

  it("a call-back Recall refuses is marked cancel_failed (retried by the reconcile cron) and logged", async () => {
    const rows = [bot({ id: "a", status: "cancelled", error: "cancelled_notetaker_off", provider_bot_id: null })];
    m.cancelBot.mockRejectedValueOnce(new Error("recall leave call 400"));
    expect(await attachBotOrCallBack(fakeDb(rows), "t-1", "a", "r-new", "test")).toBe("cancelled");
    expect(rows[0]).toMatchObject({ status: "cancelled", error: "cancel_failed", provider_bot_id: "r-new" });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "meeting_bot.cancel_failed", tenant_id: "t-1" }));
  });
});
