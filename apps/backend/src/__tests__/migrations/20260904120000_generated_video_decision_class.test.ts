import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
  "20260904120000_generated_video_decision_class.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("20260904120000_generated_video_decision_class", () => {
  it("registers the generated_video.generate.v1 class (emit_decision default-denies unknown classes)", () => {
    expect(sql).toMatch(/insert\s+into\s+decision_classes/i);
    expect(sql).toContain("'generated_video.generate.v1'");
  });

  it("is approval-gated, not auto", () => {
    expect(sql).toMatch(/'approval'/);
  });

  it("is born never_auto — a credit spend can never fire without a human click", () => {
    expect(sql).toMatch(/never_auto/);
    expect(sql).toMatch(/never_auto\s*=\s*true/);
  });

  it("ships with NO dispatch handler — the render step is deliberately unwired", () => {
    expect(sql).toMatch(/'approval',\s*\n?\s*null,\s*\n?\s*true\)/);
    expect(sql).not.toMatch(/dispatch_handler\s*=\s*excluded\.dispatch_handler/);
  });

  it("never widens autonomy on re-apply", () => {
    const conflict = sql.slice(sql.indexOf("on conflict"));
    expect(conflict).toMatch(/never_auto\s*=\s*true/);
    expect(conflict).not.toMatch(/default_autonomy\s*=/);
  });
});
