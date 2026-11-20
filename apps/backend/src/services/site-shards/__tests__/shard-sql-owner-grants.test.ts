import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadShardMigrations } from "../migrations";

const ROOT = resolve(__dirname, "../../../../../../infra/site-shard");

type Handoff = { schema: string; role: string; at: number };

function topLevel(sql: string): string {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, (m) => " ".repeat(m.length))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length));
}

function handoffs(sql: string): Handoff[] {
  const out: Handoff[] = [];
  const re = /alter\s+(?:function|procedure)\s+([a-z_]+)\.[a-z_0-9]+\s*\([^)]*\)\s+owner\s+to\s+([a-z_]+)\s*;/gi;
  for (const m of topLevel(sql).matchAll(re)) out.push({ schema: m[1].toLowerCase(), role: m[2].toLowerCase(), at: m.index ?? 0 });
  return out;
}

function lastIndex(text: string, re: RegExp, before: number): number {
  let idx = -1;
  for (const m of text.matchAll(re)) if ((m.index ?? 0) < before) idx = m.index ?? 0;
  return idx;
}

function firstIndex(text: string, re: RegExp, after: number): number {
  for (const m of text.matchAll(re)) if ((m.index ?? 0) > after) return m.index ?? 0;
  return -1;
}

describe("shard SQL: function hand-offs work for a non-superuser migration role", () => {
  const files = loadShardMigrations(ROOT);

  it("finds the shard files (sanity)", () => {
    expect(files.map((f) => f.version)).toContain("0002_api");
    expect(handoffs(files.find((f) => f.version === "0002_api")!.sql).length).toBeGreaterThan(0);
  });

  for (const f of files) {
    const list = handoffs(f.sql).filter((h) => h.role !== "postgres");
    if (!list.length) continue;
    it(`${f.version}: every OWNER TO is inside a transient GRANT/REVOKE CREATE on its schema`, () => {
      const text = topLevel(f.sql);
      const commit = text.search(/\bcommit\s*;/i);
      expect(commit, `${f.version} has no commit`).toBeGreaterThan(0);
      for (const h of list) {
        const grant = new RegExp(`grant\\s+create\\s+on\\s+schema\\s+${h.schema}\\s+to\\s+${h.role}\\s*;`, "gi");
        const revoke = new RegExp(`revoke\\s+create\\s+on\\s+schema\\s+${h.schema}\\s+from\\s+${h.role}\\s*;`, "gi");
        const g = lastIndex(text, grant, h.at);
        const r = firstIndex(text, revoke, h.at);
        expect(g, `${f.version}: no "grant create on schema ${h.schema} to ${h.role}" before the hand-off`).toBeGreaterThanOrEqual(0);
        expect(r, `${f.version}: no "revoke create on schema ${h.schema} from ${h.role}" after the hand-off`).toBeGreaterThan(h.at);
        expect(r, `${f.version}: the revoke must run before commit`).toBeLessThan(commit);
        const revokeBetween = firstIndex(text, revoke, g);
        expect(revokeBetween, `${f.version}: CREATE was revoked before the hand-off ran`).toBeGreaterThan(h.at);
      }
    });
  }

  it("no file grants CREATE on api / zsite to anyone without revoking it in the same file", () => {
    for (const f of files) {
      const text = topLevel(f.sql);
      for (const m of text.matchAll(/grant\s+create\s+on\s+schema\s+([a-z_]+)\s+to\s+([a-z_]+)\s*;/gi)) {
        const revoke = new RegExp(`revoke\\s+create\\s+on\\s+schema\\s+${m[1]}\\s+from\\s+${m[2]}\\s*;`, "gi");
        expect(firstIndex(text, revoke, m.index ?? 0), `${f.version}: CREATE on ${m[1]} to ${m[2]} is never revoked`).toBeGreaterThan(0);
      }
    }
  });

  it("0005's checksum back-fill matches the 0001-0004 files byte for byte", () => {
    const f5 = files.find((f) => f.version.startsWith("0005_"))!;
    const pairs = [...f5.sql.matchAll(/\('(\d{4}_[a-z0-9_]+)',\s*'([0-9a-f]{64})'\)/g)].map((m) => [m[1], m[2]] as const);
    expect(pairs.map((p) => p[0])).toEqual(["0001_core", "0002_api", "0003_storage", "0004_membership_slots_perf"]);
    for (const [version, sha] of pairs) {
      expect(sha, `${version} back-fill`).toBe(files.find((f) => f.version === version)!.sha256);
    }
  });

  it("0001_core is byte-identical to what zavi-shard-prod-1 already ran", () => {
    expect(files.find((f) => f.version === "0001_core")!.sha256).toBe("a7d7ead171e6f4475cf429f1426eb73ca609cfeb18c966019e2da6a9a0ed5fb6");
  });

  it("the parser sees through comments and function bodies", () => {
    const sql = "begin;\n-- alter function api.x() owner to zsite_facade;\ncreate function f() returns void language plpgsql as $$ begin execute 'alter function api.y() owner to zsite_facade;'; end $$;\ncommit;";
    expect(handoffs(sql)).toEqual([]);
  });
});
