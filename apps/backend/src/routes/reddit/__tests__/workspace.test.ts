import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  suggest: vi.fn(),
  deleteRow: vi.fn(),
  readCompetitorName: vi.fn(),
  consume: vi.fn(),
  markerAt: vi.fn(),
  addToRecord: vi.fn(),
  createCompetitor: vi.fn(),
  backfill: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
  eqs: [] as Array<[string, unknown]>,
}));

const fakeDb = {
  from(table: string) {
    const chain = {
      table,
      select() {
        return chain;
      },
      eq(col: string, val: unknown) {
        mocks.eqs.push([col, val]);
        return chain;
      },
      limit() {
        return Promise.resolve({ data: mocks.rows, error: null });
      },
    };
    return chain;
  },
};

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/channels/reddit/db", () => ({ redditDb: () => fakeDb }));
vi.mock("@/services/tenant-client", () => ({
  consumeTenantRateLimit: mocks.consume,
  tenantMarkerAt: mocks.markerAt,
}));
vi.mock("@/services/channels/reddit/suggest", () => ({ suggestRedditSetup: mocks.suggest }));
vi.mock("@/services/channels/reddit/sweep", () => ({ backfillTermMentions: mocks.backfill }));
vi.mock("@/services/company/facts", () => ({
  addCompetitorToRecord: mocks.addToRecord,
  removeCompetitorFromRecord: vi.fn(),
}));
vi.mock("@/services/channels/reddit/workspace", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/reddit/workspace")>()),
  deleteRow: mocks.deleteRow,
  readCompetitorName: mocks.readCompetitorName,
  createCompetitor: mocks.createCompetitor,
}));

import { redditCompetitorCreate, redditWorkspaceDelete, redditWorkspaceSuggest } from "../workspace";

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
    end() {
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};
const mkReq = (params: Record<string, string> = {}, body: unknown = {}) =>
  ({ body, query: {}, params }) as unknown as Request;

const OK = { ok: true, keywords_added: 1, competitors_added: 0, sources: { company_profile: true, search_console_queries: 0, geo_prompts: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.rows = [];
  mocks.eqs = [];
  mocks.consume.mockResolvedValue(true);
  mocks.markerAt.mockResolvedValue(null);
  mocks.addToRecord.mockResolvedValue({ ok: true });
  mocks.createCompetitor.mockResolvedValue({ id: ID, name: "Rival", status: "suggested" });
  mocks.backfill.mockResolvedValue(undefined);
  mocks.requireAuth.mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "tok" });
  mocks.suggest.mockResolvedValue(OK);
  mocks.deleteRow.mockResolvedValue(true);
  mocks.readCompetitorName.mockResolvedValue(null);
});

describe("POST /api/reddit/workspace/suggest", () => {
  it("stops at auth", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    await redditWorkspaceSuggest(mkReq(), mkRes());
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it("suggests for the authenticated tenant, handing the service a claim on the DB limiter", async () => {
    const res = mkRes();
    await redditWorkspaceSuggest(mkReq({}, { tenant_id: "evil" }), res);
    expect(mocks.suggest).toHaveBeenCalledWith(expect.anything(), "t1", {}, { claim: expect.any(Function) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(OK);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("the claim spends 1 of 6 per hour in the auth tenant's reddit_suggest bucket", async () => {
    let claimed: boolean | undefined;
    mocks.suggest.mockImplementation(async (_sb, _t, _deps, opts: { claim: () => Promise<boolean> }) => {
      claimed = await opts.claim();
      return OK;
    });
    mocks.consume.mockResolvedValue(false);
    await redditWorkspaceSuggest(mkReq({}, { tenant_id: "evil" }), mkRes());
    expect(claimed).toBe(false);
    expect(mocks.consume).toHaveBeenCalledTimes(1);
    expect(mocks.consume).toHaveBeenCalledWith("t1", "reddit_suggest", 6, 3600);
  });

  it("429s rate_limited with minutes left from the DB window start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T12:59:30Z"));
    mocks.markerAt.mockResolvedValue(Date.parse("2026-09-18T12:00:00Z"));
    mocks.suggest.mockResolvedValue({ ok: false, code: "rate_limited", message: "x" });
    const res = mkRes();
    await redditWorkspaceSuggest(mkReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: "rate_limited",
      message: "Zavi has drafted suggestions 6 times this hour. Try again in 1 minute.",
      retry_after_s: 30,
    });
    expect(mocks.markerAt).toHaveBeenCalledWith("t1", "reddit_suggest");
  });

  it("429 falls back to a full hour when the window read fails", async () => {
    mocks.markerAt.mockRejectedValue(new Error("down"));
    mocks.suggest.mockResolvedValue({ ok: false, code: "rate_limited", message: "x" });
    const res = mkRes();
    await redditWorkspaceSuggest(mkReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ retry_after_s: 3600, message: expect.stringContaining("Try again in 60 minutes.") });
  });

  it("maps context_missing to 422 and draft_failed to 502 with the service message", async () => {
    mocks.suggest.mockResolvedValueOnce({ ok: false, code: "context_missing", message: "Add your company" });
    const a = mkRes();
    await redditWorkspaceSuggest(mkReq(), a);
    expect(a.statusCode).toBe(422);
    expect(a.body).toEqual({ error: "context_missing", message: "Add your company" });
    mocks.suggest.mockResolvedValueOnce({ ok: false, code: "draft_failed", message: "Try again" });
    const b = mkRes();
    await redditWorkspaceSuggest(mkReq(), b);
    expect(b.statusCode).toBe(502);
    expect(b.body).toEqual({ error: "draft_failed", message: "Try again" });
  });
});

describe("POST /api/reddit/workspace/competitors", () => {
  it("409s 'Already saved.' for a look-alike of a tracked rival and writes neither the record nor a row", async () => {
    mocks.rows = [{ item: "drivemobi", status: "tracking" }];
    const res = mkRes();
    await redditCompetitorCreate(mkReq({}, { name: "Drive-Mо́bi" }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "already_exists", message: "Already saved." });
    expect(mocks.addToRecord).not.toHaveBeenCalled();
    expect(mocks.createCompetitor).not.toHaveBeenCalled();
    expect(mocks.eqs).toEqual(
      expect.arrayContaining([
        ["tenant_id", "t1"],
        ["status", "tracking"],
      ]),
    );
  });

  it("creates when no tracked rival matches; C# is not a duplicate of C++", async () => {
    mocks.rows = [{ item: "C++", status: "tracking" }];
    const res = mkRes();
    await redditCompetitorCreate(mkReq({}, { name: "C#" }), res);
    expect(res.statusCode).toBe(201);
    expect(mocks.addToRecord).toHaveBeenCalledWith("t1", "C#", "reddit panel, user u1");
    expect(mocks.createCompetitor).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/reddit/workspace/:kind/:id", () => {
  it("deletes (or, for the auto brand, dismisses) through deleteRow with the auth tenant", async () => {
    const res = mkRes();
    await redditWorkspaceDelete(mkReq({ kind: "keywords", id: ID }), res);
    expect(mocks.deleteRow).toHaveBeenCalledWith(expect.anything(), "t1", "keywords", ID);
    expect(res.statusCode).toBe(204);
  });

  it("404s when nothing matched", async () => {
    mocks.deleteRow.mockResolvedValue(false);
    const res = mkRes();
    await redditWorkspaceDelete(mkReq({ kind: "competitors", id: ID }), res);
    expect(res.statusCode).toBe(404);
  });
});
