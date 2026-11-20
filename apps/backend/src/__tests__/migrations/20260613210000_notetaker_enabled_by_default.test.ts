import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260613210000_notetaker_enabled_by_default.sql",
  ),
  "utf8",
);

describe("migration 20260613210000_notetaker_enabled_by_default", () => {
  it("sets future tenant meeting settings rows to enabled by default", () => {
    expect(sql).toMatch(
      /alter table tenant_meeting_settings\s+alter column enabled set default true/i,
    );
  });

  it("backfills only legacy never-enabled rows and preserves explicit opt-outs", () => {
    expect(sql).toMatch(/update tenant_meeting_settings/i);
    expect(sql).toMatch(/set enabled = true/i);
    expect(sql).toMatch(/where enabled = false\s+and enabled_at is null/i);
    expect(sql).toMatch(/and nullif\(trim\(meeting_url\), ''\) is null/i);
    expect(sql).not.toMatch(/enabled_at is not null/i);
  });
});
