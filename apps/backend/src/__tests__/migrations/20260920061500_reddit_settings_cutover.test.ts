import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(__dirname, "../../../../../supabase/migrations");

function strip(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

const read = (f: string) => strip(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

const code = read("20260920061500_reddit_settings_cutover.sql");
const source = read("20260918035312_reddit_workspace_config.sql");
const target = read("20260920050000_channel_settings.sql");

function statusLists(sql: string): string[][] {
  return [...sql.matchAll(/status\s+in\s*\(([^)]*)\)/gi)].map((m) =>
    m[1]
      .split(",")
      .map((v) => v.trim().replace(/^'|'$/g, ""))
      .filter(Boolean),
  );
}

describe("20260920061500_reddit_settings_cutover.sql", () => {
  it("copies all three fields into channel_settings", () => {
    for (const field of ["'keywords'", "'competitors'", "'communities'"]) {
      expect(code, `${field} must be copied`).toContain(field);
    }
    expect([...code.matchAll(/insert into channel_settings/gi)]).toHaveLength(3);
  });

  it("PRESERVES the source ids — channel_settings.id IS the old row's id", () => {
    const inserts = [...code.matchAll(/insert into channel_settings\s*\(([^)]*)\)\s*select\s+([a-z]+)\.id\b/gi)];
    expect(inserts, "each copy must insert an explicit id selected from the source row").toHaveLength(3);
    for (const m of inserts) {
      expect(m[1].split(",").map((c) => c.trim())[0]).toBe("id");
    }
    expect(code).not.toMatch(/insert into channel_settings[\s\S]{0,400}?gen_random_uuid\(\)/i);
  });

  it("re-points BOTH mention FKs at channel_settings(id), keeping on delete set null", () => {
    for (const col of ["keyword_id", "competitor_id"]) {
      const m = code.match(
        new RegExp(
          `constraint\\s+\\w+\\s+foreign key\\s*\\(\\s*${col}\\s*\\)\\s*references\\s+channel_settings\\s*\\(\\s*id\\s*\\)\\s*on delete set null`,
          "i",
        ),
      );
      expect(m, `${col} must be re-pointed at channel_settings(id) on delete set null`).not.toBeNull();
    }
    expect(code).toMatch(/pg_constraint/i);
    expect(code).toMatch(/keyword_id['\s,]+.*competitor_id|competitor_id['\s,]+.*keyword_id/i);
  });

  it("the FK swap happens AFTER the copy and BEFORE commit (one transaction)", () => {
    const lastCopy = code.lastIndexOf("insert into channel_settings");
    const drop = code.search(/drop constraint/i);
    const add = code.search(/add constraint\s+reddit_mentions_keyword_id_fkey/i);
    const commit = code.indexOf("commit;");
    const begin = code.indexOf("begin;");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lastCopy).toBeGreaterThan(begin);
    expect(drop).toBeGreaterThan(lastCopy);
    expect(add).toBeGreaterThan(drop);
    expect(commit).toBeGreaterThan(add);
  });

  it("`why` lands in note and `domain` lands in detail", () => {
    expect(code, "keywords/competitors `why` -> note").toMatch(/btrim\(coalesce\(\w+\.why, ''\)\)/);
    expect(code, "competitors.domain -> detail").toMatch(/btrim\(coalesce\(\w+\.domain, ''\)\)/);
    for (const m of code.matchAll(/insert into channel_settings\s*\(([^)]*)\)/gi)) {
      const cols = m[1].split(",").map((c) => c.trim());
      for (const col of ["note", "detail", "origin"]) expect(cols).toContain(col);
    }
  });

  it("copies `origin` verbatim rather than deriving it", () => {
    expect(code, "keywords.origin -> origin").toMatch(/\bk\.origin\b/);
    expect(code, "competitors.origin -> origin").toMatch(/\bc\.origin\b/);
    expect(code.slice(code.lastIndexOf("insert into channel_settings"))).toMatch(/'custom'/);
    expect(code, "no derivation from created_by").not.toMatch(/origin[^;]*created_by is (not )?null/i);
  });

  it("every value written as a LITERAL is legal in the target's CHECKs", () => {
    const statuses = new Set(statusLists(target).flat());
    for (const v of ["tracking", "paused"]) expect(statuses.has(v)).toBe(true);
    const origins = new Set(
      [...target.matchAll(/origin\s+in\s*\(([^)]*)\)/gi)].flatMap((m) =>
        m[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")),
      ),
    );
    expect(origins.has("custom"), "channel_settings.origin must accept 'custom'").toBe(true);
    expect(origins.has("suggested"), "channel_settings.origin must accept 'suggested'").toBe(true);
  });

  it("a community keeps BOTH of its facts — `selected` and `rules_verdict`", () => {
    expect(code, "selected -> status").toMatch(
      /case when\s+\w+\.selected then 'tracking' else 'paused' end/i,
    );
    expect(code, "rules_verdict -> item_type").toMatch(/\w+\.rules_verdict\b/);
    const communityCopy = code.slice(code.lastIndexOf("insert into channel_settings"));
    expect(communityCopy).toMatch(/from reddit_communities/i);
    expect(communityCopy).toMatch(/rules_verdict/);
    expect(communityCopy).toMatch(/selected/);
  });

  it("`created_at` is carried as ORDER (position), not dropped outright", () => {
    expect([...code.matchAll(/row_number\(\) over \(partition by \w+\.tenant_id order by \w+\.created_at/gi)])
      .toHaveLength(3);
    for (const m of code.matchAll(/insert into channel_settings\s*\(([^)]*)\)/gi)) {
      expect(m[1].split(",").map((c) => c.trim())).toContain("position");
    }
  });

  it("every reddit status value is legal in channel_settings", () => {
    const sourceValues = new Set(statusLists(source).flat());
    const targetValues = new Set(statusLists(target).flat());
    expect(sourceValues.size, "reddit's status CHECK must be readable").toBeGreaterThan(0);
    const lost = [...sourceValues].filter((v) => !targetValues.has(v));
    expect(
      lost,
      `channel_settings' status CHECK has no target for: ${lost.join(", ")}. ` +
        `Copying these rows would fail the constraint or coerce them to null.`,
    ).toEqual([]);
    for (const v of ["tracking", "paused"]) expect(targetValues.has(v)).toBe(true);
  });

  it("does NOT drop the old tables", () => {
    for (const t of ["reddit_keywords", "reddit_competitors", "reddit_communities"]) {
      expect(code, `${t} must survive this migration`).not.toMatch(
        new RegExp(`drop table[^;]*\\b${t}\\b`, "i"),
      );
    }
  });

  it("creates the tenant_channels rows the composite FK requires", () => {
    const seed = code.indexOf("insert into tenant_channels");
    expect(seed, "tenant_channels rows must be ensured").toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(code.indexOf("insert into channel_settings"));
    expect(code).toMatch(/on conflict \(tenant_id, channel_slug\) do nothing/i);
  });
});
