
import { describe, it, expect } from "vitest";
import { listReportTools } from "../report";

const WEB_STARTER_CATALOG_EXPECTS = [
  "report__render_pdf",
  "report__render_csv",
  "report__render_xlsx",
  "report__render_blog",
  "report__render_wireframe",
  "report__render_deck",
  "report__render_doc",
  "report__render_artifact",
  "report__get_page_design_guide",
  "report__generate_image",
  "report__render_social_image",
];

describe("report server tool names (pinned for the web starter catalog)", () => {
  it("exposes exactly the tools the starter catalog advertises", () => {
    const actual = listReportTools()
      .map((t) => `${t.server_id}__${t.tool_name}`)
      .sort();

    expect(
      actual,
      "A report tool was added, renamed or removed. Update KNOWN_REPORT_TOOLS " +
        "and the affected entries in apps/web/src/lib/workspace/starters.ts, " +
        "then update this list. Do NOT just edit this list green: a gallery " +
        "entry whose tool no longer exists is the exact failure /starters was " +
        "built to prevent.",
    ).toEqual([...WEB_STARTER_CATALOG_EXPECTS].sort());
  });

  it("every advertised tool carries a non-empty description and object schema", () => {
    for (const t of listReportTools()) {
      expect(t.description.length, t.tool_name).toBeGreaterThan(0);
      expect(t.input_schema.type, t.tool_name).toBe("object");
    }
  });
});
