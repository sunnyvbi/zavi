import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  draft: vi.fn(),
  update: vi.fn(),
  consume: vi.fn(),
  markerAt: vi.fn(),
}));

const THREAD_GONE = "This thread is no longer available.";
const RATE_LIMITED = "You've drafted a lot this hour. Try again later.";
const ALREADY_POSTED = "You already replied on this thread, so Zavi kept that reply.";

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/channels/reddit/db", () => ({ redditDb: () => ({ svc: true }) }));
vi.mock("@/services/tenant-client", () => ({
  consumeTenantRateLimit: mocks.consume,
  tenantMarkerAt: mocks.markerAt,
}));
vi.mock("@/services/channels/reddit/draft", () => ({
  DRAFT_MAX_CHARS: 4000,
  THREAD_GONE_MESSAGE: "This thread is no longer available.",
  DRAFT_RATE_LIMITED_MESSAGE: "You've drafted a lot this hour. Try again later.",
  ALREADY_POSTED_MESSAGE: "You already replied on this thread, so Zavi kept that reply.",
  draftThreadReply: mocks.draft,
  updateThreadDraft: mocks.update,
}));

import { redditThreadDraftPost, redditThreadUpdate } from "../threads";

const ID = "33333333-3333-4333-8333-333333333333";

const mkRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};
const mkReq = (id: string = ID, body: unknown = {}) => ({ body, query: {}, params: { id } }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "tok" });
  mocks.draft.mockResolvedValue({ ok: true, text: "a helpful reply" });
  mocks.update.mockResolvedValue("updated");
  mocks.consume.mockResolvedValue(true);
  mocks.markerAt.mockResolvedValue(null);
});

describe("POST /api/reddit/threads/:id/draft", () => {
  it("stops at auth", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    await redditThreadDraftPost(mkReq(), mkRes());
    expect(mocks.draft).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("drafts for the authenticated tenant and returns {draft:{text}}", async () => {
    const res = mkRes();
    await redditThreadDraftPost(mkReq(ID, { tenant_id: "evil" }), res);
    expect(mocks.draft).toHaveBeenCalledWith({ svc: true }, "t1", ID, {}, { claim: expect.any(Function) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ draft: { text: "a helpful reply" } });
  });

  it("does not take a limiter slot itself: the claim is handed to the service, which decides when to spend it", async () => {
    await redditThreadDraftPost(mkReq(), mkRes());
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("the handed claim spends the tenant's DB bucket: 20 drafts per hour, keyed to the auth tenant", async () => {
    mocks.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t-auth", access_token: "tok" });
    let claimed: boolean | undefined;
    mocks.draft.mockImplementation(async (_sb, _t, _id, _deps, opts: { claim: () => Promise<boolean> }) => {
      claimed = await opts.claim();
      return { ok: true, text: "x" };
    });
    await redditThreadDraftPost(mkReq(ID, { tenant_id: "evil" }), mkRes());
    expect(claimed).toBe(true);
    expect(mocks.consume).toHaveBeenCalledTimes(1);
    expect(mocks.consume).toHaveBeenCalledWith("t-auth", "reddit_draft", 20, 3600);
  });

  it("429s with the plain message and a retry measured from the DB window start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T12:40:00Z"));
    mocks.markerAt.mockResolvedValue(Date.parse("2026-09-18T12:00:00Z"));
    mocks.draft.mockResolvedValue({ ok: false, code: "rate_limited", message: RATE_LIMITED });
    const res = mkRes();
    await redditThreadDraftPost(mkReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: "rate_limited", message: RATE_LIMITED, retry_after_s: 1200 });
    expect(mocks.markerAt).toHaveBeenCalledWith("t1", "reddit_draft");
  });

  it("429 still answers with a full-window retry when the window read throws", async () => {
    mocks.markerAt.mockRejectedValue(new Error("db down"));
    mocks.draft.mockResolvedValue({ ok: false, code: "rate_limited", message: RATE_LIMITED });
    const res = mkRes();
    await redditThreadDraftPost(mkReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: "rate_limited", message: RATE_LIMITED, retry_after_s: 3600 });
  });

  it("404s with the gone message for a thread that is not the tenant's, and for a malformed id without touching the service", async () => {
    mocks.draft.mockResolvedValue({ ok: false, code: "not_found", message: THREAD_GONE });
    const res = mkRes();
    await redditThreadDraftPost(mkReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "not_found", message: THREAD_GONE });

    const bad = mkRes();
    await redditThreadDraftPost(mkReq("not-a-uuid"), bad);
    expect(bad.statusCode).toBe(404);
    expect(bad.body).toEqual({ error: "not_found", message: THREAD_GONE });
    expect(mocks.draft).toHaveBeenCalledTimes(1);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("409s an already-posted thread with its message", async () => {
    mocks.draft.mockResolvedValue({ ok: false, code: "already_posted", message: ALREADY_POSTED });
    const res = mkRes();
    await redditThreadDraftPost(mkReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "already_posted", message: ALREADY_POSTED });
  });

  it("502s on a model failure or a throw, always with a plain message and never the raw error", async () => {
    mocks.draft.mockResolvedValueOnce({ ok: false, code: "draft_failed", message: "Try again." });
    const res = mkRes();
    await redditThreadDraftPost(mkReq(), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: "draft_failed", message: "Try again." });

    mocks.draft.mockRejectedValueOnce(new Error("db down"));
    const thrown = mkRes();
    await redditThreadDraftPost(mkReq(), thrown);
    expect(thrown.statusCode).toBe(502);
    expect(thrown.body).toEqual({
      error: "draft_failed",
      message: "Zavi couldn't draft a reply right now. Try again in a minute.",
    });
    expect(JSON.stringify(thrown.body)).not.toContain("db down");
  });
});

describe("PATCH /api/reddit/threads/:id", () => {
  it("stops at auth", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    await redditThreadUpdate(mkReq(ID, { draft_state: "posted" }), mkRes());
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("marks posted (with an edited draft) for the authenticated tenant", async () => {
    const res = mkRes();
    await redditThreadUpdate(mkReq(ID, { draft_state: "posted", draft_text: "edited", tenant_id: "evil" }), res);
    expect(mocks.update).toHaveBeenCalledWith({ svc: true }, "t1", ID, { draft_state: "posted", draft_text: "edited" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, draft_state: "posted" });
  });

  it("saves an edit without marking it posted and ignores tenant input", async () => {
    const res = mkRes();
    await redditThreadUpdate(mkReq(ID, { draft_state: "drafted", draft_text: "  edited reply  ", tenant_id: "evil" }), res);
    expect(mocks.update).toHaveBeenCalledWith({ svc: true }, "t1", ID, { draft_state: "drafted", draft_text: "edited reply" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, draft_state: "drafted" });
  });

  it("dismisses", async () => {
    const res = mkRes();
    await redditThreadUpdate(mkReq(ID, { draft_state: "dismissed" }), res);
    expect(mocks.update).toHaveBeenCalledWith({ svc: true }, "t1", ID, { draft_state: "dismissed" });
    expect(res.statusCode).toBe(200);
  });

  it.each([[{}], [{ draft_state: "drafted" }], [{ draft_state: "drafted", draft_text: "   " }], [{ draft_state: "posted", draft_text: "x".repeat(4001) }]])(
    "400s an invalid body %#",
    async (body) => {
      const res = mkRes();
      await redditThreadUpdate(mkReq(ID, body), res);
      expect(res.statusCode).toBe(400);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it("404s with the gone message when the thread is not the tenant's, or the id is malformed", async () => {
    mocks.update.mockResolvedValue("not_found");
    const res = mkRes();
    await redditThreadUpdate(mkReq(ID, { draft_state: "posted" }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "not_found", message: THREAD_GONE });

    const bad = mkRes();
    await redditThreadUpdate(mkReq("nope", { draft_state: "posted" }), bad);
    expect(bad.statusCode).toBe(404);
    expect(bad.body).toEqual({ error: "not_found", message: THREAD_GONE });
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ draft_state: "drafted", draft_text: "rewrite" }],
    [{ draft_state: "dismissed" }],
  ])("409s ALREADY_POSTED when a posted thread is re-drafted or dismissed (%#), never 200", async (body) => {
    mocks.update.mockResolvedValue("already_posted");
    const res = mkRes();
    await redditThreadUpdate(mkReq(ID, body), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "already_posted", message: ALREADY_POSTED });
  });

  it("500s without leaking the error", async () => {
    mocks.update.mockRejectedValue(new Error("column draft_state does not exist"));
    const res = mkRes();
    await redditThreadUpdate(mkReq(ID, { draft_state: "posted" }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "reddit_thread_update_failed" });
  });
});
