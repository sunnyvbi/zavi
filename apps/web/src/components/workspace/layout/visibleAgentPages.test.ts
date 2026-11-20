import { describe, expect, it, vi } from "vitest";

vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({}) }));

import { visibleAgentPages } from "./ContextPanel";

const tree = (...slugs: string[]) => slugs.map((slug) => ({ slug }));
const kinds = (pages: Array<{ kind: string }>) => pages.map((p) => p.kind);

describe("visibleAgentPages", () => {
  it("shows all three, in sidebar order, when every agent is visible and the tenant is a marketplace", () => {
    expect(
      kinds(
        visibleAgentPages(
          tree("engineer", "supply-demand-balancer", "fundraising"),
          true,
        ),
      ),
    ).toEqual(["fundraising", "supply-demand", "engineer"]);
  });

  it("hides Supply & Demand for a non-marketplace even though its agent is in the tree", () => {
    expect(
      kinds(
        visibleAgentPages(
          tree("fundraising", "supply-demand-balancer", "engineer"),
          false,
        ),
      ),
    ).toEqual(["fundraising", "engineer"]);
  });

  it("hides a page whose agent is not in the tree (killed or not entitled)", () => {
    expect(kinds(visibleAgentPages(tree("engineer"), true))).toEqual([
      "engineer",
    ]);
    expect(visibleAgentPages([], true)).toEqual([]);
  });

  it("uses the chat agent slug, not the page kind, for Supply & Demand", () => {
    expect(kinds(visibleAgentPages(tree("supply-demand"), true))).toEqual([]);
  });
});

describe("visibleAgentPages plan locks", () => {
  it("carries the backend's locked_tier so the row can show the plan it needs", () => {
    const pages = visibleAgentPages(
      [{ slug: "engineer", locked_tier: "pro" }, { slug: "fundraising", locked_tier: null }],
      false,
    );
    expect(pages.map((p) => [p.kind, p.lockedTier])).toEqual([
      ["fundraising", null],
      ["engineer", "pro"],
    ]);
  });
});
