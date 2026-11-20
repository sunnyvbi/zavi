import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREATOR_VIDEO_CHANNELS } from "@zavi/shared";

const SQL = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260928000000_creator_briefs_source_channel.sql"),
  "utf8",
);
const code = SQL.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .toLowerCase();

describe("20260928000000_creator_briefs_source_channel", () => {
  it("adds two nullable columns to creator_briefs", () => {
    expect(code).toMatch(/alter table public\.creator_briefs\s+add column if not exists source_channel text/);
    expect(code).toMatch(/add column if not exists ad_rights_days integer/);
    expect(code).toMatch(/ad_rights_days in \(30, 90, 365\)/);
  });

  it("allows exactly the shared list of video channels", () => {
    const listed = [...code.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...CREATOR_VIDEO_CHANNELS].sort());
  });

  it("is additive only: no drop, no replace, no grant, no data rewrite", () => {
    for (const banned of ["drop ", "create or replace", "grant ", "revoke ", "update ", "delete ", "alter column", "rename "]) {
      expect(code, banned).not.toContain(banned);
    }
  });
});
