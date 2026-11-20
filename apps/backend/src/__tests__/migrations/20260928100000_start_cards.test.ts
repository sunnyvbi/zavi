import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const file = readdirSync(MIGRATIONS_DIR).find((f) => /^\d{14}_start_cards\.sql$/.test(f));
if (!file) throw new Error("start_cards migration not found");

const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

const TABLES = ["start_cards", "start_card_budget", "start_card_email_queue"];
const FUNCTIONS = [
  "start_card_budget_reserve(date, numeric, numeric)",
  "start_card_budget_adjust(date, numeric)",
  "start_card_set_part(uuid, text, jsonb)",
];

describe("start_cards migration", () => {
  it("enables AND forces RLS on every table, and creates no policy at all (anon reads nothing)", () => {
    for (const t of TABLES) {
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
      expect(sql).toContain(`alter table public.${t} force row level security;`);
    }
    expect(sql).not.toMatch(/create policy/);
  });

  it("revokes every table privilege from public, anon and authenticated", () => {
    for (const t of TABLES) {
      expect(sql).toContain(`revoke all on table public.${t} from public, anon, authenticated;`);
    }
    expect(sql).not.toMatch(/grant [^;]* on table [^;]* to (anon|authenticated|public)/);
  });

  it("revokes execute on every function from public, anon and authenticated; service_role only", () => {
    for (const f of FUNCTIONS) {
      expect(sql).toContain(`revoke all on function public.${f} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${f} to service_role;`);
    }
    expect(sql).not.toMatch(/grant execute[^;]*to (anon|authenticated|public)/);
    expect(sql).not.toMatch(/security definer/);
  });

  it("reserve is one conditional statement: the add happens only within the ceiling", () => {
    const body = sql.slice(sql.indexOf("function public.start_card_budget_reserve"), sql.indexOf("function public.start_card_budget_adjust"));
    expect(body).toMatch(/language sql/);
    expect(body).toMatch(/on conflict \(day\) do update/);
    expect(body).toMatch(/where b\.committed_usd \+ excluded\.committed_usd <= p_ceiling/);
    expect(body).toMatch(/where p_amount > 0 and p_amount <= p_ceiling/);
    expect(body).not.toMatch(/plpgsql/);
  });

  it("part writes are atomic jsonb_set on one key from a closed set", () => {
    const body = sql.slice(sql.indexOf("function public.start_card_set_part"));
    expect(body).toMatch(/set parts = jsonb_set\(parts, array\[p_key\], p_part, true\)/);
    expect(body).toMatch(/p_key in \('profile','google','ai','seo','design','compare','diagnosis'\)/);
  });

  it("the public id is opaque and constrained, and cards expire after 90 days", () => {
    expect(sql).toMatch(/public_id\s+text not null unique check \(public_id ~ '\^\[a-za-z0-9\]\{16,32\}\$'\)/);
    expect(sql).toMatch(/expires_at\s+timestamptz not null default now\(\) \+ interval '90 days'/);
  });
});
