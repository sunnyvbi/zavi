
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  igComposio: vi.fn(),
  ytComposio: vi.fn(),
  rdComposio: vi.fn(),
  rdComment: vi.fn(),
  enqueue: vi.fn(),
  rpc: vi.fn(),
  row: null as Record<string, unknown> | null,
  handler: null as null | ((ctx: unknown) => Promise<unknown>),
}));

vi.mock("@/services/channels/post-live", () => ({ closePostCardsForPublished: vi.fn(async () => 0) }));
vi.mock("@/services/growth/preview-plan", async (orig) =>
  (await import("@/__tests__/helpers/tenant-plan")).previewPlanOn(orig),
);
vi.mock("../../client", () => ({
  inngest: {
    createFunction: (_c: unknown, _t: unknown, h: (ctx: unknown) => Promise<unknown>) => {
      m.handler = h;
      return {};
    },
  },
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.row, error: null }) }) }) }),
    rpc: m.rpc,
    storage: { from: () => ({ createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed.example/${p}` }, error: null }) }) },
  }),
}));
vi.mock("@/services/connectors/social-publish-gate", () => ({ socialPublishGate: async () => ({ open: true, via: "config" }) }));
vi.mock("@/services/connectors/social-channels", () => ({
  resolveChannelAction: (ch: string) =>
    ch === "reddit" || ch === "reddit_comment" ? { destination_required: false } : { media_prop: "file", destination_required: false },
}));
vi.mock("@/services/connectors/social-publish-account", () => ({ verifySocialAccountAtPublish: m.verify }));
vi.mock("@/services/connectors/instagram-composio/publish", () => ({ publishInstagramImageViaComposio: m.igComposio }));
vi.mock("@/services/connectors/youtube-composio/publish", () => ({ publishYouTubeVideoViaComposio: m.ytComposio }));
vi.mock("@/services/connectors/reddit-composio/publish", () => ({
  publishRedditSelfPostViaComposio: m.rdComposio,
  publishRedditCommentViaComposio: m.rdComment,
}));
vi.mock("@/services/connectors/pipedream/api", () => ({
  runAction: vi.fn(() => { throw new Error("pipedream must never be called"); }),
}));
vi.mock("@/services/slack/outbox", () => ({ enqueueSlackOutbox: m.enqueue }));
vi.mock("@/services/slack/approval-post-target", () => ({ resolveApprovalPostTarget: async () => ({ channel: "C1", team_id: "T" }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/analytics/action-events", () => ({ trackSocialPostPublished: vi.fn() }));

import "../social-publish";
import { closePostCardsForPublished } from "@/services/channels/post-live";
import { resetTenantPlan, tenantPlan } from "@/__tests__/helpers/tenant-plan";

const ROW_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const EVENT_TENANT = "11111111-1111-4111-8111-111111111111";

function baseRow(over: Record<string, unknown>) {
  return {
    id: "post-1", tenant_id: ROW_TENANT, agent_run_id: "run-1", pipedream_app_slug: "instagram_business",
    pipedream_action_id: "a", account_id: "ca_ig", destination_id: null, snapshot_hash: "h",
    scheduled_at: null, status: "approved", idempotency_key: "k1", ...over,
  };
}
const step = { run: async (_n: string, fn: () => unknown) => fn(), sleepUntil: async () => {} };
const run = () => m.handler!({ event: { data: { post_id: "post-1", tenant_id: EVENT_TENANT } }, step });
const finalizeCalls = () => m.rpc.mock.calls.filter((c) => c[0] === "social_publish_finalize").map((c) => c[1]);

beforeEach(() => {
  resetTenantPlan();
  for (const f of [m.verify, m.igComposio, m.ytComposio, m.rdComposio, m.rdComment, m.enqueue, m.rpc]) f.mockReset();
  m.rpc.mockImplementation(async (name: string, args?: { p_ok?: boolean }) => {
    if (name === "social_publish_finalize" && args?.p_ok === false && m.row) m.row = { ...m.row, status: "failed" };
    return name === "social_publish_claim" || name === "social_publish_begin_send" ? { data: true, error: null } : { data: null, error: null };
  });
  m.enqueue.mockResolvedValue(1);
  m.verify.mockImplementation(async (a: { tenantId: string; channel: string; accountId: string }) => ({
    tenant_id: a.tenantId, toolkit: { youtube_video: "youtube", reddit: "reddit", reddit_comment: "reddit" }[a.channel] ?? "instagram", connected_account_id: a.accountId,
  }));
});

describe("social-publish worker — composio transport", () => {
  it("instagram_image publishes once through Composio with the row tenant's owned account", async () => {
    m.row = baseRow({ channel: "instagram_image", transport: "composio", configured_props: { file: `${ROW_TENANT}/a.jpg`, text: "cap" } });
    m.igComposio.mockResolvedValue({ ok: true, status: 200, raw: { id: "M1", permalink: "https://instagram.com/p/x" } });
    const r = await run();
    expect(m.igComposio).toHaveBeenCalledTimes(1);
    const [owned, text, url] = m.igComposio.mock.calls[0];
    expect(owned).toEqual({ tenant_id: ROW_TENANT, toolkit: "instagram", connected_account_id: "ca_ig" });
    expect(text).toBe("cap");
    expect(url).toBe(`https://signed.example/${ROW_TENANT}/a.jpg`);
    for (const c of m.verify.mock.calls) expect(c[0]).toMatchObject({ tenantId: ROW_TENANT, accountId: "ca_ig", transport: "composio" });
    expect(r).toMatchObject({ status: "published", external_post_id: "M1" });
  });

  it("closes the post card after a published post, and a failed close retries without rewriting the post as failed", async () => {
    m.row = baseRow({ channel: "instagram_image", transport: "composio", configured_props: { file: `${ROW_TENANT}/a.jpg`, text: "cap" } });
    m.igComposio.mockResolvedValue({ ok: true, status: 200, raw: { id: "M1", permalink: "https://instagram.com/p/x" } });
    const close = vi.mocked(closePostCardsForPublished);
    close.mockClear();
    close.mockRejectedValueOnce(new Error("db blip"));
    await expect(run()).rejects.toThrow("db blip");
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ id: "post-1", tenant_id: ROW_TENANT, agent_run_id: "run-1", channel: "instagram_image" }));
    expect(finalizeCalls().map((c) => (c as { p_ok: boolean }).p_ok)).toEqual([true]);
  });

  it("a stale delivery whose failed finalize finds the post already published tells the founder nothing", async () => {
    tenantPlan.tier = "free";
    m.row = baseRow({ channel: "reddit", transport: "composio", account_id: "ca_rd", pipedream_app_slug: "reddit", configured_props: { subreddit: "startups", title: "T", kind: "self", text: "Body" } });
    m.rpc.mockImplementation(async (name: string) => {
      if (name === "social_publish_finalize" && m.row) m.row = { ...m.row, status: "published" };
      return { data: null, error: null };
    });
    await run();
    expect(finalizeCalls().map((c) => (c as { p_ok: boolean }).p_ok)).toEqual([false]);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("never calls the vendor when a replay finds that sending already started", async () => {
    m.row = baseRow({ channel: "instagram_image", transport: "composio", configured_props: { file: `${ROW_TENANT}/a.jpg`, text: "cap" } });
    m.rpc.mockImplementation(async (name: string) => {
      if (name === "social_publish_claim") return { data: true, error: null };
      if (name === "social_publish_begin_send") return { data: false, error: null };
      return { data: null, error: null };
    });

    const r = await run();

    expect(m.igComposio).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "failed", error: "transient_exhausted" });
    expect(finalizeCalls()).toEqual([
      expect.objectContaining({
        p_ok: false,
        p_error: "transient_exhausted",
        p_response: expect.objectContaining({ code: "publish_outcome_unknown" }),
      }),
    ]);
  });

  it("youtube_video publishes through Composio with {title, description, privacy} for the ROW tenant", async () => {
    m.row = baseRow({ channel: "youtube_video", transport: "composio", account_id: "ca_yt",
      configured_props: { file: `${ROW_TENANT}/v.mp4`, title: "T", text: "D", privacy: "unlisted" } });
    m.ytComposio.mockResolvedValue({ ok: true, status: 200, raw: { id: "vid1", url: "https://www.youtube.com/watch?v=vid1" } });
    await run();
    expect(m.ytComposio).toHaveBeenCalledTimes(1);
    const [owned, meta, url] = m.ytComposio.mock.calls[0];
    expect(owned.tenant_id).toBe(ROW_TENANT);
    expect(meta).toEqual({ title: "T", description: "D", privacy: "unlisted" });
    expect(url).toBe(`https://signed.example/${ROW_TENANT}/v.mp4`);
  });

  it("reddit publishes a self post through Composio for the ROW tenant, with no media prop", async () => {
    m.row = baseRow({ channel: "reddit", transport: "composio", account_id: "ca_rd", pipedream_app_slug: "reddit",
      configured_props: { subreddit: "startups", title: "T", kind: "self", text: "Body" } });
    m.rdComposio.mockResolvedValue({ ok: true, status: 200, raw: { id: "t3_abc", url: "https://www.reddit.com/r/startups/comments/abc/t/" } });
    const r = await run();
    expect(m.rdComposio).toHaveBeenCalledTimes(1);
    const [owned, post] = m.rdComposio.mock.calls[0];
    expect(owned).toEqual({ tenant_id: ROW_TENANT, toolkit: "reddit", connected_account_id: "ca_rd" });
    expect(post).toEqual({ subreddit: "startups", title: "T", text: "Body" });
    expect(r).toMatchObject({ status: "published", external_post_id: "t3_abc" });
  });

  it("a reddit row missing its subreddit never reaches the publisher", async () => {
    m.row = baseRow({ channel: "reddit", transport: "composio", account_id: "ca_rd", configured_props: { title: "T", text: "Body" } });
    const r = await run();
    expect(r).toMatchObject({ status: "failed", error: "vendor_rejected" });
    expect(m.rdComposio).not.toHaveBeenCalled();
  });

  it("reddit_comment replies on the frozen thread through Composio for the ROW tenant", async () => {
    const thread_url = "https://www.reddit.com/r/saas/comments/1abcde/";
    m.row = baseRow({ channel: "reddit_comment", transport: "composio", account_id: "ca_rd", pipedream_app_slug: "reddit",
      configured_props: { thread_url, text: "Here is what worked for us." } });
    m.rdComment.mockResolvedValue({ ok: true, status: 200, raw: { id: "t1_xyz", url: `${thread_url}comment/xyz/` } });
    const r = await run();
    expect(m.rdComment).toHaveBeenCalledTimes(1);
    const [owned, comment] = m.rdComment.mock.calls[0];
    expect(owned).toEqual({ tenant_id: ROW_TENANT, toolkit: "reddit", connected_account_id: "ca_rd" });
    expect(comment).toEqual({ thread_url, text: "Here is what worked for us." });
    expect(m.rdComposio).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "published", external_post_id: "t1_xyz" });
  });

  it("a reddit_comment row missing its thread never reaches the publisher", async () => {
    m.row = baseRow({ channel: "reddit_comment", transport: "composio", account_id: "ca_rd", configured_props: { text: "Hi" } });
    const r = await run();
    expect(r).toMatchObject({ status: "failed", error: "vendor_rejected" });
    expect(m.rdComment).not.toHaveBeenCalled();
  });

  it("a Composio transport failure (status 0) finalizes failed and the step does not throw", async () => {
    m.row = baseRow({ channel: "instagram_image", transport: "composio", configured_props: { file: `${ROW_TENANT}/a.jpg`, text: "x" } });
    m.igComposio.mockResolvedValue({ ok: false, status: 0, raw: { error: "composio_transport_error" } });
    const r = await run();
    expect(r).toMatchObject({ status: "failed", error: "transient_exhausted" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_ok: false, p_error: "transient_exhausted" })]);
  });

  it("an account no longer re-provable at publish time never reaches the publisher", async () => {
    m.row = baseRow({ channel: "instagram_image", transport: "composio", configured_props: { file: `${ROW_TENANT}/a.jpg`, text: "x" } });
    m.verify.mockResolvedValue(false);
    const r = await run();
    expect(r).toMatchObject({ status: "failed", error: "disconnected" });
    expect(m.igComposio).not.toHaveBeenCalled();
  });
});

describe("social-publish worker — queued pipedream rows", () => {
  it("instagram_image pipedream row finalizes reconnect_required with the reconnect notice", async () => {
    m.row = baseRow({ channel: "instagram_image", transport: "pipedream", account_id: "apn_1", configured_props: { file: `${ROW_TENANT}/a.jpg` } });
    m.verify.mockResolvedValue("reconnect_required");
    const r = await run();
    expect(r).toMatchObject({ status: "failed", error: "reconnect_required" });
    expect(finalizeCalls()).toEqual([expect.objectContaining({ p_ok: false, p_error: "reconnect_required" })]);
    expect(m.enqueue.mock.calls[0][0].body).toBe("Couldn't publish the Instagram post: Reconnect Instagram to publish this post.");
    expect(m.igComposio).not.toHaveBeenCalled();
    expect(m.rpc.mock.calls.some((c) => c[0] === "social_publish_claim")).toBe(false);
  });
});

describe("social-publish worker and the plan", () => {
  const redditRow = () =>
    baseRow({ channel: "reddit", transport: "composio", account_id: "ca_rd", pipedream_app_slug: "reddit",
      configured_props: { subreddit: "startups", title: "T", kind: "self", text: "Body" } });

  it("Free: the post is failed with the upgrade message; no claim, no vendor call", async () => {
    tenantPlan.tier = "free";
    m.row = redditRow();
    const r = await run();
    expect(r).toMatchObject({ status: "failed", error: "plan_upgrade_required" });
    expect(m.rdComposio).not.toHaveBeenCalled();
    expect(m.verify).not.toHaveBeenCalled();
    expect(m.rpc.mock.calls.some((c) => c[0] === "social_publish_claim")).toBe(false);
    const fin = finalizeCalls();
    expect(fin).toHaveLength(1);
    expect(fin[0]).toMatchObject({ p_post_id: "post-1", p_ok: false, p_error: "vendor_rejected", p_response: { code: "plan_upgrade_required" } });
    expect(String((fin[0].p_response as { error: string }).error)).toMatch(/needs the Starter plan/);
    expect(String(m.enqueue.mock.calls[0][0].body)).toMatch(/needs the Starter plan/);
    expect(m.enqueue.mock.calls[0][0].tenant_id).toBe(ROW_TENANT);
  });

  it("Starter: the same post publishes as before", async () => {
    tenantPlan.tier = "starter";
    m.row = redditRow();
    m.rdComposio.mockResolvedValue({ ok: true, status: 200, raw: { id: "t3_abc", url: "https://www.reddit.com/r/startups/comments/abc/t/" } });
    expect(await run()).toMatchObject({ status: "published", external_post_id: "t3_abc" });
    expect(m.rdComposio).toHaveBeenCalledTimes(1);
  });

  it("an unreadable plan THROWS before the claim (Inngest retries): the post is neither sent nor failed", async () => {
    tenantPlan.unreadable = true;
    m.row = redditRow();
    await expect(run()).rejects.toThrow(/unreadable/);
    expect(m.rdComposio).not.toHaveBeenCalled();
    expect(finalizeCalls()).toEqual([]);
    expect(m.rpc.mock.calls.some((c) => c[0] === "social_publish_claim")).toBe(false);
  });
});
