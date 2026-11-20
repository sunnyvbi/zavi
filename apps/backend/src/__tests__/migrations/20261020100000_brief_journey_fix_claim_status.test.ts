import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseJourneyFixClaim } from "@/services/sites/site-design-store";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(MIGRATIONS, "20261020100000_brief_journey_fix_claim_status.sql"), "utf-8");
const PRIOR = readFileSync(join(MIGRATIONS, "20261019120000_brief_journey_fix_free.sql"), "utf-8");

function fnBody(src: string, name: string): string {
  const at = src.indexOf(`create or replace function ${name}(`);
  const end = src.indexOf("$$;", src.indexOf("$$", at) + 2);
  return src.slice(at, end + 3);
}

describe("20261020100000_brief_journey_fix_claim_status.sql (source)", () => {
  it("adds only the status claim, security definer, granted to service_role alone", () => {
    expect(sql).toMatch(/create or replace function claim_brief_journey_fix_status\([\s\S]*security definer set search_path = public, pg_temp/);
    expect(sql).toMatch(/revoke all on function claim_brief_journey_fix_status\(uuid, uuid, uuid, integer\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function claim_brief_journey_fix_status\(uuid, uuid, uuid, integer\) to service_role;/);
    expect(sql).not.toMatch(/grant execute[^;]*to (public|anon|authenticated)/);
    expect(sql).not.toMatch(/create or replace function (claim_brief_journey_fix|_trg_)\(/);
    expect(sql).not.toMatch(/drop function/i);
    expect(sql).toMatch(/revoke all on function _is_brief_journey_fix_run\(uuid, uuid, text, jsonb, text, uuid\) from public, anon, authenticated;/);
  });

  it("the waiver is 20261019120000's, with only the bind-or-refuse ending changed", () => {
    const strip = (s: string) => s.replace(/--[^\n]*\n/g, "\n").replace(/\s+/g, " ");
    const prior = strip(fnBody(PRIOR, "_is_brief_journey_fix_run")).replace(" return v_site is not null; end $$;", "");
    const now = strip(fnBody(sql, "_is_brief_journey_fix_run"));
    expect(now.startsWith(prior)).toBe(true);
    expect(now.slice(prior.length)).toMatch(
      /^ if v_site is not null then return true; end if; if exists \(select 1 from agent_runs r where r\.id = p_run_id and r\.status = 'queued'\) then raise exception 'brief_journey_fix_unbound' using errcode = 'P0001'; end if; return false; end \$\$;$/,
    );
  });
});

describe("parseJourneyFixClaim", () => {
  it("only a well-formed claimed or already_used answer is definitive", () => {
    expect(parseJourneyFixClaim({ status: "claimed", token: "t" })).toEqual({ status: "claimed", token: "t" });
    expect(parseJourneyFixClaim({ status: "already_used" })).toEqual({ status: "already_used" });
    expect(parseJourneyFixClaim({ status: "claimed" }).status).toBe("unavailable");
    expect(parseJourneyFixClaim({ status: "claimed", token: "" }).status).toBe("unavailable");
    expect(parseJourneyFixClaim({ status: "reserved" })).toEqual({ status: "unavailable", reason: "reserved" });
    expect(parseJourneyFixClaim({ status: "no_design" })).toEqual({ status: "unavailable", reason: "no_design" });
    expect(parseJourneyFixClaim("11111111-1111-4111-8111-111111111111").status).toBe("unavailable");
    expect(parseJourneyFixClaim(null).status).toBe("unavailable");
  });
});

const modules = process.env.SITES_SQL_TEST_MODULES;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const SITE = "33333333-3333-4333-8333-333333333333";
const NO_ROW = "77777777-7777-4777-8777-777777777777";
const FIRST_BUILD = "44444444-4444-4444-8444-444444444444";
const PUBLISH = "55555555-5555-4555-8555-555555555555";
const RUN_A = "a0000000-0000-4000-8000-00000000000a";
type Db = { exec: (q: string) => Promise<unknown>; query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>; close: () => Promise<void> };
let db: Db;

async function claim(run: string, attempt: number, o: { tenant?: string; site?: string } = {}): Promise<{ status: string; token?: string }> {
  const r = await db.query("select claim_brief_journey_fix_status($1, $2, $3, $4) as c", [o.tenant ?? T1, o.site ?? SITE, run, attempt]);
  return r.rows[0].c;
}

describe.skipIf(!modules)("20261020100000_brief_journey_fix_claim_status.sql executed in Postgres (pglite)", () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.site_design_briefs (site_id uuid primary key, tenant_id uuid not null, updated_at timestamptz);
      insert into public.site_design_briefs (site_id, tenant_id) values ('${SITE}', '${T1}');
      create table public.agent_runs (id uuid primary key, status text not null);
    `);
    const alter = PRIOR.slice(PRIOR.indexOf("alter table public.site_design_briefs"), PRIOR.indexOf(";", PRIOR.indexOf("alter table public.site_design_briefs")) + 1);
    await db.exec(alter);
    await db.exec(fnBody(PRIOR, "release_brief_journey_fix"));
    for (const n of ["claim_brief_journey_fix_status", "_is_brief_journey_fix_run"]) await db.exec(fnBody(sql, n));
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("claims once, and the same run + attempt gets the same token back", async () => {
    const first = await claim(PUBLISH, 2);
    expect(first.status).toBe("claimed");
    expect(first.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await claim(PUBLISH, 2)).toEqual(first);
  });

  it("an unbound reservation of another run or attempt is 'reserved', never 'already_used'", async () => {
    expect((await claim(PUBLISH, 3)).status).toBe("reserved");
    expect((await claim(FIRST_BUILD, 1)).status).toBe("reserved");
  });

  it("once an agent run is bound to the pass, anyone else gets 'already_used'", async () => {
    const { token } = await claim(PUBLISH, 2);
    const payload = { build_conductor_run_id: PUBLISH, site_id: SITE, repair_attempt: 2, brief_journey_fix: true, brief_journey_fix_token: token };
    const bound = await db.query("select _is_brief_journey_fix_run($1, $2, 'engineer', $3::jsonb, 'a2a', null) as f", [T1, RUN_A, JSON.stringify(payload)]);
    expect(bound.rows[0].f).toBe(true);
    expect((await claim(PUBLISH, 3)).status).toBe("already_used");
    expect((await claim(FIRST_BUILD, 1)).status).toBe("already_used");
    expect(await claim(PUBLISH, 2)).toEqual({ status: "claimed", token });
  });

  it("no design row, another tenant or bad input is never definitive", async () => {
    expect((await claim(PUBLISH, 1, { site: NO_ROW })).status).toBe("no_design");
    expect((await claim(PUBLISH, 2, { tenant: T2 })).status).toBe("no_design");
    expect((await claim(PUBLISH, 0)).status).toBe("invalid");
  });

  it("fails closed: a marked conductor run that cannot bind is refused, never charged; others are untouched", async () => {
    const free = (run: string, payload: Record<string, unknown>, o: { slug?: string; enqueuedBy?: string | null } = {}) =>
      db.query("select _is_brief_journey_fix_run($1, $2, $3, $4::jsonb, 'a2a', $5) as f", [T1, run, o.slug ?? "engineer", JSON.stringify(payload), o.enqueuedBy ?? null]);
    const { token } = await claim(PUBLISH, 2);
    const payload = { build_conductor_run_id: PUBLISH, site_id: SITE, repair_attempt: 2, brief_journey_fix: true, brief_journey_fix_token: token };
    expect((await free(RUN_A, payload)).rows[0].f).toBe(true);
    const RUN_B = "b0000000-0000-4000-8000-00000000000b";
    await db.query("insert into public.agent_runs (id, status) values ($1, 'queued')", [RUN_B]);
    await expect(free(RUN_B, payload)).rejects.toThrow(/brief_journey_fix_unbound/);
    await expect(free(RUN_B, { ...payload, brief_journey_fix_token: "99999999-0000-4000-8000-000000000000" })).rejects.toThrow(/brief_journey_fix_unbound/);
    for (const s of ["running", "success", "failed"]) {
      await db.query("update public.agent_runs set status = $2 where id = $1", [RUN_B, s]);
      expect((await free(RUN_B, payload)).rows[0].f, s).toBe(false);
    }
    await db.query("update public.agent_runs set status = 'queued' where id = $1", [RUN_B]);
    expect((await free(RUN_B, { ...payload, brief_journey_fix: false })).rows[0].f).toBe(false);
    expect((await free(RUN_B, payload, { slug: "growth-lead" })).rows[0].f).toBe(false);
    expect((await free(RUN_B, payload, { enqueuedBy: "66666666-6666-4666-8666-666666666666" })).rows[0].f).toBe(false);
  });

  it("a released reservation can be claimed again", async () => {
    await db.exec(`update public.site_design_briefs set journey_fix_conductor_run_id = null, journey_fix_attempt = null, journey_fix_token = null, journey_fix_agent_run_id = null, journey_fix_claimed_at = null`);
    const first = await claim(PUBLISH, 4);
    const released = await db.query("select release_brief_journey_fix($1, $2, $3) as r", [T1, SITE, first.token]);
    expect(released.rows[0].r).toBe(true);
    const second = await claim(FIRST_BUILD, 1);
    expect(second.status).toBe("claimed");
    expect(second.token).not.toBe(first.token);
  });
});
