import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
const tell = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/services/approvals/chat-card-delivery", () => ({ tellFounderAboutCard: tell }));

import { founderOrderEmit, serverFounderMarks, REVIEW_SIBLING, AUTO_OF } from "../founder-order";
import { logEvent } from "@/services/logging/logEvent";

const T = "tenant-A";
const founder = { tenant_id: T, run_trigger: "chat", founder_chat_order: true };

function recorder() {
  const calls: Array<[string, unknown]> = [];
  const emit = vi.fn(async (cls: string, body: unknown) => {
    calls.push([cls, body]);
    return "d-1";
  });
  return { emit, calls };
}

describe("founderOrderEmit", () => {
  beforeEach(() => {
    vi.mocked(logEvent).mockClear();
  });

  it("stamps the founder origin and files each auto class as its review twin", async () => {
    for (const [auto, review] of Object.entries(REVIEW_SIBLING)) {
      const r = recorder();
      await founderOrderEmit(founder, r.emit)!(auto, { campaign_id: "1" });
      expect(r.calls[0]).toEqual([review, { campaign_id: "1", origin: "user_initiated_chat", founder_chat_order: true }]);
      expect(AUTO_OF[review]).toBe(auto);
    }
  });

  it("a Meta fast-path body goes out as the review twin with no authorized cap", async () => {
    const r = recorder();
    await founderOrderEmit(founder, r.emit)!("meta_ads.update_ad_set_budget", {
      ad_set_id: "as-1",
      daily_budget_usd: 50,
      origin: "user_initiated_chat",
      authorized_effective_cap: { max_daily_budget_usd: 1000 },
    });
    expect(r.calls[0][0]).toBe("meta_ads.update_ad_set_budget_review");
    expect(r.calls[0][1]).not.toHaveProperty("authorized_effective_cap");
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ code: "founder_order.stamped", meta: expect.objectContaining({ rerouted: 1, cap_stripped: 1 }) }),
    );
  });

  it("keeps a ledger origin and a class that is already a review class", async () => {
    const r = recorder();
    await founderOrderEmit(founder, r.emit)!("google_ads.add_keywords", { origin: "user_initiated_ledger", negative: true });
    expect(r.calls[0]).toEqual(["google_ads.add_keywords", { origin: "user_initiated_ledger", negative: true, founder_chat_order: true }]);
  });

  it("on the channel_actions rail keeps the class (the tile already waits) but stamps the origin", async () => {
    const r = recorder();
    await founderOrderEmit(founder, r.emit, "channel_actions")!("google_ads.update_campaign_budget", { campaign_id: "1" });
    expect(r.calls[0]).toEqual(["google_ads.update_campaign_budget", { campaign_id: "1", origin: "user_initiated_chat", founder_chat_order: true }]);
  });

  it("a marked handoff child of the founder's turn is stamped too", async () => {
    const r = recorder();
    await founderOrderEmit({ tenant_id: T, run_trigger: "handoff", founder_chat_order: true }, r.emit)!("google_ads.update_campaign_budget", { campaign_id: "1" });
    expect(r.calls[0][0]).toBe("google_ads.update_campaign_budget_review");
  });

  it("a run that is not a founder chat order files its body as is, minus any founder mark a tool or the model put in it", async () => {
    for (const t of [
      { tenant_id: T, run_trigger: "chat" },
      { tenant_id: T, run_trigger: "email", founder_chat_order: true },
      { tenant_id: T, run_trigger: "chat", founder_chat_order: true, captured_page_context: true },
      { tenant_id: T, run_trigger: "chat", founder_chat_order: true, untrusted_context: true },
      { tenant_id: T, run_trigger: "a2a", founder_chat_order: true },
    ]) {
      const r = recorder();
      await founderOrderEmit(t, r.emit)!("google_ads.update_campaign_budget", {
        campaign_id: "1",
        origin: "agent",
        founder_chat_order: true,
        founder_order_unverified: true,
        move_group: "forged",
      });
      expect(r.calls).toEqual([["google_ads.update_campaign_budget", { campaign_id: "1", origin: "agent" }]]);
      const other = recorder();
      await founderOrderEmit(t, other.emit)!("tiktok_ads.launch", { a: 1, founder_chat_order: true });
      expect(other.calls[0][1]).toEqual({ a: 1 });
    }
    expect(founderOrderEmit(founder, undefined)).toBeUndefined();
  });

  it("passes a non-ad class through untouched (an ad class with a non-object body is refused: see below)", async () => {
    const r = recorder();
    const wrapped = founderOrderEmit(founder, r.emit)!;
    await wrapped("engineer.ship-pr", { a: 1 });
    expect(r.calls).toEqual([["engineer.ship-pr", { a: 1 }]]);
  });
});

describe("founderOrderEmit tells the founder about a channel card with no chat (bug #2 / review F8)", () => {
  beforeEach(() => tell.mockClear());
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("must-catch: an unverified or Slack-rooted order's channel card is told about once", async () => {
    const r = recorder();
    expect(await founderOrderEmit({ ...founder, run_trigger: "handoff", founder_order_tell: true }, r.emit, "channel_actions")!("google_ads.update_campaign_budget", { campaign_id: "1" })).toBe("d-1");
    await flush();
    expect(tell).toHaveBeenCalledWith(T, "d-1", "channel_actions");
  });

  it("must-not-touch: a chat founder's channel card and any decisions-rail card are not told here", async () => {
    const r = recorder();
    await founderOrderEmit(founder, r.emit, "channel_actions")!("google_ads.update_campaign_budget", { campaign_id: "1" });
    await founderOrderEmit({ ...founder, founder_order_tell: true }, r.emit, "decisions")!("google_ads.update_campaign_budget", { campaign_id: "1" });
    await flush();
    expect(tell).not.toHaveBeenCalled();
  });
});

describe("founderOrderEmit never files a founder's ad card unstamped (review G5)", () => {
  it("must-catch: a Meta/Google body that cannot carry the stamp is refused", async () => {
    const r = recorder();
    for (const body of [null, [1], "x"]) {
      await expect(founderOrderEmit(founder, r.emit)!("google_ads.update_campaign_budget", body)).rejects.toThrow(/not an object/);
    }
    expect(r.emit).not.toHaveBeenCalled();
  });

  it("must-not-touch: a non-ad class passes through as it is", async () => {
    const r = recorder();
    await founderOrderEmit(founder, r.emit)!("pm.ticket", null);
    expect(r.calls[0]).toEqual(["pm.ticket", null]);
  });
});

describe("founderOrderEmit carries an unverified mark onto the card (security review)", () => {
  it("must-catch: an unverified order is stamped founder_order_unverified, so the DB only holds it for a tap", async () => {
    const r = recorder();
    await founderOrderEmit({ ...founder, founder_order_unverified: true }, r.emit)!("google_ads.update_campaign_budget", { campaign_id: "1" });
    expect(r.calls[0]).toEqual(["google_ads.update_campaign_budget_review", { campaign_id: "1", origin: "user_initiated_chat", founder_chat_order: true, founder_order_unverified: true }]);
  });

  it("must-not-touch: a verified order carries no unverified mark", async () => {
    const r = recorder();
    await founderOrderEmit(founder, r.emit)!("google_ads.update_campaign_budget", { campaign_id: "1" });
    expect(r.calls[0][1]).not.toHaveProperty("founder_order_unverified");
  });
});

describe("founderOrderEmit links the legs of one order (bug #1, paired moves)", () => {
  it("must-catch: every leg carries the order's server mark, on both rails, and a model-supplied one is dropped", async () => {
    const trust = { ...founder, run_id: "run-child", founder_order_group: "run-root" };
    const r = recorder();
    await founderOrderEmit(trust, r.emit)!("meta_ads.update_ad_set_budget", { ad_set_id: "1", move_group: "someone-else" });
    await founderOrderEmit(trust, r.emit, "channel_actions")!("google_ads.update_campaign_budget", { campaign_id: "2" });
    expect((r.calls[0][1] as { move_group?: string }).move_group).toBe("run-root");
    expect((r.calls[1][1] as { move_group?: string }).move_group).toBe("run-root");
  });

  it("must-not-touch: a run that is not a founder order is never stamped", async () => {
    const r = recorder();
    const emit = founderOrderEmit({ tenant_id: T, run_trigger: "cron", founder_order_group: "run-root" }, r.emit)!;
    await emit("google_ads.update_campaign_budget", { campaign_id: "2" });
    expect((r.calls[0][1] as { move_group?: string }).move_group).toBeUndefined();
  });
});

describe("serverFounderMarks (every emit path, the runner's envelope emit too)", () => {
  it("drops the founder marks from a non-founder run's Meta/Google body", () => {
    expect(serverFounderMarks("meta_ads.update_ad_set_budget", { ad_set_id: "1", founder_chat_order: true, founder_order_unverified: true, move_group: "x", origin: "agent" }, null)).toEqual({
      ad_set_id: "1",
      origin: "agent",
    });
  });
  it("P1: a founder run's marks are REBUILT from the server, whatever the body says", () => {
    expect(serverFounderMarks("google_ads.update_campaign_budget", { campaign_id: "1", authorized_effective_cap: 50 }, { group: "root-1", unverified: false })).toEqual({
      campaign_id: "1",
      origin: "user_initiated_chat",
      founder_chat_order: true,
      move_group: "root-1",
    });
    expect(serverFounderMarks("google_ads.update_campaign_budget", { founder_chat_order: true }, { group: "root-1", unverified: true })).toMatchObject({ founder_order_unverified: true });
    expect(serverFounderMarks("meta_ads.update_ad_set_budget", { founder_order_unverified: true, move_group: "forged" }, { group: "root-1", unverified: false })).toEqual({
      origin: "user_initiated_chat",
      founder_chat_order: true,
      move_group: "root-1",
    });
    expect(serverFounderMarks("meta_ads.update_ad_set_budget", { origin: "user_initiated_ledger" }, { group: null, unverified: false })).toEqual({ origin: "user_initiated_ledger", founder_chat_order: true });
  });
  it("must-catch R3: a tool body's server-only keys (move_after, budget_choice, retry_of) are dropped on every class and run", () => {
    const forged = { campaign_id: "1", move_after: { cut_ids: ["x"], by: "u" }, budget_choice: { hold_idem: "x" }, retry_of: "d-0" };
    expect(serverFounderMarks("google_ads.update_campaign_budget", forged, null)).toEqual({ campaign_id: "1" });
    expect(serverFounderMarks("google_ads.update_campaign_budget", forged, { group: "root-1", unverified: false })).toEqual({ campaign_id: "1", origin: "user_initiated_chat", founder_chat_order: true, move_group: "root-1" });
    expect(serverFounderMarks("social.publish_post", { a: 1, retry_of: "d-0" }, null)).toEqual({ a: 1 });
  });
  it("the server never stamps another class: its marks are dropped even on a founder's run; a body with none is left as is", () => {
    for (const f of [null, { group: "root-1", unverified: false }]) {
      expect(serverFounderMarks("social.publish_post", { a: 1, founder_chat_order: true, move_group: "x", founder_order_unverified: true }, f)).toEqual({ a: 1 });
    }
    const clean = { a: 1 };
    expect(serverFounderMarks("engineer.ship-pr", clean, null)).toBe(clean);
    expect(serverFounderMarks("meta_ads.x", null, null)).toBeNull();
  });
});
