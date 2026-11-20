import { describe, it, expect, vi } from "vitest";

const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
let tables: Record<string, unknown> | null = null;
function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const op of ["select", "eq", "gte", "limit", "maybeSingle"]) {
    b[op] = (...args: unknown[]) => {
      calls.push({ table, op, args });
      return op === "limit" || op === "maybeSingle" ? Promise.resolve({ data: tables![table], error: null }) : b;
    };
  }
  return b;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    if (!tables) throw new Error("no db in this test");
    return { from: (t: string) => builder(t) };
  },
}));

import { homePhrase, readCardState, whereTheFounderApproves, withCardLocation, type CardState } from "../card-location";

const growth: CardState = { table: "decisions", status: "proposed", approved_by_source: null, home: { kind: "growth" }, in_chat: false };

describe("whereTheFounderApproves", () => {
  it("the incident's held cut: a growth-home decision with no chat card points at Your CGO, never Needs you", () => {
    const s = whereTheFounderApproves(growth);
    expect(s).toBe("The founder approves it on its card under What needs you on the Your CGO page. No card was shown in this chat.");
    expect(s).not.toMatch(/Needs you tab/);
  });

  it("a card shown in this chat is named first", () => {
    expect(whereTheFounderApproves({ ...growth, in_chat: true })).toBe(
      "The founder approves it on the card shown in this chat. It is also listed under What needs you on the Your CGO page.",
    );
  });

  it("a channel card and a needs_you decision name their own homes", () => {
    expect(whereTheFounderApproves({ ...growth, table: "channel_actions", status: "pending", home: { kind: "channel", slug: "google_ads" } })).toBe(
      "The founder approves it on its card on the Google Ads channel page. No card was shown in this chat.",
    );
    expect(homePhrase({ kind: "needs_you" })).toBe("in the Needs you tab");
  });

  it("nothing to tap once Autopilot approved it or it closed", () => {
    expect(whereTheFounderApproves({ ...growth, status: "approved", approved_by_source: "cgo" })).toBe("Autopilot approved this change. There is no card for the founder to tap.");
    expect(whereTheFounderApproves({ ...growth, table: "channel_actions", status: "acted", approved_by_source: "cgo" })).toMatch(/^Autopilot approved/);
    expect(whereTheFounderApproves({ ...growth, status: "rejected" })).toBe("This change is not waiting for the founder. There is no card to tap.");
  });
});

describe("withCardLocation", () => {
  it("adds the sentence to a result that filed a card", async () => {
    const read = vi.fn(async () => growth);
    const out = (await withCardLocation("t1", { decision_id: "d1", decision_class: "google_ads.update_campaign_budget_review" }, "decisions", "2026-10-18T04:15:00.000Z", read)) as Record<string, unknown>;
    expect(read).toHaveBeenCalledWith("t1", "d1", "decisions", "2026-10-18T04:15:00.000Z", undefined);
    expect(out.where_the_founder_approves).toMatch(/Your CGO page/);
    expect(out.decision_id).toBe("d1");
  });

  it("must not touch: no decision id, or a read that failed, leaves the result as it was", async () => {
    const read = vi.fn(async () => null);
    const refused = { ok: false, blocked: true, code: "x" };
    expect(await withCardLocation("t1", refused, "decisions", undefined, read)).toBe(refused);
    expect(read).not.toHaveBeenCalled();
    const filed = { decision_id: "d2" };
    expect(await withCardLocation("t1", filed, "decisions", undefined, read)).toBe(filed);
  });

  it("bug #14: a chat turn's waiting channel card is shown in that chat, and 'in this chat' means this thread", async () => {
    const read = vi.fn(async () => ({ ...growth, table: "channel_actions" as const, status: "pending", home: { kind: "channel" as const, slug: "google_ads" }, in_chat: true }));
    const attach = vi.fn(async () => ({ shown: true }));
    const target = vi.fn(async () => ({ thread_id: "th1" }));
    const out = (await withCardLocation("t1", { decision_id: "a1" }, "channel_actions", "2026-10-18T04:15:00.000Z", { read, attach, target }, { run_id: "r1", trigger: "chat" })) as Record<string, unknown>;
    expect(attach).toHaveBeenCalledWith({ tenant_id: "t1", run_id: "r1", card_id: "a1", table: "channel_actions" });
    expect(read).toHaveBeenCalledWith("t1", "a1", "channel_actions", "2026-10-18T04:15:00.000Z", "th1");
    expect(out.where_the_founder_approves).toMatch(/^The founder approves it on the card shown in this chat/);
  });

  it("must-not-touch: a failed show never fails the filed proposal; it is handed to delivery", async () => {
    const read = vi.fn(async () => ({ ...growth, table: "channel_actions" as const, status: "pending", home: { kind: "channel" as const, slug: "google_ads" } }));
    const attach = vi.fn(async () => {
      throw new Error("db down");
    });
    const handOff = vi.fn(async () => true);
    const target = vi.fn(async () => ({ thread_id: "th1" }));
    const out = (await withCardLocation("t1", { decision_id: "a1" }, "channel_actions", undefined, { read, attach, target, handOff }, { run_id: "r1", trigger: "chat" })) as Record<string, unknown>;
    expect(handOff).toHaveBeenCalledWith(expect.objectContaining({ card_id: "a1", run_id: "r1", table: "channel_actions" }));
    expect(out.where_the_founder_approves).toMatch(/No card was shown in this chat\. praxis__show_card with this id shows it here\./);
  });

  it("must-not-touch: a decisions card is never attached here (the runner does it around the cgo door), and a non-chat run is not offered show_card", async () => {
    const read = vi.fn(async () => growth);
    const attach = vi.fn(async () => ({ shown: true }));
    const target = vi.fn(async () => ({ thread_id: "th1" }));
    await withCardLocation("t1", { decision_id: "d1" }, "decisions", undefined, { read, attach, target }, { run_id: "r1", trigger: "chat" });
    expect(attach).not.toHaveBeenCalled();
    const out = (await withCardLocation("t1", { decision_id: "d1" }, "decisions", undefined, { read, attach, target }, { run_id: "r1", trigger: "a2a" })) as Record<string, unknown>;
    expect(target).toHaveBeenCalledTimes(1);
    expect(out.where_the_founder_approves).toBe("The founder approves it on its card under What needs you on the Your CGO page. No card was shown in this chat.");
    await withCardLocation("t1", { decision_id: "a1" }, "channel_actions", undefined, { read, attach, target }, { run_id: "r1", trigger: "chat", writes_suppressed: true });
    expect(attach).not.toHaveBeenCalled();
  });

  it("a database that throws reads as no location, never a throw", async () => {
    tables = null;
    await expect(readCardState("t1", "d1", "decisions")).resolves.toBeNull();
  });

  it("reads the stored home, and counts a chat card only when this call wrote it", async () => {
    calls.length = 0;
    tables = { decisions: { status: "proposed", decision_class: "google_ads.update_campaign_budget_review", home: "growth", home_channel: null, approved_by_source: null }, thread_event: [] };
    const s = await readCardState("t1", "d1", "decisions", "2026-10-18T04:15:00.000Z");
    expect(s).toEqual({ table: "decisions", status: "proposed", approved_by_source: null, home: { kind: "growth" }, in_chat: false });
    expect(calls).toContainEqual({ table: "thread_event", op: "gte", args: ["created_at", "2026-10-18T04:15:00.000Z"] });
    expect(calls).toContainEqual({ table: "decisions", op: "eq", args: ["tenant_id", "t1"] });
    tables = { decisions: { status: "proposed", decision_class: "meta_ads.update_ad_set_budget_review", home: "channel", home_channel: "meta_ads", approved_by_source: null }, thread_event: [{ id: "e1" }] };
    expect(await readCardState("t1", "d1", "decisions")).toMatchObject({ home: { kind: "channel", slug: "meta_ads" }, in_chat: true });
    tables = null;
  });
});
