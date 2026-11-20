import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261101170000_start_card_seed_scan.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf-8")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

const laterDefining = (fn: string) =>
  readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql") && f > FILE)
    .filter((f) => new RegExp(`function\\s+(public\\.)?${fn}\\s*\\(`, "i").test(readFileSync(join(MIG_DIR, f), "utf-8")));

describe(FILE, () => {
  it("is the newest definition of start_card_claim and start_card_seed_claim", () => {
    expect(laterDefining("start_card_claim")).toEqual([]);
    expect(laterDefining("start_card_seed_claim")).toEqual([]);
  });

  it("the visitor dedupe never reuses a seed card", () => {
    expect(sql).toMatch(/and funding_kind <> 'seed'\s+order by created_at desc/);
  });

  it("only service_role may run the claims or touch the seed tables", () => {
    expect(sql).not.toMatch(/grant[^;]*\b(anon|authenticated)\b/i);
    for (const t of ["seed_runs", "seed_run_items", "seed_suppressions", "seed_notices"]) {
      expect(sql).toMatch(new RegExp(`revoke all on table public\\.${t} from public, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`alter table public\\.${t} force row level security;`));
    }
  });
});
