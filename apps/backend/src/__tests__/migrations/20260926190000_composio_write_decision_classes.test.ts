import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "20260926190000_composio_write_decision_classes.sql"),
  "utf8",
);

const rows = sql.split("\n").filter((l) => /^\s*\('composio\./.test(l));
const row = (slug: string) => {
  const r = rows.find((l) => l.trim().startsWith(`('${slug}',`));
  expect(r, `row for ${slug}`).toBeDefined();
  return r!;
};

describe("20260926190000_composio_write_decision_classes", () => {
  it("registers exactly the three composio classes", () => {
    expect(sql).toMatch(/insert\s+into\s+decision_classes/i);
    expect(rows.map((l) => l.trim().match(/^\('([^']+)'/)![1]).sort()).toEqual(["composio.deletes_data", "composio.moves_money", "composio.write"]);
  });

  for (const [slug, severity] of [["composio.write", "medium"], ["composio.deletes_data", "high"], ["composio.moves_money", "high"]] as const) {
    it(`${slug}: approval by default, composio.execute_tool handler, not never_auto, ${severity} severity`, () => {
      const r = row(slug);
      expect(r).toContain("'approval'");
      expect(r).toContain("'composio.execute_tool'");
      expect(r).toMatch(/'composio\.execute_tool',\s*false,\s*false,\s*'(low|medium|high)'/);
      expect(r).toContain(`'${severity}'`);
    });
  }

  it("is idempotent and never overwrites an existing row's autonomy", () => {
    expect(sql).toMatch(/on conflict \(slug\) do nothing/i);
  });
});
