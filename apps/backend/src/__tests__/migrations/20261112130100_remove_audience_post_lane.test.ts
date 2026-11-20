import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CREATOR_LANES, CREATOR_PACKAGE_KINDS, checkCreatorPackage } from "@zavi/shared";
import { openPglite } from "@/services/growth/booking-metrics/__tests__/pglite";

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261112130100_remove_audience_post_lane.sql";
const sql = readFileSync(join(DIR, FILE), "utf-8");

const T1 = "91111230-0000-4000-8000-000000000001";
const T2 = "91111230-0000-4000-8000-000000000002";
const M_BOTH = "91111230-0000-4000-8000-0000000000a1";
const M_AUD = "91111230-0000-4000-8000-0000000000a2";
const M_UGC = "91111230-0000-4000-8000-0000000000a3";
const M_NULL = "91111230-0000-4000-8000-0000000000a4";
const P_AUD = "91111230-0000-4000-8000-0000000000b1";
const P_UGC = "91111230-0000-4000-8000-0000000000b2";
const P_AUD2 = "91111230-0000-4000-8000-0000000000b3";
const P_AUD_OFF = "91111230-0000-4000-8000-0000000000b4";
const P_UGC_OFF = "91111230-0000-4000-8000-0000000000b5";
const O_AUD_OPEN = "91111230-0000-4000-8000-0000000000c1";
const O_AUD_ACCEPTED = "91111230-0000-4000-8000-0000000000c2";
const O_UGC_OPEN = "91111230-0000-4000-8000-0000000000c3";
const O_AUD_EXPIRED = "91111230-0000-4000-8000-0000000000c4";
const B_AUD_SENT = "91111230-0000-4000-8000-0000000000d1";
const B_AUD_DRAFT = "91111230-0000-4000-8000-0000000000d2";
const B_AUD_FILLED = "91111230-0000-4000-8000-0000000000d3";
const B_UGC = "91111230-0000-4000-8000-0000000000d4";
const B_NULL = "91111230-0000-4000-8000-0000000000d5";
const A_APPLIED = "91111230-0000-4000-8000-0000000000e1";
const A_SHORT = "91111230-0000-4000-8000-0000000000e2";
const A_APPROVED = "91111230-0000-4000-8000-0000000000e3";
const A_UGC = "91111230-0000-4000-8000-0000000000e4";
const A_OTHER_TENANT = "91111230-0000-4000-8000-0000000000e5";
const A_NULL_LANE = "91111230-0000-4000-8000-0000000000e6";
const OLD = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2999-01-01T00:00:00.000Z";

const iso = (v: unknown) => new Date(v as string).toISOString();
const one = async (table: string, id: string) => (await db.query(`select * from ${table} where id = $1`, [id])).rows[0];
const all = async (table: string) => (await db.query(`select * from ${table} order by id`)).rows;
const search = async (args: { lane?: string | null; max_price?: number | null } = {}) =>
  (
    await db.query(
      "select human_member_id, lanes, from_price_cents, packages from search_creators($1::uuid, 'newest', $2::text, null, null, $3::integer, null, null, null, 50, 0)",
      [T1, args.lane ?? null, args.max_price ?? null],
    )
  ).rows;

describe(FILE, () => {
  it("sorts after every migration on main before it", () => {
    const all = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261111220000_cgo_missed_reviews_name_failed_run.sql"));
  });

  it("is the newest definition of search_creators until 20261119130000 re-creates it", () => {
    const later = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f > FILE && f !== "20261119130000_creator_earn_mode.sql")
      .filter((f) => /function\s+search_creators/i.test(readFileSync(join(DIR, f), "utf-8")));
    expect(later).toEqual([]);
  });
});

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)(`${FILE}: the audience post lane is retired without touching history (pglite)`, () => {
  let afterFirst: Record<string, any[]>;

  beforeAll(async () => {
    db = (await openPglite()) as Db;
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create table public.tenant_users (tenant_id uuid not null, user_id uuid not null);
      create function public.creator_payout_country_supported(p_country_code text) returns boolean
        language sql immutable as $$ select coalesce(p_country_code, '') = 'US' $$;
      create table public.human_members (
        id uuid primary key,
        slug text,
        display_name text,
        skills text[],
        city text,
        country_code text,
        intro_video_path text,
        public_metrics jsonb,
        vetting_state text not null,
        lanes text[] check (lanes is null or lanes <@ array['ugc_video', 'audience_post']::text[]),
        created_at timestamptz not null default now(),
        updated_at timestamptz
      );
      create table public.human_member_handles (
        human_member_id uuid not null references public.human_members(id),
        platform text not null,
        handle text not null,
        followers integer
      );
      create table public.creator_packages (
        id uuid primary key,
        human_member_id uuid not null references public.human_members(id),
        kind text not null check (kind in ('ugc_video', 'audience_post')),
        title text not null,
        description text,
        price_cents integer not null,
        currency text not null default 'usd',
        delivery_days integer not null,
        video_count integer,
        video_length_seconds integer,
        ad_rights_days integer,
        addons jsonb not null default '[]'::jsonb,
        platform text,
        post_type text,
        stays_up_days integer,
        post_count integer check (post_count is null or post_count between 1 and 20),
        ad_label_required boolean not null default true,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check (post_count is null or kind = 'audience_post'),
        check (
          (kind = 'ugc_video'
             and video_count is not null and video_length_seconds is not null and ad_rights_days is not null
             and platform is null and post_type is null and stays_up_days is null)
          or
          (kind = 'audience_post'
             and platform is not null and post_type is not null and stays_up_days is not null
             and video_count is null and video_length_seconds is null and ad_rights_days is null)
        )
      );
      create table public.creator_orders (
        id uuid primary key,
        status text not null,
        package_snapshot jsonb
      );
      create table public.creator_offers (
        id uuid primary key,
        tenant_id uuid not null,
        human_member_id uuid not null,
        kind text not null check (kind in ('ugc_video', 'audience_post')),
        status text not null check (status in ('open', 'accepted', 'declined', 'expired', 'withdrawn')),
        expires_at timestamptz not null,
        responded_at timestamptz,
        updated_at timestamptz not null
      );
      create table public.creator_briefs (
        id uuid primary key,
        tenant_id uuid not null,
        status text not null check (status in ('draft', 'sent', 'filled', 'cancelled')),
        lane text check (lane is null or lane in ('ugc_video', 'audience_post')),
        posted_at timestamptz,
        closed_at timestamptz,
        updated_at timestamptz not null
      );
      create table public.brief_applications (
        id uuid primary key,
        tenant_id uuid not null,
        brief_kind text not null default 'creative' check (brief_kind in ('creative')),
        brief_id uuid not null,
        human_member_id uuid not null,
        status text not null check (status in ('applied', 'shortlisted', 'approved', 'rejected', 'withdrawn')),
        updated_at timestamptz not null
      );
    `);

    const member = (id: string, name: string, lanes: string[] | null, created: string) =>
      db.query(
        "insert into human_members (id, slug, display_name, skills, country_code, vetting_state, lanes, created_at, updated_at) values ($1, $2, $3, '{}', 'US', 'approved', $4, $5, $6)",
        [id, name.toLowerCase(), name, lanes, created, OLD],
      );
    await member(M_BOTH, "Both", ["ugc_video", "audience_post"], "2026-09-04T00:00:00Z");
    await member(M_AUD, "Audience", ["audience_post"], "2026-09-03T00:00:00Z");
    await member(M_UGC, "Ugc", ["ugc_video"], "2026-09-02T00:00:00Z");
    await member(M_NULL, "Unset", null, "2026-09-01T00:00:00Z");

    const ugc = (id: string, m: string, price: number, active: boolean) =>
      db.query(
        "insert into creator_packages (id, human_member_id, kind, title, price_cents, delivery_days, video_count, video_length_seconds, ad_rights_days, ad_label_required, active, created_at, updated_at) values ($1, $2, 'ugc_video', 'Video', $3, 7, 1, 30, 90, false, $4, $5, $5)",
        [id, m, price, active, OLD],
      );
    const audience = (id: string, m: string, price: number, active: boolean) =>
      db.query(
        "insert into creator_packages (id, human_member_id, kind, title, price_cents, delivery_days, platform, post_type, stays_up_days, post_count, ad_label_required, active, created_at, updated_at) values ($1, $2, 'audience_post', 'Post', $3, 5, 'instagram', 'Reel', 30, 3, true, $4, $5, $5)",
        [id, m, price, active, OLD],
      );
    await audience(P_AUD, M_BOTH, 1_000, true);
    await ugc(P_UGC, M_BOTH, 20_000, true);
    await audience(P_AUD2, M_AUD, 500, true);
    await audience(P_AUD_OFF, M_BOTH, 700, false);
    await ugc(P_UGC_OFF, M_UGC, 900, false);

    const offer = (id: string, kind: string, status: string, responded: string | null) =>
      db.query(
        "insert into creator_offers (id, tenant_id, human_member_id, kind, status, expires_at, responded_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
        [id, T1, M_BOTH, kind, status, EXPIRES, responded, OLD],
      );
    await offer(O_AUD_OPEN, "audience_post", "open", null);
    await offer(O_AUD_ACCEPTED, "audience_post", "accepted", OLD);
    await offer(O_UGC_OPEN, "ugc_video", "open", null);
    await offer(O_AUD_EXPIRED, "audience_post", "expired", null);

    const brief = (id: string, status: string, lane: string | null, posted: string | null, closed: string | null) =>
      db.query(
        "insert into creator_briefs (id, tenant_id, status, lane, posted_at, closed_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7)",
        [id, T1, status, lane, posted, closed, OLD],
      );
    await brief(B_AUD_SENT, "sent", "audience_post", OLD, null);
    await brief(B_AUD_DRAFT, "draft", "audience_post", null, null);
    await brief(B_AUD_FILLED, "filled", "audience_post", OLD, OLD);
    await brief(B_UGC, "sent", "ugc_video", OLD, null);
    await brief(B_NULL, "sent", null, OLD, null);

    const application = (id: string, tenant: string, briefId: string, status: string) =>
      db.query(
        "insert into brief_applications (id, tenant_id, brief_id, human_member_id, status, updated_at) values ($1, $2, $3, $4, $5, $6)",
        [id, tenant, briefId, M_UGC, status, OLD],
      );
    await application(A_APPLIED, T1, B_AUD_SENT, "applied");
    await application(A_SHORT, T1, B_AUD_SENT, "shortlisted");
    await application(A_APPROVED, T1, B_AUD_SENT, "approved");
    await application(A_UGC, T1, B_UGC, "applied");
    await application(A_OTHER_TENANT, T2, B_AUD_SENT, "applied");
    await application(A_NULL_LANE, T1, B_NULL, "shortlisted");

    await db.query("insert into creator_orders (id, status, package_snapshot) values ($1, 'completed', $2), ($3, 'cancelled', $2)", [
      "91111230-0000-4000-8000-0000000000f1",
      JSON.stringify({ kind: "audience_post" }),
      "91111230-0000-4000-8000-0000000000f2",
    ]);
    await db.exec(sql);
    afterFirst = {};
    for (const t of ["human_members", "creator_packages", "creator_offers", "creator_briefs", "brief_applications"]) {
      afterFirst[t] = await all(t);
    }
    await db.exec(sql);
  });
  afterAll(async () => db?.close());

  it("is re-runnable: the second run changes no row, not even its updated_at", async () => {
    for (const t of Object.keys(afterFirst)) expect(await all(t), t).toEqual(afterFirst[t]);
  });

  it("deactivates every audience post package and leaves every UGC package exactly as it was", async () => {
    for (const id of [P_AUD, P_AUD2]) {
      const p = await one("creator_packages", id);
      expect(p.active, id).toBe(false);
      expect(iso(p.updated_at)).not.toBe(OLD);
      expect(p).toMatchObject({ kind: "audience_post", platform: "instagram", post_type: "Reel", stays_up_days: 30, post_count: 3 });
    }
    expect(iso((await one("creator_packages", P_AUD_OFF)).updated_at)).toBe(OLD);
    expect(await one("creator_packages", P_UGC)).toMatchObject({ active: true, price_cents: 20_000 });
    expect(iso((await one("creator_packages", P_UGC)).updated_at)).toBe(OLD);
    expect(await one("creator_packages", P_UGC_OFF)).toMatchObject({ active: false });
    expect(iso((await one("creator_packages", P_UGC_OFF)).updated_at)).toBe(OLD);
    expect(await all("creator_packages")).toHaveLength(5);

    const sellable = (await db.query("select kind from creator_packages where active")).rows.map((r) => r.kind);
    expect(sellable.every((k: string) => (CREATOR_PACKAGE_KINDS as readonly string[]).includes(k))).toBe(true);
    for (const row of (await db.query("select * from creator_packages where active")).rows) {
      expect(checkCreatorPackage(row).ok, row.id).toBe(true);
    }
  });

  it("withdraws only open audience post offers and keeps accepted history and UGC offers", async () => {
    const withdrawn = await one("creator_offers", O_AUD_OPEN);
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.responded_at).not.toBeNull();
    expect(iso(withdrawn.updated_at)).not.toBe(OLD);
    expect(await one("creator_offers", O_AUD_ACCEPTED)).toMatchObject({ status: "accepted" });
    expect(iso((await one("creator_offers", O_AUD_ACCEPTED)).responded_at)).toBe(OLD);
    expect(iso((await one("creator_offers", O_AUD_ACCEPTED)).updated_at)).toBe(OLD);
    expect(await one("creator_offers", O_AUD_EXPIRED)).toMatchObject({ status: "expired", responded_at: null });
    expect(await one("creator_offers", O_UGC_OPEN)).toMatchObject({ status: "open", responded_at: null });
    expect(iso((await one("creator_offers", O_UGC_OPEN)).updated_at)).toBe(OLD);
  });

  it("strips the audience post lane from UGC creators, and keeps it on an audience-only creator so they are not opened to every lane", async () => {
    expect((await one("human_members", M_BOTH)).lanes).toEqual(["ugc_video"]);
    expect((await one("human_members", M_AUD)).lanes).toEqual(["audience_post"]);
    expect(iso((await one("human_members", M_AUD)).updated_at)).toBe(OLD);
    expect((await one("human_members", M_UGC)).lanes).toEqual(["ugc_video"]);
    expect(iso((await one("human_members", M_UGC)).updated_at)).toBe(OLD);
    expect((await one("human_members", M_NULL)).lanes).toBeNull();
    expect(iso((await one("human_members", M_NULL)).updated_at)).toBe(OLD);
    for (const m of await all("human_members")) {
      if (m.id === M_AUD) continue;
      for (const lane of m.lanes ?? []) expect((CREATOR_LANES as readonly string[]).includes(lane), lane).toBe(true);
    }
  });

  it("closes open audience post briefs, cancels the draft, and turns down their pending applicants only", async () => {
    const sent = await one("creator_briefs", B_AUD_SENT);
    expect(sent.status).toBe("sent");
    expect(sent.closed_at).not.toBeNull();
    const draft = await one("creator_briefs", B_AUD_DRAFT);
    expect(draft.status).toBe("cancelled");
    expect(draft.closed_at).not.toBeNull();
    const filled = await one("creator_briefs", B_AUD_FILLED);
    expect(filled.status).toBe("filled");
    expect(iso(filled.closed_at)).toBe(OLD);
    expect(iso(filled.updated_at)).toBe(OLD);
    for (const id of [B_UGC, B_NULL]) {
      const b = await one("creator_briefs", id);
      expect(b.closed_at, id).toBeNull();
      expect(iso(b.updated_at)).toBe(OLD);
    }

    expect((await one("brief_applications", A_APPLIED)).status).toBe("rejected");
    expect((await one("brief_applications", A_SHORT)).status).toBe("rejected");
    expect((await one("brief_applications", A_APPROVED)).status).toBe("approved");
    expect((await one("brief_applications", A_UGC)).status).toBe("applied");
    expect((await one("brief_applications", A_OTHER_TENANT)).status).toBe("applied");
    expect((await one("brief_applications", A_NULL_LANE)).status).toBe("shortlisted");
    for (const id of [A_APPROVED, A_UGC, A_OTHER_TENANT, A_NULL_LANE]) {
      expect(iso((await one("brief_applications", id)).updated_at), id).toBe(OLD);
    }
  });

  it("search_creators offers no audience post lane, package or price, even for a row re-activated after the migration", async () => {
    await db.query("update creator_packages set active = true where id = $1", [P_AUD]);
    await db.query("update human_members set lanes = array['ugc_video', 'audience_post'] where id = $1", [M_UGC]);
    try {
      const rows = await search();
      const both = rows.find((r) => r.human_member_id === M_BOTH);
      expect(both.packages.map((p: { id: string }) => p.id)).toEqual([P_UGC]);
      expect(both.from_price_cents).toBe(20_000);
      for (const r of rows) {
        expect(r.lanes, r.human_member_id).not.toContain("audience_post");
        for (const p of r.packages) {
          expect(p.kind).toBe("ugc_video");
          for (const k of ["platform", "post_type", "stays_up_days", "post_count", "ad_label_required"]) expect(p, k).not.toHaveProperty(k);
        }
      }

      expect(await search({ lane: "audience_post" })).toEqual([]);
      expect((await search({ lane: "ugc_video" })).map((r) => r.human_member_id).sort()).toEqual([M_BOTH, M_UGC].sort());
      expect((await search({ max_price: 5_000 })).map((r) => r.human_member_id)).toEqual([]);
    } finally {
      await db.query("update creator_packages set active = false where id = $1", [P_AUD]);
      await db.query("update human_members set lanes = array['ugc_video'] where id = $1", [M_UGC]);
    }
  });

  it("refuses to run while an audience post order is still in flight, and changes nothing", async () => {
    const before = await all("creator_offers");
    await db.query("insert into creator_orders (id, status, package_snapshot) values ($1, 'checkout_pending', $2)", [
      "91111230-0000-4000-8000-0000000000f3",
      JSON.stringify({ kind: "audience_post" }),
    ]);
    try {
      await expect(db.exec(sql)).rejects.toThrow(/audience_post creator order is still in flight/);
      await db.exec("rollback");
    } finally {
      await db.query("delete from creator_orders where id = $1", ["91111230-0000-4000-8000-0000000000f3"]);
    }
    expect(await all("creator_offers")).toEqual(before);
  });
});
