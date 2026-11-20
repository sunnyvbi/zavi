import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261014110000_site_settle_generation_fence.sql";
const SQL = readFileSync(join(DIR, FILE), "utf-8");
const BEGIN_PRIOR = "20261012060000_site_publish_generation.sql";
const SETTLE_PRIOR = "20261014100000_site_activation_needs_live_run.sql";
const CANCEL_PRIOR = "20261014100100_cancel_settles_publish_site.sql";

const stripComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function fnOf(source: string, header: string): string {
  const code = stripComments(source);
  const start = code.indexOf(header);
  expect(start, `${header} is defined`).toBeGreaterThan(-1);
  const end = code.indexOf("end $$;", start);
  expect(end, `${header} is closed`).toBeGreaterThan(start);
  return norm(code.slice(start, end + "end $$;".length));
}

const BEGIN = "create or replace function public.site_publish_begin(";
const SETTLE = "create or replace function public.site_settle_stopped(";
const CANCEL = "create or replace function cancel_conductor_run(";
const code = norm(stripComments(SQL));

describe("a stop settle never overwrites a newer publish (20261014110000)", () => {
  it("is later than every migration it rebuilds from, and its version is unique", () => {
    const versions = readdirSync(DIR).filter((f) => f.endsWith(".sql")).map((f) => f.split("_")[0]);
    expect(versions.filter((v) => v === "20261014110000")).toHaveLength(1);
    expect("20261014110000" > "20261014100100").toBe(true);
  });

  it("adds sites.publish_run_id", () => {
    expect(code).toContain("alter table public.sites add column if not exists publish_run_id uuid;");
  });

  it("site_publish_begin is its prior definition plus the run, recorded in the SAME update that bumps the generation", () => {
    const before = fnOf(readFileSync(join(DIR, BEGIN_PRIOR), "utf-8"), BEGIN);
    const after = fnOf(SQL, BEGIN);
    const expected = before
      .replace("p_sha text ) returns bigint", "p_sha text, p_conductor_run_id uuid default null ) returns bigint")
      .replace("desired_sha = p_sha where", "desired_sha = p_sha, publish_run_id = p_conductor_run_id where");
    expect(expected).not.toBe(before);
    expect(after).toBe(expected);
  });

  it("site_settle_stopped is its prior definition plus the two arguments and the fence, nothing else", () => {
    const before = fnOf(readFileSync(join(DIR, SETTLE_PRIOR), "utf-8"), SETTLE);
    const after = fnOf(SQL, SETTLE);
    const fence =
      "and ((p_conductor_run_id is not null and s.publish_run_id = p_conductor_run_id) or (p_generation is not null and s.publish_generation <= p_generation) or (p_generation is null and (p_conductor_run_id is null or s.publish_run_id is null)))";
    const expected = before
      .replace(
        "p_last_error text ) returns public.sites",
        "p_last_error text, p_generation bigint default null, p_conductor_run_id uuid default null ) returns public.sites",
      )
      .replace(
        "and s.status in ('building', 'publishing') returning * into v_row;",
        `and s.status in ('building', 'publishing') ${fence} returning * into v_row;`,
      );
    expect(expected).not.toBe(before);
    expect(after).toBe(expected);
  });

  it("old overloads are dropped first; the new signatures stay service-role only", () => {
    for (const drop of [
      "drop function if exists public.site_publish_begin(uuid, uuid, text);",
      "drop function if exists public.site_settle_stopped(uuid, uuid, text, text);",
    ]) {
      expect(code).toContain(drop);
      expect(code.indexOf(drop)).toBeLessThan(code.indexOf(BEGIN));
    }
    for (const sig of ["site_publish_begin(uuid, uuid, text, uuid)", "site_settle_stopped(uuid, uuid, text, text, bigint, uuid)"]) {
      expect(code).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
      expect(code).toContain(`grant execute on function public.${sig} to service_role;`);
    }
  });

  it("cancel_conductor_run is its prior definition plus the fence (graph generation + run ownership) and one WHERE condition", () => {
    const before = fnOf(readFileSync(join(DIR, CANCEL_PRIOR), "utf-8"), CANCEL);
    const after = fnOf(SQL, CANCEL);
    const fenceRead =
      "select max((n.node->'payload'->>'site_publish_generation')::bigint) into v_site_gen from jsonb_array_elements(case when jsonb_typeof(v_goal_graph) = 'array' then v_goal_graph else '[]'::jsonb end) n(node) where (n.node->'payload'->>'site_publish_generation') ~ '^[0-9]{1,18}$';";
    const expected = before
      .replace("v_site_id uuid; begin", "v_site_id uuid; v_site_gen bigint; begin")
      .replace("end if; update public.sites s set", () => `end if; ${fenceRead} update public.sites s set`)
      .replace(
        "and s.status in ('provisioning', 'building', 'publishing');",
        "and s.status in ('provisioning', 'building', 'publishing') and (s.publish_run_id = p_conductor_run_id or (v_site_gen is not null and s.publish_generation <= v_site_gen) or (v_site_gen is null and s.publish_run_id is null));",
      );
    expect(expected).not.toBe(before);
    expect(after).toBe(expected);
  });

  it("cancel_conductor_run keeps its grants", () => {
    expect(code).toContain("revoke all on function cancel_conductor_run(uuid, uuid, text, timestamptz) from public, anon, authenticated;");
    expect(code).toContain("grant execute on function cancel_conductor_run(uuid, uuid, text, timestamptz) to service_role;");
  });
});
