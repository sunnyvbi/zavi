import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_FAILURE_CLASSES } from "@/services/agents/conductor";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260929170000_conductor_failure_class_app_database_setup.sql",
  ),
  "utf8",
);

describe("20260929170000_conductor_failure_class_app_database_setup.sql", () => {
  it("recreates the failure_class CHECK with every BuildFailureClass member", () => {
    expect(sql).toMatch(/drop constraint if exists conductor_runs_failure_class_check/i);
    expect(sql).toMatch(/check \(failure_class is null or failure_class in \(/i);
    for (const member of BUILD_FAILURE_CLASSES) expect(sql).toContain(`'${member}'`);
    expect(sql).toContain("'app_database_setup'");
  });

  it("does not touch the status vocabulary", () => {
    expect(sql).not.toMatch(/conductor_runs_status_check/);
    expect(sql).not.toMatch(/update conductor_runs/i);
  });
});
