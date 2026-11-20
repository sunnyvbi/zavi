import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(__dirname, "../../../../../supabase/migrations");

const sql = readFileSync(
  join(migrationsDir, "20260529234140_engineer_ship_pr_default_auto.sql"),
  "utf-8",
);

const ddl = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260529234140_engineer_ship_pr_default_auto.sql", () => {
  it("sets default_autonomy='auto' for engineer.ship-pr", () => {
    expect(ddl).toMatch(/update decision_classes/i);
    expect(ddl).toMatch(/set default_autonomy = 'auto'::decision_autonomy/i);
    expect(ddl).toMatch(/where slug = 'engineer\.ship-pr'/i);
  });

  it("targets ONLY engineer.ship-pr (does not touch merge-pr / push_to_main / browser.action)", () => {
    expect(ddl).not.toMatch(/merge-pr/i);
    expect(ddl).not.toMatch(/merge_pr/i);
    expect(ddl).not.toMatch(/push_to_main/i);
    expect(ddl).not.toMatch(/browser\.action/i);
  });

  it("only changes the DEFAULT — never writes tenant_decision_class_overrides", () => {
    expect(ddl).not.toMatch(/tenant_decision_class_overrides/i);
  });

  it("is a non-destructive UPDATE (no drop / no handler change / no alter)", () => {
    expect(ddl).not.toMatch(/drop\s+(table|function|type|column)\b/i);
    expect(ddl).not.toMatch(/dispatch_handler/i);
    expect(ddl).not.toMatch(/alter\s+table/i);
  });

  it("is idempotent (re-run is a no-op once already 'auto')", () => {
    expect(ddl).toMatch(/default_autonomy is distinct from 'auto'::decision_autonomy/i);
  });
});

describe("NEVER_AUTO clamp survives the engineer default flip", () => {
  const neverAuto = readFileSync(
    join(migrationsDir, "20260528191600_browser_action_never_auto.sql"),
    "utf-8",
  );
  const neverAutoDdl = neverAuto
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

  it("effective_autonomy still clamps browser.action to 'approval'", () => {
    expect(neverAutoDdl).toMatch(
      /if p_decision_class = any \(array\['browser\.action'\]\) then\s*return 'approval'::decision_autonomy;/i,
    );
  });

  it("this migration does not redefine effective_autonomy (clamp untouched)", () => {
    expect(ddl).not.toMatch(/effective_autonomy/i);
  });
});
