import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  role: "owner" as string,
  rpc: vi.fn(),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_a: unknown, allowed: readonly string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (allowed.includes(h.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  },
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (tid: string, name: string, args: Record<string, unknown>) => h.rpc(tid, name, args),
}));

import { getEmailSuppressionsHandler, postEmailSuppressionHandler } from "@/routes/workspace/email-suppressions";

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader() {
      return this;
    },
  };
}

const ROWS = { ok: true, rows: [{ email: "a@b.test", reason: "bounce", created_at: "2026-10-16T00:00:00Z" }], total: 1, page: 1, page_size: 50, masked: false };

beforeEach(() => {
  h.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-1" });
  h.role = "owner";
  h.rpc.mockReset().mockResolvedValue({ data: ROWS, error: null });
});

describe("GET /api/workspace/email-suppressions", () => {
  it("reads the session's workspace as the session's user, with the search and page passed through", async () => {
    const r = res();
    await getEmailSuppressionsHandler({ query: { search: " acme ", page: "3", tenant_id: "tenant-b" } } as never, r as never);
    expect(h.rpc).toHaveBeenCalledWith("tenant-a", "list_email_suppressions", { p_user_id: "user-1", p_search: "acme", p_page: 3 });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ rows: ROWS.rows, total: 1, page: 1, page_size: 50, masked: false });
  });

  it("a bad page reads page 1; an over-long search is cut", async () => {
    await getEmailSuppressionsHandler({ query: { page: "-4", search: "x".repeat(500) } } as never, res() as never);
    const args = h.rpc.mock.calls[0][2];
    expect(args.p_page).toBe(1);
    expect(args.p_search).toHaveLength(200);
  });

  it("someone the SQL does not know as a member gets a 403 and no rows", async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: "not_authorized" }, error: null });
    const r = res();
    await getEmailSuppressionsHandler({ query: {} } as never, r as never);
    expect(r.statusCode).toBe(403);
    expect(r.body.rows).toBeUndefined();
  });

  it("a database error is a 500 that leaks nothing", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "relation email_suppression: secret@x.test" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = res();
    await getEmailSuppressionsHandler({ query: {} } as never, r as never);
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("secret@x.test");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret@x.test");
    spy.mockRestore();
  });
});

describe("POST /api/workspace/email-suppressions", () => {
  it("an owner adds one address for the session's workspace", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, added: true, email: "new@x.test", reason: "manual", created_at: "2026-10-16T00:00:00Z" }, error: null });
    const r = res();
    await postEmailSuppressionHandler({ body: { email: "New@X.test" } } as never, r as never);
    expect(h.rpc).toHaveBeenCalledWith("tenant-a", "add_email_suppression", { p_user_id: "user-1", p_email: "New@X.test" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ added: true, email: "new@x.test", reason: "manual" });
  });

  it("a member is refused before anything is written", async () => {
    h.role = "member";
    const r = res();
    await postEmailSuppressionHandler({ body: { email: "new@x.test" } } as never, r as never);
    expect(r.statusCode).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("an overridden (staff) workspace writes nothing", async () => {
    h.requireAuth.mockResolvedValue({ tenant_id: "tenant-b", user_id: "staff-1", tenant_overridden: true });
    const r = res();
    await postEmailSuppressionHandler({ body: { email: "new@x.test" } } as never, r as never);
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("tenant_override_forbidden");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a strict body: an extra field or no email is a 400 and nothing is written", async () => {
    for (const body of [{ email: "a@b.test", tenant_id: "tenant-b" }, {}, { email: 5 }]) {
      const r = res();
      await postEmailSuppressionHandler({ body } as never, r as never);
      expect(r.statusCode).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("the SQL's refusals keep their meaning: bad_email 400, not_authorized 403", async () => {
    h.rpc.mockResolvedValueOnce({ data: { ok: false, code: "bad_email" }, error: null });
    const bad = res();
    await postEmailSuppressionHandler({ body: { email: "nobody@x" } } as never, bad as never);
    expect(bad.statusCode).toBe(400);
    h.rpc.mockResolvedValueOnce({ data: { ok: false, code: "not_authorized" }, error: null });
    const no = res();
    await postEmailSuppressionHandler({ body: { email: "a@b.test" } } as never, no as never);
    expect(no.statusCode).toBe(403);
  });
});
