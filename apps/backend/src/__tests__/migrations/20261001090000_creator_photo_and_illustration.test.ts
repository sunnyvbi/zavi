
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261001090000_creator_photo_and_illustration.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf-8")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe(FILE, () => {
  it.each(["photo_path", "illustration_path"])("%s carries the intro_video_path length and '..' check", (col) => {
    expect(sql).toMatch(new RegExp(`add column if not exists ${col} text`));
    expect(sql).toContain(`length(${col}) between 3 and 400 and position('..' in ${col}) = 0`);
  });

  it("adds the once-per-creator marker", () => {
    expect(sql).toMatch(/add column if not exists illustration_generated_at timestamptz/);
  });

  it("is additive only: no function, policy, grant or bucket change", () => {
    expect(sql).not.toMatch(/create (or replace )?function/i);
    expect(sql).not.toMatch(/\bpolicy\b/i);
    expect(sql).not.toMatch(/\bgrant\b/i);
    expect(sql).not.toMatch(/storage\.buckets/i);
    expect(sql).not.toMatch(/\bdrop\b/i);
  });
});
