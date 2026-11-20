import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { SiteRow } from "@/services/sites/contract";

const h = vi.hoisted(() => ({ allowed: true, roles: [] as unknown[] }));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "t-1", user_id: "u-1" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, roles: unknown, res: Response) => {
    h.roles.push(roles);
    if (!h.allowed) res.status(403).json({ error: { code: "forbidden" } });
    return h.allowed;
  }),
}));
vi.mock("@/services/sites/store", () => ({ siteStore: () => ({}) }));

import { handleSiteRename, SITE_NAME_MAX, type SiteRenameDeps } from "../site-rename";

const ID = "33333333-3333-4333-8333-333333333333";
const SITE = { id: ID, tenant_id: "t-1", name: "Run Home Cleaning", status: "live" } as unknown as SiteRow;

function run(body: unknown, deps: SiteRenameDeps, id = ID) {
  let code = 0;
  let out: { name?: unknown; error?: { code?: string } } = {};
  const res = {
    status(c: number) { code = c; return this; },
    json(j: typeof out) { out = j; return this; },
  } as unknown as Response;
  return handleSiteRename({ body, params: { site_id: id } } as unknown as Request, res, deps).then(() => ({ code, out }));
}

const deps = (over: Partial<SiteRenameDeps> = {}): SiteRenameDeps & { setName: ReturnType<typeof vi.fn> } =>
  ({
    get: vi.fn(async () => SITE),
    setName: vi.fn(async (_t: string, _s: string, _e: string | null, name: string) => ({ outcome: "updated", name })),
    ...over,
  }) as never;

beforeEach(() => {
  h.allowed = true;
  h.roles = [];
});

describe("renaming a site in one tap", () => {
  it("saves the trimmed name against the name the server read, so a stale tab cannot overwrite a newer one", async () => {
    const d = deps();
    const { code, out } = await run({ name: "  Home Cleaning San Jose " }, d);
    expect(code).toBe(200);
    expect(out.name).toBe("Home Cleaning San Jose");
    expect(d.setName).toHaveBeenCalledWith("t-1", ID, "Run Home Cleaning", "Home Cleaning San Jose");
  });

  it("only owners and admins may rename", async () => {
    h.allowed = false;
    const d = deps();
    const { code } = await run({ name: "x" }, d);
    expect(code).toBe(403);
    expect(h.roles[0]).toEqual(["owner", "admin"]);
    expect(d.setName).not.toHaveBeenCalled();
  });

  it.each([[""], ["   "], [undefined], [7], ["x".repeat(SITE_NAME_MAX + 1)]])("refuses a bad name without writing (%j)", async (name) => {
    const d = deps();
    const { code } = await run({ name }, d);
    expect(code).toBe(400);
    expect(d.setName).not.toHaveBeenCalled();
  });

  it("another workspace's site is not found and is never written", async () => {
    const d = deps({ get: vi.fn(async () => ({ ...SITE, tenant_id: "t-2" })) });
    const { code } = await run({ name: "x" }, d);
    expect(code).toBe(404);
    expect(d.setName).not.toHaveBeenCalled();
  });

  it("a deleted site is not found and is never written", async () => {
    const d = deps({ get: vi.fn(async () => ({ ...SITE, status: "deleting" } as SiteRow)) });
    const { code } = await run({ name: "x" }, d);
    expect(code).toBe(404);
    expect(d.setName).not.toHaveBeenCalled();
  });

  it("a name changed underneath is a conflict, not a success", async () => {
    const d = deps({ setName: vi.fn(async () => ({ outcome: "stale_preview", name: null })) });
    const { code, out } = await run({ name: "x" }, d);
    expect(code).toBe(409);
    expect(out.error?.code).toBe("name_changed");
  });

  it("the same name again is fine, and a store failure says it did not save", async () => {
    expect((await run({ name: "Same" }, deps({ setName: vi.fn(async () => ({ outcome: "already_applied", name: "Same" })) }))).code).toBe(200);
    expect((await run({ name: "x" }, deps({ setName: vi.fn(async () => { throw new Error("db"); }) }))).code).toBe(500);
  });
});
