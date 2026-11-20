import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  auth: { tenant_id: "", user_id: "u1", access_token: "tok" } as { tenant_id: string; user_id: string; access_token: string } | null,
  role: "owner" as string,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: unknown, res: Response) => {
    if (!mocks.auth) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return null;
    }
    return mocks.auth;
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, roles: readonly string[], res: Response) => {
    if (roles.includes(mocks.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  }),
}));

import { handleSiteSearchRelease, type SiteSearchReleaseDeps } from "../site-search-release";
import { hostKey, renderHostRecord } from "@/services/sites/host-record";
import type { SiteRow } from "@/services/sites/contract";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const SITE = "33333333-3333-4333-8333-333333333333";
const HOST = "home-cleaning-san-jose.zaviagent.com";

function siteRow(over: Partial<SiteRow> = {}): SiteRow {
  return {
    id: SITE,
    tenant_id: T1,
    root_conductor_run_id: null,
    started_by_user_id: null,
    owner_email: null,
    label: "home-cleaning-san-jose",
    hostname: HOST,
    github_full_name: "zavi-sites/x",
    supabase_project_ref: null,
    supabase_url: null,
    status: "live",
    live_url: `https://${HOST}`,
    desired_sha: "abc",
    live_sha: "abc",
    live_deploy_id: "d000000001-0a1b2c3d",
    last_visit_at: null,
    last_edit_at: null,
    paused_at: null,
    last_error: null,
    host_version: 4,
    search_released_at: null,
    created_at: "2026-11-19T00:00:00Z",
    updated_at: "2026-11-19T00:00:00Z",
    ...over,
  } as SiteRow;
}

function world(initial: SiteRow) {
  let db = { ...initial };
  const kv = new Map<string, string>();
  kv.set(hostKey(HOST), JSON.stringify(renderHostRecord(db)!.value));
  const calls = { release: 0, bump: 0, verify: 0 };
  const deps: SiteSearchReleaseDeps = {
    get: async (t, id) => (id === db.id && t === db.tenant_id ? { ...db } : null),
    release: async (t, id) => {
      calls.release += 1;
      if (t !== db.tenant_id || id !== db.id) throw new Error("not found");
      if (db.search_released_at === null) db = { ...db, search_released_at: "2026-11-19T01:00:00Z", host_version: (db.host_version ?? 0) + 1 };
      return { ...db };
    },
    host: async () => ({
      kv: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) },
      bump: async () => {
        calls.bump += 1;
        db = { ...db, host_version: (db.host_version ?? 0) + 1 };
        return { ...db };
      },
      get: async (t, id) => (id === db.id && t === db.tenant_id ? { ...db } : null),
      requestVerify: async () => void (calls.verify += 1),
    }),
  };
  return { deps, kv, calls, row: () => db };
}

function res() {
  const out = { status: 0, body: undefined as unknown };
  const r = {
    status(c: number) {
      out.status = c;
      return r;
    },
    json(b: unknown) {
      out.body = b;
      return r;
    },
  } as unknown as Response;
  return { r, out };
}
const req = (site_id: string) => ({ params: { site_id } }) as unknown as Request;
const kvRecord = (kv: Map<string, string>) => JSON.parse(kv.get(hostKey(HOST))!);

beforeEach(() => {
  mocks.auth = { tenant_id: T1, user_id: "u1", access_token: "tok" };
  mocks.role = "owner";
});

describe("POST /api/workspace/autopilot/sites/:site_id/looks-good", () => {
  it("releases a held site and the live host record drops noindex in the same request", async () => {
    const w = world(siteRow());
    expect(kvRecord(w.kv).noindex).toBe(true);
    const { r, out } = res();
    await handleSiteSearchRelease(req(SITE), r, w.deps);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ search_hidden: false });
    expect(w.calls.release).toBe(1);
    expect(kvRecord(w.kv).noindex).toBeUndefined();
    expect(kvRecord(w.kv).deploy_id).toBe("d000000001-0a1b2c3d");
    expect(kvRecord(w.kv).rv).toBe(w.row().host_version);
    expect(w.calls.verify).toBe(1);
  });

  it("another workspace's site is not found and never released", async () => {
    mocks.auth = { tenant_id: T2, user_id: "u2", access_token: "tok" };
    const w = world(siteRow());
    const { r, out } = res();
    await handleSiteSearchRelease(req(SITE), r, w.deps);
    expect(out.status).toBe(404);
    expect(w.calls.release).toBe(0);
    expect(kvRecord(w.kv).noindex).toBe(true);
  });

  it("a viewer cannot release it", async () => {
    mocks.role = "viewer";
    const w = world(siteRow());
    const { r, out } = res();
    await handleSiteSearchRelease(req(SITE), r, w.deps);
    expect(out.status).toBe(403);
    expect(w.calls.release).toBe(0);
  });

  it("an already released site is a no-op: no RPC, no KV write", async () => {
    const w = world(siteRow({ search_released_at: "2026-11-18T00:00:00Z" }));
    const before = w.kv.get(hostKey(HOST));
    const { r, out } = res();
    await handleSiteSearchRelease(req(SITE), r, w.deps);
    expect(out.status).toBe(200);
    expect(w.calls.release).toBe(0);
    expect(w.calls.bump).toBe(0);
    expect(w.kv.get(hostKey(HOST))).toBe(before);
  });

  it("a KV outage still saves the release (the bumped version leaves the row drifted for the sweep)", async () => {
    const w = world(siteRow());
    const deps: SiteSearchReleaseDeps = {
      ...w.deps,
      host: async () => ({ ...(await w.deps.host()), kv: { get: async () => { throw new Error("kv down"); }, put: async () => undefined } }),
    };
    const { r, out } = res();
    await handleSiteSearchRelease(req(SITE), r, deps);
    expect(out.status).toBe(200);
    expect(w.row().search_released_at).not.toBeNull();
    expect(w.row().host_version).toBeGreaterThan(4);
  });

  it("a failed release is reported, never claimed done", async () => {
    const w = world(siteRow());
    const deps: SiteSearchReleaseDeps = { ...w.deps, release: async () => { throw new Error("db down"); } };
    const { r, out } = res();
    await handleSiteSearchRelease(req(SITE), r, deps);
    expect(out.status).toBe(500);
    expect(kvRecord(w.kv).noindex).toBe(true);
  });

  it("refuses a malformed id", async () => {
    const w = world(siteRow());
    const { r, out } = res();
    await handleSiteSearchRelease(req("not-a-uuid"), r, w.deps);
    expect(out.status).toBe(400);
    expect(w.calls.release).toBe(0);
  });
});
