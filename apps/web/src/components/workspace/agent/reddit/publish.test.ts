import { resetRedditPublishStates } from "./redditPublishStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api";
import { approveDecision } from "@/lib/approvals/approveDecision";
import type { ActionItem } from "../../actions/types";
import { redditPublishBlocked, redditPublishTarget } from "../../actions/platforms/_shared";
import { reddit_organic } from "../../actions/platforms/reddit_organic";
import { publishToReddit, RedditDeliveryUnconfirmed, redditPublishKey, redditReplyItem, submitToReddit } from "./publish";

const db = vi.hoisted(() => ({ rows: [] as Array<{ status: string; last_error?: string | null; dispatch_error?: string | null } | null>, error: null as Error | null }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: db.rows.shift() ?? null, error: db.error }) }) }) }) }),
  }),
}));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-1" }));
const fetchMock = vi.mocked(apiFetch);
const approveMock = vi.mocked(approveDecision);

const THREAD = "https://www.reddit.com/r/saas/comments/1abcde/how_do_you_find_users/";
const action = (over: Partial<ActionItem>, presentation: Record<string, unknown> | null) =>
  ({ id: "a1", run_id: "run-1", action_type: "reply", edited_body: null,
    body: { step: { deliverable: { kind: "post", content: "Here is what worked.", ...(presentation ? { presentation } : {}) } } }, ...over }) as unknown as ActionItem;
const reply = (presentation: Record<string, unknown> | null = { type: "reddit_reply", thread_url: THREAD }) => action({}, presentation);
const post = (extra: Record<string, unknown> = {}) =>
  action({ id: "a2", action_type: "text_post" }, { type: "reddit_post", subreddit: "r/SaaS", title: "How we got our first users", post_type: "text", ...extra });
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const dashboard = (drafts: unknown[] = []) => ok({ drafts, drafts_ok: true });

beforeEach(() => {
  resetRedditPublishStates();
  fetchMock.mockReset();
  approveMock.mockReset();
  db.rows = [{ status: "published", last_error: null }];
  db.error = null;
});

describe("redditPublishTarget", () => {
  it("a reply goes to its own presentation thread, a post to its bare subreddit", () => {
    expect(redditPublishTarget(reply())).toEqual({ channel: "reddit_comment", fields: { thread_url: THREAD } });
    expect(redditPublishTarget(post())).toEqual({ channel: "reddit", fields: { subreddit: "SaaS", title: "How we got our first users" } });
  });
  it("prefers the presentation thread over body.link", () => {
    const a = reply();
    (a.body as Record<string, unknown>).link = "https://www.reddit.com/r/other/comments/zzz/";
    expect(redditPublishTarget(a)).toEqual({ channel: "reddit_comment", fields: { thread_url: THREAD } });
  });
  it("names why an image post, a flair post, a banned room or a threadless reply cannot post", () => {
    expect(redditPublishTarget(post({ post_type: "image" }))).toMatch(/image/);
    expect(redditPublishTarget(post({ required_flair: "Question" }))).toMatch(/flair/);
    expect(redditPublishTarget(reply({ type: "reddit_reply", thread_url: THREAD, rule_status: "not_allowed" }))).toMatch(/rules/);
    expect(redditPublishTarget(reply(null))).toMatch(/no Reddit thread/);
  });
  it("blocks a reply over Reddit's comment cap, and the row uses the same check", () => {
    expect(redditPublishBlocked(reply(), "a".repeat(10_001))).toBe("Reddit replies are capped at 10,000 characters. Shorten it before posting.");
    expect(redditPublishBlocked(reply(), "a".repeat(10_000))).toBeNull();
    expect(redditPublishBlocked(reply(), "Hi")).toBeNull();
    expect(reddit_organic.publishBlocked).toBe(redditPublishBlocked);
  });
});

describe("publishToReddit", () => {
  it("stages one proposal with the target fields and approves that one", async () => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d1" }));
    approveMock.mockResolvedValue(ok({}));
    await expect(publishToReddit(reply(), { text: "Hi" })).resolves.toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ channel: "reddit_comment", payload: { thread_url: THREAD, text: "Hi" } });
    expect(approveMock).toHaveBeenCalledWith("d1");
  });
  it("approves a proposal already staged for the same copy instead of staging a second", async () => {
    fetchMock.mockResolvedValueOnce(dashboard([{ decision_id: "d0", source: "staged", channel: "reddit_comment", thread_url: THREAD, text: "Here is what worked." }]));
    approveMock.mockResolvedValue(ok({}));
    await publishToReddit(reply(), { text: "Here is what worked." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(approveMock).toHaveBeenCalledWith("d0");
  });
  it("a staged card approves its own proposal without a lookup", async () => {
    approveMock.mockResolvedValue(ok({}));
    await publishToReddit(action({ id: "d9", run_id: null }, { type: "reddit_reply", thread_url: THREAD }), { text: "Here is what worked." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(approveMock).toHaveBeenCalledWith("d9");
  });
  it("does not approve a matching reply written for a different thread", async () => {
    const other = "https://www.reddit.com/r/saas/comments/2other/";
    fetchMock.mockResolvedValueOnce(dashboard([{ decision_id: "other", source: "staged", channel: "reddit_comment", thread_url: other, text: "Here is what worked." }]))
      .mockResolvedValueOnce(ok({ decision_id: "right" }));
    approveMock.mockResolvedValue(ok({}));
    await publishToReddit(reply(), { text: "Here is what worked." });
    expect(approveMock).toHaveBeenCalledWith("right");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).payload.thread_url).toBe(THREAD);
  });
  it("does not report a post as delivered when its status cannot be read", async () => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d1" }));
    approveMock.mockResolvedValue(ok({}));
    db.error = new Error("read failed");
    await expect(publishToReddit(reply(), { text: "Hi" })).rejects.toThrow(/could not confirm/);
  });
  it("refuses before any request when the card cannot post", async () => {
    await expect(publishToReddit(post({ post_type: "image" }), { text: "Body" })).rejects.toThrow(/image/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("a failed lookup stops rather than staging a possible duplicate", async () => {
    fetchMock.mockResolvedValueOnce(ok({ drafts: [], drafts_ok: false }));
    await expect(publishToReddit(reply(), { text: "Hi" })).rejects.toThrow(/already waiting/);
    expect(approveMock).not.toHaveBeenCalled();
  });
  it("a scheduled proposal is not reported as posted", async () => {
    approveMock.mockResolvedValue(ok({}));
    db.rows = [{ status: "scheduled", last_error: null }];
    await expect(publishToReddit(action({ id: "d9", run_id: null }, { type: "reddit_reply", thread_url: THREAD }), { text: "Here is what worked." })).rejects.toThrow(/Scheduled on Reddit/);
  });
  it("says so when Reddit rejects the approved post", async () => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d1" }));
    approveMock.mockResolvedValue(ok({}));
    db.rows = [{ status: "failed", last_error: "vendor_rejected" }];
    const err = await publishToReddit(reply(), { text: "Hi" }).catch((e: Error) => e);
    expect(String(err)).toMatch(/Reddit refused it/);
    expect(String(err)).not.toMatch(/vendor_rejected/);
  });
  it("names a lost Reddit connection in plain words, never the code", async () => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d1" }));
    approveMock.mockResolvedValue(ok({}));
    db.rows = [{ status: "failed", last_error: "disconnected" }];
    const err = await publishToReddit(reply(), { text: "Hi" }).catch((e: Error) => e);
    expect(String(err)).toMatch(/Reconnect Reddit/);
    expect(String(err)).not.toMatch(/\(disconnected\)/);
  });
  it("says nothing was posted when the approval failed before Reddit was called", async () => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d1" }));
    approveMock.mockResolvedValue(ok({}));
    db.rows = [null, { status: "dispatch_failed", last_error: null }];
    await expect(publishToReddit(reply(), { text: "Hi" })).rejects.toThrow(/Nothing was posted/);
  });
  it("posting now clears a schedule on a pending proposal the server hands back", async () => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d0", existing: true, status: "proposed" }));
    approveMock.mockResolvedValue(ok({}));
    await submitToReddit(reply(), { text: "Hi" }, { ownProposal: false, publishNow: true });
    expect(approveMock).toHaveBeenCalledWith("d0", { scheduled_at: null });
  });
  it("never approves again when the server returns the same post already sent", async () => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d0", existing: true, status: "acted" }));
    await expect(publishToReddit(reply(), { text: "Hi" })).resolves.toBe(true);
    expect(approveMock).not.toHaveBeenCalled();
  });
});

describe("submitToReddit", () => {
  it("keeps the approved decision on an unconfirmed delivery so a retry can check it instead of posting again", async () => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d1" }));
    approveMock.mockResolvedValue(ok({}));
    db.error = new Error("read failed");
    const error = await submitToReddit(reply(), { text: "Hi" }, { ownProposal: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedditDeliveryUnconfirmed);
    expect((error as RedditDeliveryUnconfirmed).decisionId).toBe("d1");
  });
  it("reports a scheduled delivery as scheduled, not published", async () => {
    approveMock.mockResolvedValue(ok({}));
    db.rows = [{ status: "scheduled", last_error: null }];
    await expect(
      submitToReddit(action({ id: "d9", run_id: null }, { type: "reddit_reply", thread_url: THREAD }), { text: "Here is what worked." }),
    ).resolves.toEqual({ decisionId: "d9", status: "scheduled" });
  });
  it("publish-now clears the schedule on a proposal that was already waiting", async () => {
    fetchMock.mockResolvedValueOnce(dashboard([{ decision_id: "d0", source: "staged", channel: "reddit_comment", thread_url: THREAD, text: "Here is what worked." }]));
    approveMock.mockResolvedValue(ok({}));
    await submitToReddit(reply(), { text: "Here is what worked." }, { ownProposal: false, publishNow: true });
    expect(approveMock).toHaveBeenCalledWith("d0", { scheduled_at: null });
  });
  it("blocks a reply whose community rules say no, before any request or approval", async () => {
    await expect(submitToReddit(redditReplyItem("t1", THREAD, "Hi", "not_allowed"), { text: "Hi" })).rejects.toThrow(
      "This community does not allow self-promotion, so Zavi won't post here. You can still copy the reply.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(approveMock).not.toHaveBeenCalled();
  });
});

describe("an approval the server refuses", () => {
  const refused = (status: number, message: string) =>
    ({ ok: false, status, json: async () => ({ error: { code: "x", message } }), clone() { return this; } }) as unknown as Response;

  it.each([
    [403, "Your plan does not include posting to Reddit."],
    [422, "The reply is longer than Reddit allows."],
  ])("a %i says nothing was posted and why, never 'could not confirm'", async (status, message) => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d1" }));
    approveMock.mockResolvedValue(refused(status, message));

    const err = await publishToReddit(reply(), { text: "Hi" }).catch((e: Error) => e);

    expect(String(err)).toContain(message);
    expect(String(err)).toMatch(/Nothing was posted/);
    expect(String(err)).not.toMatch(/could not confirm/i);
    expect(err).not.toBeInstanceOf(RedditDeliveryUnconfirmed);
  });

  it("still treats a 409 and a 5xx as unknown, since the post may have gone out", async () => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d1" }));
    approveMock.mockResolvedValue(refused(503, "busy"));

    const err = await publishToReddit(reply(), { text: "Hi" }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(RedditDeliveryUnconfirmed);
  });
});

describe("redditPublishBlocked on a community that bans self-promotion", () => {
  const NOT_ALLOWED = "This community does not allow self-promotion, so Zavi won't post here. You can still copy the reply.";
  it("names the rule, not a thread or length problem, and wins over every other check", () => {
    expect(redditPublishBlocked(redditReplyItem("t1", THREAD, "Hi", "not_allowed"), "Hi")).toBe(NOT_ALLOWED);
    expect(redditPublishBlocked(redditReplyItem("t1", THREAD, "Hi", "not_allowed"), "a".repeat(10_001))).toBe(NOT_ALLOWED);
  });
  it("lets the same reply through when the rules allow it or were never read", () => {
    expect(redditPublishBlocked(redditReplyItem("t1", THREAD, "Hi", "allowed"), "Hi")).toBeNull();
    expect(redditPublishBlocked(redditReplyItem("t1", THREAD, "Hi"), "Hi")).toBeNull();
  });
  it("leaves a post's own rule message alone", () => {
    expect(redditPublishBlocked(post({ rule_status: "not_allowed" }), "Body")).not.toBe(NOT_ALLOWED);
  });
});

describe("what a refused delivery says", () => {
  const OFF = "Nothing was posted: Reddit posting is switched off in Zavi.";
  const stage = () => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d1" }));
    approveMock.mockResolvedValue(ok({}));
  };

  it("maps the switched-off sentence in dispatch_error to plain copy, never the raw sentence", async () => {
    stage();
    db.rows = [null, { status: "dispatch_failed", dispatch_error: "Social publishing isn't enabled for your account yet." }];
    const err = await publishToReddit(reply(), { text: "Hi" }).catch((e: Error) => e);
    expect((err as Error).message).toBe(OFF);
    expect(err).not.toBeInstanceOf(RedditDeliveryUnconfirmed);
  });

  it("maps a known code embedded in dispatch_error", async () => {
    stage();
    db.rows = [null, { status: "failed", dispatch_error: "dispatch refused: channel_disabled" }];
    expect((await publishToReddit(reply(), { text: "Hi" }).catch((e: Error) => e) as Error).message).toBe(OFF);
  });

  it("does not match a code that is only part of a longer word", async () => {
    stage();
    db.rows = [null, { status: "dispatch_failed", dispatch_error: "xchannel_disabled_y" }];
    const message = (await publishToReddit(reply(), { text: "Hi" }).catch((e: Error) => e) as Error).message;
    expect(message).not.toBe(OFF);
    expect(message).toMatch(/Nothing was posted: Zavi could not send it to Reddit/);
  });

  it("keeps the not-sent sentence when dispatch_error is empty", async () => {
    stage();
    db.rows = [null, { status: "rejected", dispatch_error: null }];
    expect((await publishToReddit(reply(), { text: "Hi" }).catch((e: Error) => e) as Error).message).toMatch(/Nothing was posted: Zavi could not send it to Reddit/);
  });

  it("maps social_publish_paused on a failed post row", async () => {
    stage();
    db.rows = [{ status: "failed", last_error: "social_publish_paused" }];
    expect((await publishToReddit(reply(), { text: "Hi" }).catch((e: Error) => e) as Error).message).toBe(OFF);
  });
});

describe("an approve that answers 409 because the decision is already closed", () => {
  const closed = (status: string, code = "decision_closed") =>
    ({ ok: false, status: 409, json: async () => ({ error: { code, status } }), clone() { return this; } }) as unknown as Response;

  it.each(["approved", "dispatching", "acted", "dispatch_failed"])("treats %s as already approved and reads the delivery", async (status) => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d1" }));
    approveMock.mockResolvedValue(closed(status));
    db.rows = [{ status: "published", last_error: null }];
    await expect(submitToReddit(reply(), { text: "Hi" }, { ownProposal: false })).resolves.toEqual({ decisionId: "d1", status: "published" });
    expect(approveMock).toHaveBeenCalledTimes(1);
  });

  it.each([["rejected", "decision_closed"], ["approved", "conflict"]])("still treats a 409 with status %s and code %s as unconfirmed", async (status, code) => {
    fetchMock.mockResolvedValueOnce(dashboard()).mockResolvedValueOnce(ok({ decision_id: "d1" }));
    approveMock.mockResolvedValue(closed(status, code));
    const err = await submitToReddit(reply(), { text: "Hi" }, { ownProposal: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedditDeliveryUnconfirmed);
    expect((err as RedditDeliveryUnconfirmed).decisionId).toBe("d1");
  });
});

describe("redditPublishKey", () => {
  it("names the same thread the same way from any card, so one reply cannot be posted twice", () => {
    expect(redditPublishKey(redditReplyItem("a", THREAD, "x"))).toBe(redditPublishKey(redditReplyItem("a", `${THREAD.toUpperCase().replace("HTTPS", "https")}?utm=1`, "x")));
  });
});
