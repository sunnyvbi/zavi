import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261012105000_site_shard_placeable.sql";
const sql = readFileSync(join(dir, FILE), "utf-8");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const v = (f: string) => Number(f.split("_")[0]);

function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("$$;", start));
}

function clauses(where: string): string[] {
  return where
    .replace(/\s+/g, " ")
    .trim()
    .split(/ and (?![^()]*\))/i)
    .map((c) => c.trim())
    .filter(Boolean)
    .sort();
}

describe(FILE, () => {
  it("runs after the S7 placement it mirrors; unique version", () => {
    expect(files).toContain("20261012090000_site_shard_metrics_freshness.sql");
    expect(v(FILE)).toBeGreaterThan(v("20261012090000_site_shard_metrics_freshness.sql"));
    expect(files.filter((f) => v(f) === v(FILE))).toEqual([FILE]);
  });

  it("is one transaction and additive", () => {
    expect(sql.trimStart().split("\n").find((l) => l.trim() && !l.startsWith("--"))).toBe("begin;");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/drop (table|column|function)/i);
  });

  it.each([
    ["site_shard_placeable", "public.site_shards"],
    ["site_shard_placement_readiness", "text"],
  ])("%s is security definer, pinned search_path, service_role only", (name, sig) => {
    const body = fnBody(sql, name);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/set search_path = pg_catalog, pg_temp/i);
    expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
  });

  it("PARITY: site_shard_placeable is exactly the candidate filter of the LATEST site_backend_place", () => {
    const latest = [...files].reverse().find((f) => /create or replace function public\.site_backend_place\(/i.test(readFileSync(join(dir, f), "utf-8")));
    expect(latest, "a migration defines site_backend_place").toBeTruthy();
    const place = fnBody(readFileSync(join(dir, latest as string), "utf-8"), "site_backend_place");
    const pick = /select \* into v_shard from public\.site_shards sh\s+where (sh\.env = p_env[\s\S]*?)\s+order by/i.exec(place);
    expect(pick, "the placement pick query").toBeTruthy();
    const placeClauses = clauses((pick as RegExpExecArray)[1]).filter((c) => c !== "sh.env = p_env");

    const latestPred = [...files].reverse().find((f) => /create or replace function public\.site_shard_placeable\(/i.test(readFileSync(join(dir, f), "utf-8")));
    const pred = fnBody(readFileSync(join(dir, latestPred as string), "utf-8"), "site_shard_placeable");
    const body = /select coalesce\(([\s\S]*),\s*false\)/i.exec(pred)?.[1];
    expect(body, "the predicate body").toBeTruthy();
    expect(clauses(body as string)).toEqual(placeClauses);
  });

  it("readiness counts placeable with the SAME predicate", () => {
    const body = fnBody(sql, "site_shard_placement_readiness");
    expect(body).toContain("public.site_shard_placeable(sh)");
    expect(body).toContain("not public.site_shard_metrics_fresh(sh)");
    expect(body).toContain("where sh.env = p_env");
  });

  it("the new RPC is on the fail-closed siteShardRpc allowlist", () => {
    const tc = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf-8");
    expect(tc).toContain(`"site_shard_placement_readiness",`);
  });
});
