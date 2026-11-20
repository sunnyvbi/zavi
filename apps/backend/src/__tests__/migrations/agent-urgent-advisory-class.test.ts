
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);
const FILE = "20260606040220_agent_urgent_advisory_class.sql";

const sql = readFileSync(join(MIGRATIONS_DIR, FILE), "utf8");
const flat = sql.replace(/\s+/g, " ").toLowerCase();

describe("agent_urgent_advisory_class migration", () => {
  it("registers the agent.urgent_advisory decision class", () => {
    expect(flat).toContain("insert into decision_classes");
    expect(flat).toContain("'agent.urgent_advisory'");
  });

  it("registers it with default_autonomy='approval' and a NULL dispatch_handler", () => {
    expect(flat).toContain(
      "decision_classes (slug, description, default_autonomy, dispatch_handler)",
    );
    expect(flat).toMatch(/'approval',\s*null/);
    expect(flat).not.toMatch(/'agent\.urgent_advisory'[\s\S]*'auto'/);
  });

  it("inserts the class idempotently (ON CONFLICT DO NOTHING)", () => {
    expect(flat).toContain("on conflict (slug) do nothing");
  });

  it("seeds urgent_flags_as_cards_enabled = false (default OFF)", () => {
    expect(flat).toContain("urgent_flags_as_cards_enabled");
    expect(flat).toContain(
      "jsonb_set(coalesce(blob, '{}'::jsonb), '{urgent_flags_as_cards_enabled}', 'false'::jsonb, true)",
    );
    expect(flat).not.toContain("'{urgent_flags_as_cards_enabled}', 'true'");
  });

  it("scopes the flag write to the single-row system_config (id = 1)", () => {
    expect(flat).toContain("update system_config");
    expect(flat).toContain("where id = 1");
  });
});
