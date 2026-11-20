import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ requireAuth: vi.fn(), readiness: vi.fn(), create: vi.fn(), search: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/connectors/pinterest-composio/readiness", () => ({
  BOARD_NAME_MAX: 50,
  BOARD_DESCRIPTION_MAX: 500,
  resolvePinterestPublishReadiness: m.readiness,
  createPinterestBoard: m.create,
  searchPinterestBoards: m.search,
}));

import { pinterestBoardCreate, pinterestBoardSearch, pinterestReadinessGet } from "../pinterest-readiness";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
function res() {
  const r = { _status: 200, _body: undefined as unknown, status: vi.fn(), json: vi.fn() };
  r.status.mockImplementation((n: number) => { r._status = n; return r; });
  r.json.mockImplementation((b: unknown) => { r._body = b; return r; });
  return r;
}

beforeEach(() => {
  m.requireAuth.mockReset().mockResolvedValue({ tenant_id: TENANT, user_id: "u" });
  m.readiness.mockReset();
  m.create.mockReset();
  m.search.mockReset();
});

describe("GET /api/channels/pinterest_organic/readiness", () => {
  it("reads account-level board readiness for the caller's tenant only", async () => {
    const readiness = { ok: false, checks: { board: { status: "fail", reason_code: "pinterest_no_boards", reason: "no boards" } }, reason: "no boards" };
    m.readiness.mockResolvedValue(readiness);
    const r = res();
    await pinterestReadinessGet({ query: { tenant_id: "someone-else" }, body: { tenant_id: "x" } } as never, r as never);
    expect(m.readiness).toHaveBeenCalledWith(TENANT, undefined, { only: ["board"] });
    expect(r._body).toEqual({ connected: true, readiness });
  });

  it("says not connected when the account is not linked", async () => {
    m.readiness.mockResolvedValue({ ok: false, checks: { board: { status: "fail", reason_code: "pinterest_not_connected" } } });
    const r = res();
    await pinterestReadinessGet({} as never, r as never);
    expect((r._body as { connected: boolean }).connected).toBe(false);
  });

  it("does nothing without auth", async () => {
    m.requireAuth.mockResolvedValue(null);
    const r = res();
    await pinterestReadinessGet({} as never, r as never);
    expect(m.readiness).not.toHaveBeenCalled();
    expect(r.json).not.toHaveBeenCalled();
  });
});

describe("POST /api/channels/pinterest_organic/boards", () => {
  it("creates the board on the caller's tenant only, never one named in the request", async () => {
    m.create.mockResolvedValue({ ok: true, board: { id: "9001", name: "Autumn", privacy: "PUBLIC" } });
    const r = res();
    await pinterestBoardCreate({ body: { name: " Autumn ", description: "Ideas", tenant_id: "someone-else" }, query: { tenant_id: "x" } } as never, r as never);
    expect(m.create).toHaveBeenCalledWith(TENANT, { name: "Autumn", description: "Ideas" });
    expect(r._status).toBe(200);
    expect(r._body).toEqual({ board: { id: "9001", label: "Autumn" } });
  });

  it.each([[{}], [{ name: "   " }], [{ name: "x".repeat(51) }], [{ name: "ok", description: "y".repeat(501) }]])("refuses %j without calling Pinterest", async (body) => {
    const r = res();
    await pinterestBoardCreate({ body } as never, r as never);
    expect(r._status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });

  it.each([
    ["not_connected", 409],
    ["name_taken", 409],
    ["refused", 422],
    ["unconfirmed", 502],
  ])("%s answers %i with the plain message", async (code, status) => {
    m.create.mockResolvedValue({ ok: false, code, message: `msg ${code}` });
    const r = res();
    await pinterestBoardCreate({ body: { name: "A" } } as never, r as never);
    expect(r._status).toBe(status);
    expect(r._body).toEqual({ error: { code, message: `msg ${code}` } });
  });

  it("does nothing without auth", async () => {
    m.requireAuth.mockResolvedValue(null);
    const r = res();
    await pinterestBoardCreate({ body: { name: "A" } } as never, r as never);
    expect(m.create).not.toHaveBeenCalled();
    expect(r.json).not.toHaveBeenCalled();
  });

  it("refuses a staff tenant override: no board on someone else's account", async () => {
    m.requireAuth.mockResolvedValue({ tenant_id: "other", user_id: "staff", tenant_overridden: true });
    const r = res();
    await pinterestBoardCreate({ body: { name: "A" } } as never, r as never);
    expect(m.create).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(403);
  });
});

describe("GET /api/channels/pinterest_organic/boards/search", () => {
  it("searches the caller's tenant and leaves secret boards out of the picker", async () => {
    m.search.mockResolvedValue({ ok: true, complete: true, boards: [{ id: "1", name: "Linen", privacy: "PUBLIC" }, { id: "2", name: "Hidden", privacy: "secret" }, { id: "3", name: "Old", privacy: null }] });
    const r = res();
    await pinterestBoardSearch({ query: { q: " lin ", tenant_id: "someone-else" } } as never, r as never);
    expect(m.search).toHaveBeenCalledWith(TENANT, "lin");
    expect(r._body).toEqual({ boards: [{ id: "1", label: "Linen" }, { id: "3", label: "Old" }], complete: true });
  });

  it("says when the search stopped at the first page", async () => {
    m.search.mockResolvedValue({ ok: true, complete: false, boards: [{ id: "2", name: "Hidden", privacy: "SECRET" }] });
    const r = res();
    await pinterestBoardSearch({ query: { q: "hid" } } as never, r as never);
    expect(r._body).toEqual({ boards: [], complete: false });
  });

  it("an empty query is refused without calling Pinterest", async () => {
    const r = res();
    await pinterestBoardSearch({ query: { q: "  " } } as never, r as never);
    expect(r._status).toBe(400);
    expect(m.search).not.toHaveBeenCalled();
  });

  it("a failed search is an error, never an empty list", async () => {
    m.search.mockResolvedValue({ ok: false, code: "pinterest_lookup_failed" });
    const r = res();
    await pinterestBoardSearch({ query: { q: "lin" } } as never, r as never);
    expect(r._status).toBe(502);
    expect((r._body as { boards?: unknown }).boards).toBeUndefined();
  });

  it("says not connected", async () => {
    m.search.mockResolvedValue({ ok: false, code: "pinterest_not_connected" });
    const r = res();
    await pinterestBoardSearch({ query: { q: "lin" } } as never, r as never);
    expect(r._status).toBe(409);
    expect((r._body as { error: { code: string } }).error.code).toBe("not_connected");
  });
});
