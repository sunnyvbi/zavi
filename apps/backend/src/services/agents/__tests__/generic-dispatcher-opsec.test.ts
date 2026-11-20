import { describe, it, expect } from "vitest";
import { buildSystemPromptForTest } from "../generic-dispatcher";
import { OPSEC_FOOTER } from "../opsec-footer";

describe("generic-dispatcher OPSEC footer wiring", () => {
  it("appends OPSEC_FOOTER to the rendered system prompt", () => {
    const rendered = buildSystemPromptForTest({
      body_markdown: "# minimal\n\nYou are an agent.\n",
      memory: { company: "test co", ops: "test ops" },
      run_context: {},
    });
    expect(rendered).toContain(OPSEC_FOOTER.trim());
  });

  it("appends OPSEC_FOOTER AFTER the citation instruction", () => {
    const rendered = buildSystemPromptForTest({
      body_markdown: "# minimal\n\nYou are an agent.\n",
      memory: { company: "test co", ops: "test ops" },
      run_context: {},
    });
    const citationIdx = rendered.indexOf("Citations");
    const opsecIdx = rendered.indexOf("Operational security");
    expect(citationIdx).toBeGreaterThan(-1);
    expect(opsecIdx).toBeGreaterThan(citationIdx);
  });
});
