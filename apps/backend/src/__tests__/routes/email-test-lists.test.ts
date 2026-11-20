import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ requireAuth: vi.fn(), role: "owner" as string }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_a: unknown, allowed: string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (allowed.includes(h.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  },
  loadTenantRole: async () => h.role,
}));

import { emailTestListHandlers } from "@/routes/workspace/email-test-lists";

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

beforeEach(() => {
  h.requireAuth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-1" });
  h.role = "owner";
});

describe("email test lists routes", () => {
  it("GET reads the session's workspace", async () => {
    const read = vi.fn(async () => ({ routes: [], orphans: [] }));
    const r = res();
    await emailTestListHandlers({ read, set: vi.fn() }).list({ query: { tenant_id: "tenant-b" } } as never, r as never);
    expect(read).toHaveBeenCalledWith("tenant-a", {});
    expect(r.body).toEqual({ routes: [], orphans: [] });
  });

  it.each(["member", "viewer"])("GET for a %s reads Zavi lists with database list sizes withheld", async (role) => {
    h.role = role;
    const read = vi.fn(async (_t: string, _d?: unknown) => ({ routes: [], orphans: [] }));
    await emailTestListHandlers({ read, set: vi.fn() }).list({ query: {} } as never, res() as never);
    expect(read).toHaveBeenCalledWith("tenant-a", { zaviLists: expect.any(Function) });
  });

  it("GET adds whether Gmail is connected, checked for the session's workspace, and keeps it out of the list routes", async () => {
    const read = vi.fn(async () => ({ routes: [{ route: "zavi_list" as const, label: "Zavi lists", status: "complete" as const, error: null, lists: [] }], orphans: [] }));
    const gmail = vi.fn(async () => ({ status: "connected" as const }));
    const r = res();
    await emailTestListHandlers({ read, set: vi.fn(), gmail }).list({ query: { tenant_id: "tenant-b" } } as never, r as never);
    expect(gmail).toHaveBeenCalledWith("tenant-a");
    expect(gmail).toHaveBeenCalledTimes(1);
    expect(r.body).toEqual({ routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] }], orphans: [], gmail: { status: "connected" } });
    expect(r.body.routes.map((x: { route: string }) => x.route)).not.toContain("gmail");
  });

  it("POST marks one list as the session's user; a member is refused before anything runs", async () => {
    const set = vi.fn(async () => ({ ok: true as const, changed: true, marked: true }));
    const r = res();
    await emailTestListHandlers({ read: vi.fn(), set }).set({ body: { route: "klaviyo", list_id: "K1", marked: true } } as never, r as never);
    expect(set).toHaveBeenCalledWith("tenant-a", "user-1", "klaviyo", "K1", true);
    h.role = "member";
    const m = res();
    await emailTestListHandlers({ read: vi.fn(), set }).set({ body: { route: "klaviyo", list_id: "K1", marked: true } } as never, m as never);
    expect(m.statusCode).toBe(403);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("a strict body: no tenant, no unknown route, a safe list id", async () => {
    const set = vi.fn();
    for (const body of [{ route: "klaviyo", list_id: "K1", marked: true, tenant_id: "x" }, { route: "gmail", list_id: "K1", marked: true }, { route: "klaviyo", list_id: "a/b", marked: true }]) {
      const r = res();
      await emailTestListHandlers({ read: vi.fn(), set }).set({ body } as never, r as never);
      expect(r.statusCode).toBe(400);
    }
    expect(set).not.toHaveBeenCalled();
  });

  it("a refusal keeps its sentence and status", async () => {
    const r = res();
    await emailTestListHandlers({ read: vi.fn(), set: async () => ({ ok: false as const, code: "could_not_check", message: "Zavi could not read every list." }) }).set(
      { body: { route: "mailchimp", list_id: "L1", marked: false } } as never,
      r as never,
    );
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toEqual({ code: "could_not_check", message: "Zavi could not read every list." });
  });
});
