import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { JOURNEY_FIX_MARK } from "@/services/sites/design-fidelity";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(MIGRATIONS, "20261019120000_brief_journey_fix_free.sql"), "utf-8");
const PRIOR = readFileSync(join(MIGRATIONS, "20261006090000_free_edits_and_first_goal_review.sql"), "utf-8");

function fnBody(src: string, name: string): string {
  const at = src.indexOf(`create or replace function ${name}(`);
  const end = src.indexOf("$$;", src.indexOf("$$", at) + 2);
  return src.slice(at, end + 3);
}

const ADDED = `  -- A site's one brief-journey fix pass is paid by Zavi: no reserve, no charge.
  -- First, so the pass is bound to its run even inside a free first Build.
  if _is_brief_journey_fix_run(NEW.tenant_id, NEW.id, NEW.agent_slug, NEW.payload,
                               NEW.trigger, NEW.enqueued_by) then
    return null;
  end if;
`;

describe("20261019120000_brief_journey_fix_free.sql (source)", () => {
  it("both reserve triggers are the 20261006090000 bodies verbatim plus one early return", () => {
    for (const trg of ["_trg_reserve_run_credits", "_trg_rereserve_run_credits"]) {
      const now = fnBody(sql, trg);
      expect(now, trg).toContain(ADDED);
      expect(now.replace(ADDED, ""), trg).toBe(fnBody(PRIOR, trg));
    }
  });

  it("leaves _is_free_build_stage alone and grants only to service_role", () => {
    expect(sql).not.toMatch(/function _is_free_build_stage/);
    expect(sql).toMatch(/grant execute on function claim_brief_journey_fix\(uuid, uuid, uuid, integer\) to service_role;/);
    expect(sql).toMatch(/grant execute on function release_brief_journey_fix\(uuid, uuid, uuid\) to service_role;/);
    expect(sql).not.toMatch(/grant execute[^;]*to (public|anon|authenticated)/);
    expect(sql).toMatch(/revoke all on function _is_brief_journey_fix_run\(uuid, uuid, text, jsonb, text, uuid\) from public, anon, authenticated;/);
    expect(JOURNEY_FIX_MARK).toBe("zavi:brief-journey");
  });
});

const modules = process.env.SITES_SQL_TEST_MODULES;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const SITE = "33333333-3333-4333-8333-333333333333";
const FIRST_BUILD = "44444444-4444-4444-8444-444444444444";
const PUBLISH = "55555555-5555-4555-8555-555555555555";
const RUN_A = "a0000000-0000-4000-8000-00000000000a";
const RUN_B = "b0000000-0000-4000-8000-00000000000b";
type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;
let token = "";

async function free(
  run: string,
  payload: Record<string, unknown>,
  o: { tenant?: string; slug?: string; trigger?: string; enqueuedBy?: string | null } = {},
): Promise<boolean> {
  const r = await db.query("select _is_brief_journey_fix_run($1, $2, $3, $4::jsonb, $5, $6) as f", [
    o.tenant ?? T1,
    run,
    o.slug ?? "engineer",
    JSON.stringify(payload),
    o.trigger ?? "a2a",
    o.enqueuedBy ?? null,
  ]);
  return r.rows[0].f === true;
}
async function claim(run: string, attempt: number, tenant = T1): Promise<string | null> {
  const r = await db.query("select claim_brief_journey_fix($1, $2, $3, $4) as c", [tenant, SITE, run, attempt]);
  return r.rows[0].c ?? null;
}
async function release(t: string): Promise<boolean> {
  const r = await db.query("select release_brief_journey_fix($1, $2, $3) as r", [T1, SITE, t]);
  return r.rows[0].r === true;
}
const fix = (run: string, attempt: number, extra: Record<string, unknown> = {}) => ({
  build_conductor_run_id: run,
  site_id: SITE,
  repair_mode: true,
  repair_attempt: attempt,
  brief_journey_fix: true,
  brief_journey_fix_token: token,
  ...extra,
});

describe.skipIf(!modules)("20261019120000_brief_journey_fix_free.sql executed in Postgres (pglite)", () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.site_design_briefs (site_id uuid primary key, tenant_id uuid not null, updated_at timestamptz);
      insert into public.site_design_briefs (site_id, tenant_id) values ('${SITE}', '${T1}');
    `);
    const fns = ["claim_brief_journey_fix", "release_brief_journey_fix", "_is_brief_journey_fix_run"].map((n) => fnBody(sql, n));
    const alter = sql.slice(sql.indexOf("alter table public.site_design_briefs"), sql.indexOf(";", sql.indexOf("alter table public.site_design_briefs")) + 1);
    for (const q of [alter, ...fns, ...fns]) await db.exec(q);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("a later publish's claimed fix run is free (no reserve, never debited) and bound to that run", async () => {
    expect(await free(RUN_A, fix(PUBLISH, 2))).toBe(false);
    token = (await claim(PUBLISH, 2))!;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await free(RUN_A, fix(PUBLISH, 2))).toBe(true);
    expect(await free(RUN_A, fix(PUBLISH, 2))).toBe(true);
  });

  it("no other run can ride it: a copied payload, another attempt, a wrong token, another agent or a member enqueue", async () => {
    expect(await free(RUN_B, fix(PUBLISH, 2))).toBe(false);
    expect(await free(RUN_A, fix(PUBLISH, 3))).toBe(false);
    expect(await free(RUN_A, fix(PUBLISH, 2, { brief_journey_fix_token: "11111111-0000-4000-8000-000000000000" }))).toBe(false);
    expect(await free(RUN_A, fix(PUBLISH, 2), { slug: "growth-lead" })).toBe(false);
    expect(await free(RUN_A, fix(PUBLISH, 2), { trigger: "chat" })).toBe(false);
    expect(await free(RUN_A, fix(PUBLISH, 2), { enqueuedBy: "66666666-6666-4666-8666-666666666666" })).toBe(false);
    expect(await free(RUN_A, fix(PUBLISH, 2), { tenant: T2 })).toBe(false);
  });

  it("the pass cannot repeat, and a late release cannot free a second one once a run is bound", async () => {
    expect(await claim(PUBLISH, 2)).toBe(token);
    expect(await claim(PUBLISH, 3)).toBeNull();
    expect(await claim(FIRST_BUILD, 1)).toBeNull();
    expect(await claim(PUBLISH, 2, T2)).toBeNull();
    expect(await release(token)).toBe(false);
    expect(await claim(FIRST_BUILD, 1)).toBeNull();
  });

  it("an undispatched reservation is released only by its own token", async () => {
    await db.exec(`update public.site_design_briefs set journey_fix_conductor_run_id = null, journey_fix_attempt = null, journey_fix_token = null, journey_fix_agent_run_id = null, journey_fix_claimed_at = null`);
    const first = (await claim(PUBLISH, 2))!;
    expect(await release("99999999-0000-4000-8000-000000000000")).toBe(false);
    expect(await release(first)).toBe(true);
    const second = (await claim(PUBLISH, 3))!;
    expect(second).not.toBe(first);
    expect(await release(first)).toBe(false);
  });
});
