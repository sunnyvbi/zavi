import { describe, it, expect, vi, beforeEach } from "vitest";
const exec = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: exec }));
import { publishRedditCommentViaComposio, publishRedditSelfPostViaComposio } from "../publish";

const OWNED = { tenant_id: "T1", toolkit: "reddit", connected_account_id: "ca_rd" } as unknown as import("@/services/connectors/composio/api").OwnedComposioAccount;
const POST = { subreddit: "startups", title: "T", text: "Body" };

beforeEach(() => exec.mockReset());

describe("publishRedditSelfPostViaComposio", () => {
  it("calls REDDIT_CREATE_REDDIT_POST as a self post for the tenant's verified account", async () => {
    exec.mockResolvedValue({ ok: true, status: 200, data: { id: "t3_abc", url: "https://www.reddit.com/r/startups/comments/abc/t/" }, error: null });
    const r = await publishRedditSelfPostViaComposio(OWNED, POST);
    expect(exec).toHaveBeenCalledWith({ tool_slug: "REDDIT_CREATE_REDDIT_POST", user_id: "T1", connected_account_id: "ca_rd",
      arguments: { subreddit: "startups", title: "T", kind: "self", text: "Body", flair_id: "" } });
    expect(r).toEqual({ ok: true, status: 200, raw: { id: "t3_abc", url: "https://www.reddit.com/r/startups/comments/abc/t/" } });
  });
  it("reads the receipt from a nested or JSON-encoded data object", async () => {
    exec.mockResolvedValue({ ok: true, status: 200, data: JSON.stringify({ data: { id: "t3_x", url: "u" } }), error: null });
    expect((await publishRedditSelfPostViaComposio(OWNED, POST)).raw).toEqual({ id: "t3_x", url: "u" });
  });
  it("keeps a successful post receipt when Reddit returns an id without a URL", async () => {
    exec.mockResolvedValue({ ok: true, status: 200, data: { id: "t3_abc" }, error: null });
    expect((await publishRedditSelfPostViaComposio(OWNED, POST)).raw).toEqual({ id: "t3_abc", url: "https://www.reddit.com/r/startups/comments/abc/" });
  });
  it("a Reddit refusal is a stable vendor rejection", async () => {
    exec.mockResolvedValue({ ok: false, status: 200, data: null, error: "SUBREDDIT_NOEXIST" });
    const r = await publishRedditSelfPostViaComposio(OWNED, POST);
    expect(r).toEqual({ ok: false, status: 400, raw: { error: "SUBREDDIT_NOEXIST" } });
  });
  it("a transport failure keeps status 0, never throws", async () => {
    exec.mockResolvedValue({ ok: false, status: 0, data: null, error: "composio_transport_error" });
    const r = await publishRedditSelfPostViaComposio(OWNED, POST);
    expect(r).toEqual({ ok: false, status: 0, raw: { error: "composio_transport_error" } });
  });
});

describe("publishRedditCommentViaComposio", () => {
  const THREAD = "https://www.reddit.com/r/saas/comments/1abcde/";
  it("comments on the thread's fullname and returns the comment permalink", async () => {
    exec.mockResolvedValue({ ok: true, status: 200, data: { data: { id: "t1_xyz", parent_id: "t3_1abcde", text: "Hi" } }, error: null });
    const r = await publishRedditCommentViaComposio(OWNED, { thread_url: THREAD, text: "Hi" });
    expect(exec).toHaveBeenCalledWith({ tool_slug: "REDDIT_POST_REDDIT_COMMENT", user_id: "T1", connected_account_id: "ca_rd",
      arguments: { thing_id: "t3_1abcde", text: "Hi" } });
    expect(r).toEqual({ ok: true, status: 200, raw: { id: "t1_xyz", url: `${THREAD}_/xyz/` } });
  });
  it("a Reddit refusal is a stable vendor rejection", async () => {
    exec.mockResolvedValue({ ok: false, status: 200, data: null, error: "THREAD_LOCKED" });
    const r = await publishRedditCommentViaComposio(OWNED, { thread_url: THREAD, text: "Hi" });
    expect(r).toEqual({ ok: false, status: 400, raw: { error: "THREAD_LOCKED" } });
  });
});

it("does not report an empty provider response as published", async () => {
  exec.mockResolvedValue({ ok: true, status: 200, data: {}, error: null });
  expect((await publishRedditSelfPostViaComposio(OWNED, POST)).status).toBe(0);
  expect((await publishRedditCommentViaComposio(OWNED, { thread_url: "https://www.reddit.com/r/saas/comments/abc/", text: "Hi" })).status).toBe(0);
});
