
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const LEGACY_HIGH_WATER = 85;

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

function prefixOf(f: string): string {
  const m = f.match(/^(\d+)_/);
  if (!m) throw new Error(`migration ${f} has no numeric version prefix`);
  return m[1];
}

describe("migration naming guard", () => {
  it("every migration filename has a numeric version prefix", () => {
    for (const f of files) {
      expect(f, `${f} must be <version>_<name>.sql`).toMatch(/^\d+_[a-z0-9_-]+\.sql$/i);
    }
  });

  it("NO two migrations share a version prefix (the collision guard)", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const f of files) {
      const p = prefixOf(f);
      const prior = seen.get(p);
      if (prior) dupes.push(`version ${p}: ${prior} <-> ${f}`);
      else seen.set(p, f);
    }
    expect(dupes, `duplicate migration version prefixes:\n${dupes.join("\n")}`).toEqual([]);
  });

  it("new migrations use a 14-digit timestamp prefix (legacy 4-digit frozen <= 0084)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const p = prefixOf(f);
      if (p.length === 4) {
        if (Number(p) > LEGACY_HIGH_WATER) {
          offenders.push(
            `${f}: 4-digit ${p} > frozen high-water ${LEGACY_HIGH_WATER}. ` +
              `Use \`supabase migration new <name>\` (timestamp prefix), do NOT hand-pick the next integer.`,
          );
        }
      } else if (p.length !== 14) {
        offenders.push(
          `${f}: prefix must be a legacy 4-digit (<= ${LEGACY_HIGH_WATER}) or a 14-digit ` +
            `timestamp from \`supabase migration new\`. Got ${p.length} digits.`,
        );
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
