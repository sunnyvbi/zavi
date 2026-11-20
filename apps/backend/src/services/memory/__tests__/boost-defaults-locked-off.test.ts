
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "../../../../../../supabase/migrations");

const LOCKED_OFF_KEYS = [
  "brain_eval_recency_default",
  "brain_eval_salience_default",
  "brain_eval_backlink_boost_default",
  "brain_outcome_boost_default",
];

describe("memory ranking-boost defaults stay OFF (footgun guard)", () => {
  it("no migration flips a boost *_default to true", () => {
    let files: string[] = [];
    try {
      files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    } catch (e) {
      throw new Error(`could not read migrations dir ${MIGRATIONS_DIR}: ${(e as Error).message}`);
    }
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      for (const key of LOCKED_OFF_KEYS) {
        const jsonbSet = new RegExp(`\\{\\s*${key}\\s*\\}'\\s*,\\s*'true'`, "i");
        const coalesceTrue = new RegExp(`->'${key}'[^,;]*,\\s*'true'`, "i");
        if (jsonbSet.test(sql) || coalesceTrue.test(sql)) {
          offenders.push(`${f} sets ${key} = true`);
        }
      }
    }

    expect(
      offenders,
      `Memory ranking boosts are measured NET-HARMFUL (recency −0.24 recall@3 on upcar-ai) and ` +
        `are bypassed by the reranker. Do NOT flip a boost default ON until memory-bench.ts shows a ` +
        `per-axis recall@3 lift across multiple tenants. Offending migration(s):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
