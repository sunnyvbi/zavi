import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const file = readdirSync(MIGRATIONS_DIR).find((f) => /^\d{14}_metric_incidents\.sql$/.test(f));
if (!file) throw new Error("metric_incidents migration not found");

const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

const TABLES = ["metric_incidents", "metric_moves", "metric_alert_mutes"];

describe("metric_incidents migration", () => {
  it("allows ONE active incident per (tenant, family)", () => {
    expect(sql).toMatch(/create unique index if not exists metric_incidents_one_active\s+on metric_incidents \(tenant_id, family\)\s+where status <> 'recovered'/);
    expect(sql).toMatch(/status\s+text not null check \(status in \('open', 'worsened', 'recovered'\)\)/);
  });

  it("one move per metric per day, one mute per key", () => {
    expect(sql).toMatch(/unique \(tenant_id, metric_id, move_date\)/);
    expect(sql).toMatch(/unique \(tenant_id, mute_key\)/);
  });

  it("enables RLS, lets members read only, and revokes every browser write", () => {
    for (const t of TABLES) {
      expect(sql).toContain(`alter table ${t} enable row level security;`);
      expect(sql).toMatch(new RegExp(`create policy ${t}_member_select on ${t}\\s+for select`));
      expect(sql).toMatch(new RegExp(`create policy ${t}_active_tenant_restrict on ${t}\\s+as restrictive for select using \\(tenant_id = \\(select public.app_active_tenant\\(\\)\\)\\)`));
      expect(sql).toContain(`revoke all on table public.${t} from public, anon;`);
      expect(sql).toContain(`revoke insert, update, delete, truncate, references, trigger on table public.${t} from authenticated;`);
    }
    expect(sql).not.toMatch(/for (insert|update|delete|all)/);
    expect(sql).not.toMatch(/grant [^;]* to (anon|authenticated|public)/);
  });

  it("adds no function, so there is no security-definer surface", () => {
    expect(sql).not.toMatch(/create (or replace )?function/);
    expect(sql).not.toMatch(/security definer/);
  });
});
