import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261112140000_outage_retry_requeue.sql";
const code = readFileSync(join(MIGRATIONS, FILE), "utf-8").replace(/--[^\n]*/g, "");

describe(FILE, () => {
  it("owns its version", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
    expect(all.filter((f) => f.startsWith("20261112140000_"))).toEqual([FILE]);
  });
  it("is service-role only", () => {
    for (const sig of [
      "requeue_outage_retry(uuid, uuid, text, int, timestamptz, jsonb, text[], jsonb)",
      "mark_outage_retry_skipped(uuid, uuid, jsonb)",
    ]) {
      expect(code).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(code).toContain(`grant execute on function ${sig} to service_role;`);
    }
    expect(code).not.toMatch(/\bdrop\s/i);
  });
});
