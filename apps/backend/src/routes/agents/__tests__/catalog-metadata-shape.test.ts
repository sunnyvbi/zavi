import { describe, it, expect } from "vitest";
import { shapeCatalogMetadata } from "../list";

const FULL = {
  model: "claude-opus-4-7",
  cost_class: "high",
  tools: ["memory__write", "praxis_corpus__query_recent_runs", "slack__list_channels"],
  output_envelope: { type: "object", properties: { rendered_markdown: {} } },
  recall_policy: "tier0",
  decision_class: "ops.do-thing",
  side_effects: true,
  manual_only: false,
};

describe("shapeCatalogMetadata — catalog disclosure guard", () => {
  it("drops the platform model", () => {
    const out = shapeCatalogMetadata(FULL) as Record<string, unknown>;
    expect(out.model).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("claude-opus-4-7");
  });

  it("drops internal tool SYMBOL names but preserves the count for the UI badge", () => {
    const out = shapeCatalogMetadata(FULL);
    expect(out.tools).toHaveLength(3);
    expect(JSON.stringify(out.tools)).not.toContain("memory__write");
    expect(JSON.stringify(out.tools)).not.toContain("praxis_corpus__");
    expect(JSON.stringify(out.tools)).not.toContain("slack__");
  });

  it("drops other internal config the client never reads", () => {
    const out = shapeCatalogMetadata(FULL) as Record<string, unknown>;
    expect(out.output_envelope).toBeUndefined();
    expect(out.recall_policy).toBeUndefined();
    expect(out.decision_class).toBeUndefined();
    expect(out.side_effects).toBeUndefined();
  });

  it("keeps cost_class (the fork gallery renders it)", () => {
    expect(shapeCatalogMetadata(FULL).cost_class).toBe("high");
  });

  it("handles missing/empty metadata without throwing", () => {
    expect(shapeCatalogMetadata(null).tools).toEqual([]);
    expect(shapeCatalogMetadata({}).tools).toEqual([]);
    expect(shapeCatalogMetadata({ tools: [] }).cost_class).toBeUndefined();
  });
});
