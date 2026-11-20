import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260616130000_github_selected_repos.sql",
  ),
  "utf-8",
);

describe("20260616130000 — selected_repo_ids subset CHECK (P1-7)", () => {
  it("uses the <@ array-containment operator", () => {
    expect(SRC).toMatch(/selected_repo_ids\s*<@\s*repo_ids/);
  });

  it("does NOT use a subquery in the CHECK constraint", () => {
    const checkBlock = SRC.slice(
      SRC.indexOf("add constraint connector_metadata_selected_repos_subset_chk"),
      SRC.indexOf("set_github_selected_repos"),
    );
    expect(checkBlock).not.toMatch(/select\s+1\s+from\s+unnest/i);
    expect(checkBlock.toLowerCase()).not.toContain("not exists");
  });

  it("still permits NULL (grandfather) and empty (scoped-to-nothing) selections", () => {
    expect(SRC).toMatch(/selected_repo_ids is null/);
  });
});
