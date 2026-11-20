import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261117090000_decision_home_library_video_backfill.sql";
const sql = ["20261115180000_decision_home_library_video_channels.sql", FILE]
  .map((f) => readFileSync(join(DIR, f), "utf-8"))
  .join("\n");
const homeSql = readFileSync(join(DIR, "20261110140000_decisions_home.sql"), "utf-8");
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const RUN = "00000000-0000-0000-0000-0000000000b1";

let db: Pg | null = null;
type Row = { home: string | null; home_channel: string | null; xmin: string };
let before: Record<string, Row> = {};
let once: Record<string, Row> = {};
let twice: Record<string, Row> = {};
const rows = async () =>
  Object.fromEntries(
    (await db!.query("select id, home, home_channel, xmin::text as xmin from public.decisions")).rows.map((r) => [
      r.id as string,
      { home: r.home, home_channel: r.home_channel, xmin: r.xmin } as Row,
    ]),
  );
const stamp = (r: Row) => ({ home: r.home, home_channel: r.home_channel });
const home = async (cls: string | null, social: string | null) =>
  (await db!.query("select * from decision_home_of($1, null, null, null, null, $2)", [cls, social])).rows[0];

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)(`${FILE} (pglite)`, () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec("create role anon; create role authenticated; create role service_role;");
    await db!.exec(`
      create table public.agent_runs (
        id uuid primary key, tenant_id uuid not null, channel_slug text, enqueued_by uuid, payload jsonb
      );
      create table public.decisions (
        id text primary key, tenant_id uuid not null, decision_class text not null,
        agent_run_id uuid, body jsonb not null default '{}'::jsonb, status text not null default 'proposed',
        emitted_at timestamptz not null default now(), autonomy_at_emit text not null default 'approval',
        snoozed_until timestamptz
      );
    `);
    await db!.exec(homeSql);
    await db!.query("insert into public.agent_runs (id, tenant_id, channel_slug) values ($1, $2, 'meta_ads')", [RUN, TENANT]);
    const seed: [string, string, string | null, string, string | null][] = [
      ["li_video", "social.publish.v2", "linkedin_video", "proposed", null],
      ["ig_video", "social.publish.v2", "instagram_video", "proposed", null],
      ["li_video_done", "social.publish.v2", "linkedin_video", "approved", null],
      ["li_video_run", "social.publish.v2", "linkedin_video", "proposed", RUN],
      ["v1_video", "social.publish", "linkedin_video", "proposed", null],
      ["fb_video", "social.publish.v2", "facebook_video", "proposed", null],
      ["x_video", "social.publish.v2", "x_video", "proposed", null],
      ["ticket", "pm.ticket", "linkedin_video", "proposed", null],
    ];
    for (const [id, cls, channel, status, run] of seed) {
      await db!.query(
        "insert into public.decisions (id, tenant_id, decision_class, body, status, agent_run_id) values ($1, $2, $3, $4::jsonb, $5, $6)",
        [id, TENANT, cls, JSON.stringify(channel ? { channel } : {}), status, run],
      );
    }
    before = await rows();
    await db!.exec(sql);
    once = await rows();
    await db!.exec(sql);
    twice = await rows();
  }, 60_000);
  afterAll(async () => db?.close());

  it("homes the library video posts on their organic channel", async () => {
    expect(await home("social.publish.v2", "instagram_video")).toEqual({ home: "channel", home_channel: "instagram_organic" });
    expect(await home("social.publish.v2", "linkedin_video")).toEqual({ home: "channel", home_channel: "linkedin_organic" });
  });

  it("seeds the video posts the way the old function stamped them", () => {
    for (const id of ["li_video", "ig_video", "li_video_done", "v1_video", "fb_video"]) {
      expect(stamp(before[id]), id).toEqual({ home: "growth", home_channel: null });
    }
    expect(stamp(before.li_video_run)).toEqual({ home: "channel", home_channel: "meta_ads" });
  });

  it("restamps existing video posts onto their organic channel, actioned ones too", () => {
    expect(stamp(once.li_video)).toEqual({ home: "channel", home_channel: "linkedin_organic" });
    expect(stamp(once.ig_video)).toEqual({ home: "channel", home_channel: "instagram_organic" });
    expect(stamp(once.li_video_done)).toEqual({ home: "channel", home_channel: "linkedin_organic" });
  });

  it("does not write any other row", () => {
    for (const id of ["li_video_run", "v1_video", "fb_video", "x_video", "ticket"]) {
      expect(once[id], id).toEqual(before[id]);
    }
  });

  it("is a no-op when applied again", () => {
    expect(twice).toEqual(once);
  });

  it("keeps every earlier social mapping", async () => {
    const cases: [string, string][] = [
      ["x_video", "x_organic"],
      ["x", "x_organic"],
      ["instagram_image", "instagram_organic"],
      ["linkedin", "linkedin_organic"],
      ["linkedin_image", "linkedin_organic"],
      ["tiktok_video", "tiktok_organic"],
      ["youtube_video", "youtube_organic"],
      ["pinterest_pin", "pinterest_organic"],
      ["reddit_comment", "reddit_organic"],
    ];
    for (const [social, channel] of cases) {
      expect(await home("social.publish.v2", social), social).toEqual({ home: "channel", home_channel: channel });
    }
  });

  it("only maps video targets for a social publish and leaves unknown ones off the channel pages", async () => {
    expect(await home("social.publish.v2", "facebook_video")).toEqual({ home: "growth", home_channel: null });
    expect(await home("social.publish.v2", null)).toEqual({ home: "growth", home_channel: null });
    expect(await home("pm.ticket", "instagram_video")).toEqual({ home: "needs_you", home_channel: null });
    expect(await home("pm.ticket", "linkedin_video")).toEqual({ home: "needs_you", home_channel: null });
  });

  it("stays executable by service_role only", async () => {
    const sig = "public.decision_home_of(text, text, uuid, text, text, text)";
    const can = async (role: string) =>
      (await db!.query("select has_function_privilege($1, $2, 'execute') as ok", [role, sig])).rows[0].ok;
    expect(await can("service_role")).toBe(true);
    expect(await can("anon")).toBe(false);
    expect(await can("authenticated")).toBe(false);
  });
});
