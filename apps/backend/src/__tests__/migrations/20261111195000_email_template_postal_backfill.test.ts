import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emailTemplateSchema } from "@/services/email-templates/store";

type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261111195000_email_template_postal_backfill.sql";
const TEMPLATES = readFileSync(join(DIR, "20261031190200_email_templates.sql"), "utf-8");
const sql = readFileSync(join(DIR, FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;

const EMPTY = "91110195-0000-4000-8000-000000000001";
const BLANK = "91110195-0000-4000-8000-000000000002";
const KEEP = "91110195-0000-4000-8000-000000000003";
const NOROW = "91110195-0000-4000-8000-000000000004";
const NOSETTING = "91110195-0000-4000-8000-000000000005";
const PAUSED = "91110195-0000-4000-8000-000000000006";
const OTHERCHANNEL = "91110195-0000-4000-8000-000000000007";
const ALL = [EMPTY, BLANK, KEEP, NOROW, NOSETTING, PAUSED, OTHERCHANNEL];
const FOUNDER = "aaaaaaaa-0000-4000-8000-000000000001";
const OLD = "2026-01-01T00:00:00.000Z";

const template = (tenant: string, postal: string | null) =>
  db.query(
    "insert into email_templates (tenant_id, logo_url, brand_color, button_color, font_key, sign_off, postal_address, show_cards, updated_by, updated_at) values ($1, 'https://cdn.acme.com/logo.png', '#1a73e8', '#ff0000', 'serif', 'Cheers', $2, true, $3, $4)",
    [tenant, postal, FOUNDER, OLD],
  );
const setting = (tenant: string, item: string, opts: { status?: string | null; position?: number | null; slug?: string; field?: string } = {}) =>
  db.query("insert into channel_settings (tenant_id, channel_slug, field_id, item, status, position) values ($1, $2, $3, $4, $5, $6)", [
    tenant,
    opts.slug ?? "email_marketing",
    opts.field ?? "postal_address",
    item,
    opts.status ?? null,
    opts.position ?? null,
  ]);
const row = async (tenant: string) => (await db.query("select * from email_templates where tenant_id = $1", [tenant])).rows[0];

describe.skipIf(!modules)(`${FILE}: the template postal address is filled from the old channel setting only where it is empty (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.tenants (id uuid primary key);
      create table public.channel_settings (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references public.tenants(id) on delete cascade,
        channel_slug text not null,
        field_id text not null,
        item text not null check (char_length(btrim(item)) between 1 and 300),
        status text null check (status is null or status in ('suggested', 'tracking', 'paused', 'dismissed')),
        position int null,
        unique (tenant_id, channel_slug, field_id, item)
      );
    `);
    await db.exec(TEMPLATES);
  });
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.exec("delete from email_templates; delete from channel_settings; delete from tenants;");
    for (const t of ALL) await db.query("insert into tenants values ($1)", [t]);
    await template(EMPTY, null);
    await setting(EMPTY, "  1 Main St, Austin TX  ");
    await template(BLANK, "   ");
    await setting(BLANK, "9 Elm Rd", { position: 1 });
    await setting(BLANK, "2 Side St", { position: 0 });
    await template(KEEP, "100 Founder Ave");
    await setting(KEEP, "Old setting address");
    await setting(NOROW, "7 Only Setting Ln");
    await template(NOSETTING, null);
    await template(PAUSED, null);
    await setting(PAUSED, "Paused address", { status: "paused", position: 0 });
    await setting(PAUSED, "Dismissed address", { status: "dismissed", position: 1 });
    await setting(PAUSED, "Live address", { status: "tracking", position: 2 });
    await template(OTHERCHANNEL, null);
    await setting(OTHERCHANNEL, "Wrong channel address", { slug: "sms" });
    await setting(OTHERCHANNEL, "Wrong field address", { field: "sending_domain" });
  });

  it("copies the setting into an empty or blank template and touches nothing else on that row", async () => {
    await db.exec(sql);
    const empty = await row(EMPTY);
    expect(empty.postal_address).toBe("1 Main St, Austin TX");
    expect(empty).toMatchObject({ logo_url: "https://cdn.acme.com/logo.png", brand_color: "#1a73e8", button_color: "#ff0000", font_key: "serif", sign_off: "Cheers", show_cards: true, updated_by: FOUNDER });
    expect(new Date(empty.updated_at).toISOString()).not.toBe(OLD);
    expect((await row(BLANK)).postal_address).toBe("2 Side St");
    const parsed = emailTemplateSchema.safeParse({
      logo_url: empty.logo_url,
      brand_color: empty.brand_color,
      button_color: empty.button_color,
      font_key: "system",
      sign_off: empty.sign_off,
      postal_address: empty.postal_address,
      show_cards: empty.show_cards,
    });
    expect(parsed.success ? parsed.data.postal_address : parsed.error.issues).toBe("1 Main St, Austin TX");
  });

  it("never overwrites a template address the founder already saved", async () => {
    await db.exec(sql);
    const keep = await row(KEEP);
    expect(keep.postal_address).toBe("100 Founder Ave");
    expect(new Date(keep.updated_at).toISOString()).toBe(OLD);
  });

  it("skips paused and dismissed items, other channels and other fields", async () => {
    await db.exec(sql);
    expect((await row(PAUSED)).postal_address).toBe("Live address");
    expect((await row(OTHERCHANNEL)).postal_address).toBeNull();
    expect((await row(NOSETTING)).postal_address).toBeNull();
  });

  it("never creates a template for a workspace that only had the setting, so the brand draft still runs for it", async () => {
    await db.exec(sql);
    expect(await row(NOROW)).toBeUndefined();
    expect((await db.query("select count(*)::int n from email_templates")).rows[0].n).toBe(6);
  });

  it("is idempotent: a second run changes nothing", async () => {
    await db.exec(sql);
    const before = (await db.query("select tenant_id, postal_address, updated_at from email_templates order by tenant_id")).rows;
    await db.exec(sql);
    const after = (await db.query("select tenant_id, postal_address, updated_at from email_templates order by tenant_id")).rows;
    expect(after).toEqual(before);
    expect((await db.query("select count(*)::int n from email_templates")).rows[0].n).toBe(6);
  });

  it("a founder who later saves a new address keeps it when the backfill runs again", async () => {
    await db.exec(sql);
    await db.query("update email_templates set postal_address = '55 New Place' where tenant_id = $1", [EMPTY]);
    await db.exec(sql);
    expect((await row(EMPTY)).postal_address).toBe("55 New Place");
  });
});
