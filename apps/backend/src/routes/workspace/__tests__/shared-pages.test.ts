
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const RUN_A = "11111111-1111-4111-1111-111111111111";
const PAGE_A = "22222222-2222-4222-2222-222222222222";
const PAGE_B = "33333333-3333-4333-3333-333333333333";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  publicLinks: vi.fn(async () => true),
  rows: [] as Array<Record<string, unknown>>,
  html: new Map<string, string>(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/settings", () => ({ getBoolSetting: mocks.publicLinks }));

function query(tid: string, changes?: Record<string, unknown>) {
  const filters = new Map<string, unknown>([["tenant_id", tid]]);
  const matching = () =>
    mocks.rows.filter((row) => Array.from(filters).every(([k, v]) => row[k] === v));
  const apply = () => {
    const hit = matching();
    if (changes) hit.forEach((r) => Object.assign(r, changes));
    return hit;
  };
  const chain = {
    select: () => chain,
    eq: (k: string, v: unknown) => {
      filters.set(k, v);
      return chain;
    },
    order: () => chain,
    limit: async () => ({ data: apply(), error: null }),
    maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
    single: async () => {
      const row = apply()[0];
      return row ? { data: row, error: null } : { data: null, error: { message: "no row" } };
    },
  };
  return chain;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({
    from: () => ({
      select: () => query(tid),
      update: (changes: Record<string, unknown>) => query(tid, changes),
    }),
  }),
  tenantStorage: () => ({
    from: () => ({
      download: async (path: string) => {
        const html = mocks.html.get(path);
        return html === undefined
          ? { data: null, error: { message: "missing" } }
          : { data: { text: async () => html }, error: null };
      },
    }),
  }),
}));

import {
  getSharedPage,
  listSharedPages,
  presentSharedPage,
  publishSharedPage,
  revokeSharedPage,
} from "../shared-pages";
import type { SharedPageRow } from "@/services/shared-pages/page";

function res() {
  const r = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(c: number) {
      r.statusCode = c;
      return r;
    },
    json(b: unknown) {
      r.body = b;
      return r;
    },
    setHeader(k: string, v: string) {
      r.headers[k] = v;
    },
  };
  return r;
}

function page(id: string, tenant: string, extra: Partial<SharedPageRow> = {}): SharedPageRow {
  return {
    id,
    tenant_id: tenant,
    run_id: RUN_A,
    title: "Q3 review",
    storage_path: `${tenant}/${id}.html`,
    status: "private",
    slug: null,
    expires_at: null,
    published_at: null,
    revoked_at: null,
    created_at: "2026-09-18T00:00:00Z",
    ...extra,
  };
}

beforeEach(() => {
  mocks.rows = [page(PAGE_A, TENANT_A), page(PAGE_B, TENANT_B)];
  mocks.html = new Map([
    [`${TENANT_A}/${PAGE_A}.html`, "<h1>A</h1>"],
    [`${TENANT_B}/${PAGE_B}.html`, "<h1>B</h1>"],
  ]);
  mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, user_id: "u" });
  mocks.publicLinks.mockResolvedValue(true);
});

const call = async (
  fn: (req: never, res: never) => Promise<void>,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
) => {
  const r = res();
  await fn({ params, query, headers: {} } as never, r as never);
  return r;
};

describe("shared pages owner routes", () => {
  it("serves the owner's page with the CSP pinned", async () => {
    const r = await call(getSharedPage, { id: PAGE_A });
    expect(r.statusCode).toBe(200);
    const body = r.body as { html: string; page: { visibility: string } };
    expect(body.html.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(body.html).toContain("<h1>A</h1>");
    expect(body.page.visibility).toBe("private");
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("404s another tenant's page on read, publish and revoke", async () => {
    for (const fn of [getSharedPage, publishSharedPage, revokeSharedPage]) {
      const r = await call(fn, { id: PAGE_B });
      expect(r.statusCode).toBe(404);
    }
    expect(mocks.rows.find((p) => p.id === PAGE_B)?.status).toBe("private");
  });

  it("publish mints a slug + 30-day expiry; publish again keeps the same link", async () => {
    const first = await call(publishSharedPage, { id: PAGE_A });
    expect(first.statusCode).toBe(200);
    const p1 = (first.body as { page: { visibility: string; public_url: string } }).page;
    expect(p1.visibility).toBe("public");
    expect(p1.public_url).toMatch(/\/[0-9A-Za-z]{22}$/);
    const row = mocks.rows.find((p) => p.id === PAGE_A)!;
    const days = (new Date(row.expires_at as string).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    const again = await call(publishSharedPage, { id: PAGE_A });
    expect((again.body as { page: { public_url: string } }).page.public_url).toBe(p1.public_url);
  });

  it("revoke kills the link, and re-publishing mints a NEW slug", async () => {
    await call(publishSharedPage, { id: PAGE_A });
    const oldSlug = mocks.rows.find((p) => p.id === PAGE_A)!.slug;
    const r = await call(revokeSharedPage, { id: PAGE_A });
    expect((r.body as { page: { visibility: string; public_url: null } }).page).toMatchObject({
      visibility: "private",
      public_url: null,
    });
    await call(publishSharedPage, { id: PAGE_A });
    expect(mocks.rows.find((p) => p.id === PAGE_A)!.slug).not.toBe(oldSlug);
  });

  it("refuses to publish when the workspace turned public links off", async () => {
    mocks.publicLinks.mockResolvedValue(false);
    const r = await call(publishSharedPage, { id: PAGE_A });
    expect(r.statusCode).toBe(403);
    expect((r.body as { error: { code: string } }).error.code).toBe("public_links_disabled");
    expect(mocks.rows.find((p) => p.id === PAGE_A)!.status).toBe("private");
    expect(mocks.publicLinks).toHaveBeenCalledWith("agent_deck_enabled", TENANT_A);
  });

  it("refuses to publish a page carrying a secret", async () => {
    mocks.html.set(`${TENANT_A}/${PAGE_A}.html`, `<p>ghp_${"a".repeat(36)}</p>`);
    const r = await call(publishSharedPage, { id: PAGE_A });
    expect(r.statusCode).toBe(422);
    expect(mocks.rows.find((p) => p.id === PAGE_A)!.status).toBe("private");
  });

  it("lists only the caller's pages for a run", async () => {
    mocks.rows.push(page(PAGE_B.replace("3333", "4444"), TENANT_B));
    const r = await call(listSharedPages, {}, { run_id: RUN_A });
    const pages = (r.body as { pages: Array<{ id: string }> }).pages;
    expect(pages.map((p) => p.id)).toEqual([PAGE_A]);
  });

  it("rejects a malformed id or run_id without a read", async () => {
    expect((await call(getSharedPage, { id: "../x" })).statusCode).toBe(404);
    expect((await call(listSharedPages, {}, { run_id: "nope" })).statusCode).toBe(400);
  });
});

describe("presentSharedPage", () => {
  it("shows an expired public link as private, with no url", () => {
    const view = presentSharedPage(
      page(PAGE_A, TENANT_A, { status: "public", slug: "x".repeat(22), expires_at: "2020-01-01T00:00:00Z" }),
    );
    expect(view).toMatchObject({ visibility: "private", public_url: null, expires_at: null });
  });
});
