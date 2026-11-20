import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { newSitePreviewSnapshotPath } from "@/services/sites/site-preview-snapshot";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261104120000_site_preview_snapshots.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const TA = "11111111-1111-4111-8111-111111111111";
const TB = "22222222-2222-4222-8222-222222222222";
const SA = "aaaaaaaa-0000-4000-8000-00000000000a";
const SB = "bbbbbbbb-0000-4000-8000-00000000000b";
const SGONE = "cccccccc-0000-4000-8000-00000000000c";

describe(FILE, () => {
  it("sorts after every migration before it", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261102180000_cgo_hypothesis_founder_answer.sql"));
  });
});

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

const path = (tenant: string, site: string, device: "desktop" | "mobile", token: string) => newSitePreviewSnapshotPath(tenant, site, device, token)!;

async function setSnap(tenant: string, site: string, device: string, p: string, at: string) {
  const { rows } = await db.query("select public.site_set_preview_snapshot($1, $2, $3, $4, $5::timestamptz, 1280, 800) as r", [tenant, site, device, p, at]);
  return rows[0].r as { outcome: string; replaced: string | null };
}

async function mark(tenant: string, site: string, at: string) {
  const { rows } = await db.query("select public.site_mark_preview_changed($1, $2, $3::timestamptz) as r", [tenant, site, at]);
  return rows[0].r as boolean;
}

async function snaps(site: string) {
  const { rows } = await db.query("select device, path, taken_at from public.site_preview_snapshots where site_id = $1 order by device", [site]);
  return rows;
}

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.tenants (id uuid primary key);
      create table public.sites (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, status text not null default 'live');
      insert into public.tenants values ('${TA}'), ('${TB}');
      insert into public.sites (id, tenant_id) values ('${SA}', '${TA}'), ('${SB}', '${TB}');
      insert into public.sites (id, tenant_id, status) values ('${SGONE}', '${TA}', 'deleted');
    `);
    await db.exec(sql);
    await db.exec(sql);
  });
  afterAll(async () => {
    await db?.close();
  });

  it("stores a snapshot and replaces it only with a newer one", async () => {
    const first = path(TA, SA, "desktop", "aaaaaaaaaaaa");
    expect(await setSnap(TA, SA, "desktop", first, "2026-10-13T10:00:00Z")).toEqual({ outcome: "set", replaced: null });
    const older = path(TA, SA, "desktop", "bbbbbbbbbbbb");
    expect((await setSnap(TA, SA, "desktop", older, "2026-10-13T09:59:59Z")).outcome).toBe("stale");
    expect((await setSnap(TA, SA, "desktop", older, "2026-10-13T10:00:00Z")).outcome).toBe("stale");
    const newer = path(TA, SA, "desktop", "cccccccccccc");
    expect(await setSnap(TA, SA, "desktop", newer, "2026-10-13T10:00:01Z")).toEqual({ outcome: "set", replaced: first });
    expect((await snaps(SA)).map((r) => r.path)).toEqual([newer]);
  });

  it("keeps desktop and mobile apart", async () => {
    const mobile = path(TA, SA, "mobile", "dddddddddddd");
    expect(await setSnap(TA, SA, "mobile", mobile, "2026-10-13T10:00:00Z")).toEqual({ outcome: "set", replaced: null });
    expect((await snaps(SA)).map((r) => r.device)).toEqual(["desktop", "mobile"]);
  });

  it("refuses a snapshot taken at or before the site last changed", async () => {
    expect(await mark(TA, SA, "2026-10-13T11:00:00Z")).toBe(true);
    expect((await setSnap(TA, SA, "desktop", path(TA, SA, "desktop", "eeeeeeeeeeee"), "2026-10-13T11:00:00Z")).outcome).toBe("stale");
    expect((await setSnap(TA, SA, "desktop", path(TA, SA, "desktop", "eeeeeeeeeeee"), "2026-10-13T10:30:00Z")).outcome).toBe("stale");
    expect((await setSnap(TA, SA, "desktop", path(TA, SA, "desktop", "ffffffffffff"), "2026-10-13T11:00:01Z")).outcome).toBe("set");
  });

  it("never moves the change mark backwards", async () => {
    await mark(TA, SA, "2026-10-13T12:00:00Z");
    await mark(TA, SA, "2026-10-13T08:00:00Z");
    const { rows } = await db.query("select preview_changed_at from public.sites where id = $1", [SA]);
    expect(new Date(rows[0].preview_changed_at).toISOString()).toBe("2026-10-13T12:00:00.000Z");
  });

  it("never stores another tenant's or another site's path, or a path for the other device", async () => {
    await expect(setSnap(TA, SA, "desktop", path(TB, SB, "desktop", "aaaaaaaaaaaa"), "2026-10-14T00:00:00Z")).rejects.toThrow(/not this site/);
    await expect(setSnap(TA, SA, "desktop", path(TA, SB, "desktop", "aaaaaaaaaaaa"), "2026-10-14T00:00:00Z")).rejects.toThrow(/not this site/);
    await expect(setSnap(TA, SA, "desktop", path(TA, SA, "mobile", "aaaaaaaaaaaa"), "2026-10-14T00:00:00Z")).rejects.toThrow(/not this site/);
    await expect(setSnap(TA, SA, "tablet", path(TA, SA, "desktop", "aaaaaaaaaaaa"), "2026-10-14T00:00:00Z")).rejects.toThrow(/desktop or mobile/);
  });

  it("answers not_found for a site of another tenant, or a deleted site, and writes nothing", async () => {
    expect((await setSnap(TB, SA, "desktop", path(TB, SA, "desktop", "aaaaaaaaaaaa"), "2026-10-14T00:00:00Z")).outcome).toBe("not_found");
    expect((await setSnap(TA, SGONE, "desktop", path(TA, SGONE, "desktop", "aaaaaaaaaaaa"), "2026-10-14T00:00:00Z")).outcome).toBe("not_found");
    expect(await snaps(SGONE)).toEqual([]);
    expect(await mark(TB, SA, "2026-10-14T00:00:00Z")).toBe(false);
  });

  it("is service-role only", async () => {
    const { rows } = await db.query(`
      select has_function_privilege('authenticated', 'public.site_set_preview_snapshot(uuid, uuid, text, text, timestamptz, integer, integer)', 'execute') as set_auth,
             has_function_privilege('anon', 'public.site_mark_preview_changed(uuid, uuid, timestamptz)', 'execute') as mark_anon,
             has_function_privilege('service_role', 'public.site_set_preview_snapshot(uuid, uuid, text, text, timestamptz, integer, integer)', 'execute') as set_service,
             has_table_privilege('authenticated', 'public.site_preview_snapshots', 'select') as read_auth`);
    expect(rows[0]).toEqual({ set_auth: false, mark_anon: false, set_service: true, read_auth: false });
  });

  it("drops a site's snapshots with the site", async () => {
    await db.exec(`delete from public.sites where id = '${SA}'`);
    expect(await snaps(SA)).toEqual([]);
  });
});
