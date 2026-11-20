import { describe, it, expect } from "vitest";
import { loadGlobalAgentDefinition } from "@/services/agents/registry";
import { outputSchemas, dispatchers } from "../../index";

describe("research agent registry wiring", () => {
  const def = loadGlobalAgentDefinition("research");

  it("loads + parses frontmatter", () => {
    expect(def).not.toBeNull();
    expect(def?.name).toBe("research");
    expect(def?.metadata_praxis.model).toBe("claude-opus-5-5");
    expect(def?.metadata_praxis.output_envelope).toBe("research_report");
  });

  it("declares the inherited _core blocks + tools", () => {
    expect(def?.metadata_praxis.inherits).toContain("untrusted-data-handling");
    expect(def?.metadata_praxis.tools).toContain("web_search__search");
  });

  it("has its envelope schema + dispatcher registered", () => {
    expect(outputSchemas.research).toBeDefined();
    expect(dispatchers.research).toBeDefined();
  });
});
