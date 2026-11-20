import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/mcp/internal-tool-names", () => ({
  INTERNAL_TOOL_NAMES: new Set(["acme.io__fetch", "a+b__run", "q?x__go", "sheet__read"]),
}));

import { scrubAgentEgress } from "@/services/agents/scrub-agent-egress";

const scrub = (text: string) => scrubAgentEgress(text, { surface: "chat", agentSlug: "operator" }).text;

describe("internal tool names are matched literally, never as regex syntax", () => {
  it("redacts each name exactly as written", () => {
    for (const name of ["acme.io__fetch", "a+b__run", "q?x__go", "sheet__read"]) {
      expect(scrub(`I ran ${name} for that.`)).not.toContain(name);
    }
  });

  it("keeps customer text that only matches a name read as a pattern", () => {
    expect(scrub("The field acmeXio__fetch is in our schema.")).toBe("The field acmeXio__fetch is in our schema.");
    expect(scrub("Call aaab__run nightly.")).toBe("Call aaab__run nightly.");
    expect(scrub("Then x__go runs.")).toBe("Then x__go runs.");
  });
});
