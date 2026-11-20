import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261014100000_site_activation_needs_live_run.sql";
const SQL = readFileSync(join(DIR, FILE), "utf-8");
const ACTIVATE_PRIOR = "20261012060000_site_publish_generation.sql";
const CLAIM_PRIOR = "20261012010000_claim_site_setup_retry.sql";

const stripComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function fnOf(source: string, name: string): string {
  const code = stripComments(source);
  const start = code.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const end = code.indexOf("end $$;", start);
  expect(end, `${name} is closed`).toBeGreaterThan(start);
  return norm(code.slice(start, end + "end $$;".length));
}

const RUN_GATE =
  "and (p_conductor_run_id is null or exists (select 1 from public.conductor_runs r where r.id = p_conductor_run_id and r.tenant_id = p_tenant_id and r.status in ('provisioning', 'active', 'paused')));";
const NOT_SERVING = "and s.live_deploy_id is null";
const FINISHED_KEEPS_BUILDING = "(r.status in ('provisioning', 'active', 'paused') or (r.status = 'done' and s.status = 'building'))";

describe("a stopped or failed build never goes live, and a serving site is never reaped (20261014100000)", () => {
  it("site_activate_if_desired is its prior definition plus the optional run and the run gate, nothing else", () => {
    const before = fnOf(readFileSync(join(DIR, ACTIVATE_PRIOR), "utf-8"), "site_activate_if_desired");
    const after = fnOf(SQL, "site_activate_if_desired");
    const expected = before
      .replace("p_generation bigint default null ) returns boolean", "p_generation bigint default null, p_conductor_run_id uuid default null ) returns boolean")
      .replace("or s.publish_generation = p_generation); return found;", `or s.publish_generation = p_generation) ${RUN_GATE} return found;`);
    expect(expected).not.toBe(before);
    expect(after).toBe(expected);
  });

  it("the gate admits only a run of the SAME tenant that is still running or paused; stopped, failed and done runs are refused", () => {
    const fn = fnOf(SQL, "site_activate_if_desired");
    expect(fn).toContain(RUN_GATE);
    expect(fn).not.toMatch(/r\.status in \([^)]*'(halted|failed|done)'/);
    expect(fn.match(/\bupdate\b/g)).toHaveLength(1);
  });

  it("the five-argument overload is dropped so a named call cannot resolve to the ungated function", () => {
    const code = norm(stripComments(SQL));
    expect(code).toContain("drop function if exists public.site_activate_if_desired(uuid, uuid, text, text, text);");
    expect(code.indexOf("drop function if exists public.site_activate_if_desired")).toBeLessThan(
      code.indexOf("create or replace function public.site_activate_if_desired("),
    );
  });

  it("site_claim_stranded is its prior definition plus the not-serving guard and the finished-build exemption", () => {
    const before = fnOf(readFileSync(join(DIR, CLAIM_PRIOR), "utf-8"), "site_claim_stranded");
    const after = fnOf(SQL, "site_claim_stranded");
    expect(after).toBe(
      before
        .replace("and s.updated_at < p_cutoff", `and s.updated_at < p_cutoff ${NOT_SERVING}`)
        .replace(
          "and r.status in ('provisioning', 'active', 'paused')); return found;",
          `and ${FINISHED_KEEPS_BUILDING}); return found;`,
        ),
    );
    expect(after.split(NOT_SERVING).length - 1).toBe(1);
  });

  it("every function stays security definer with a pinned search_path and service_role only", () => {
    for (const [name, sig] of [
      ["site_activate_if_desired", "uuid, uuid, text, text, text, bigint, uuid"],
      ["site_claim_stranded", "uuid, uuid, timestamptz, text"],
      ["site_settle_stopped", "uuid, uuid, text, text"],
    ]) {
      expect(fnOf(SQL, name)).toContain("language plpgsql security definer set search_path = pg_catalog, pg_temp as $$");
      expect(SQL).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
      expect(SQL).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
    }
  });

  it("site_settle_stopped settles a building or publishing site in ONE statement: live when it already serves a deploy, else building or failed", () => {
    const fn = fnOf(SQL, "site_settle_stopped");
    expect(fn).toContain("returns public.sites");
    expect(fn).toContain("if p_to not in ('building', 'failed') then raise exception");
    const upd = fn.slice(fn.indexOf("update public.sites s"), fn.indexOf("if not found"));
    expect(upd).toBe(
      "update public.sites s set status = case when s.live_deploy_id is not null then 'live' else p_to end, last_error = left(coalesce(p_last_error, ''), 500), updated_at = now() where s.id = p_site_id and s.tenant_id = p_tenant_id and s.status in ('building', 'publishing') returning * into v_row; ",
    );
    expect(fn.match(/\b(update|select|insert|delete)\b/g)).toEqual(["update"]);
  });

  it("site_settle_stopped is callable through the tenant-scoped RPC path", () => {
    const tc = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf-8");
    expect(tc).toMatch(/\bsite_settle_stopped: "p_tenant_id",/);
  });

  it("touches nothing else, in one transaction", () => {
    const code = stripComments(SQL);
    const outside = norm(code.replace(/create or replace function[\s\S]*?end \$\$;/g, "FUNCTION;"));
    expect(outside).toBe(
      [
        "begin;",
        "drop function if exists public.site_activate_if_desired(uuid, uuid, text, text, text);",
        "drop function if exists public.site_activate_if_desired(uuid, uuid, text, text, text, bigint);",
        "drop function if exists public.site_activate_if_desired(uuid, uuid, text, text, text, uuid);",
        "FUNCTION;",
        "revoke all on function public.site_activate_if_desired(uuid, uuid, text, text, text, bigint, uuid) from public, anon, authenticated;",
        "grant execute on function public.site_activate_if_desired(uuid, uuid, text, text, text, bigint, uuid) to service_role;",
        "FUNCTION;",
        "revoke all on function public.site_claim_stranded(uuid, uuid, timestamptz, text) from public, anon, authenticated;",
        "grant execute on function public.site_claim_stranded(uuid, uuid, timestamptz, text) to service_role;",
        "FUNCTION;",
        "revoke all on function public.site_settle_stopped(uuid, uuid, text, text) from public, anon, authenticated;",
        "grant execute on function public.site_settle_stopped(uuid, uuid, text, text) to service_role;",
        "commit;",
      ].join(" "),
    );
  });

  it("is the definition in force, and any later redefinition keeps both guards", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf(CLAIM_PRIOR));
    for (const [name, guard] of [
      ["site_activate_if_desired", RUN_GATE],
      ["site_claim_stranded", NOT_SERVING],
      ["site_settle_stopped", "case when s.live_deploy_id is not null then 'live' else p_to end"],
    ]) {
      const definers = files.filter((f) => stripComments(readFileSync(join(DIR, f), "utf-8")).includes(`create or replace function public.${name}(`));
      expect(definers[definers.length - 1] >= FILE).toBe(true);
      for (const later of definers.filter((f) => f > FILE)) {
        expect(fnOf(readFileSync(join(DIR, later), "utf-8"), name), `${later} redefines ${name}`).toContain(guard);
      }
    }
  });
});
