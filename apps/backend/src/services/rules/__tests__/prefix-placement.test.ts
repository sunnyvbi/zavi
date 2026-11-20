import { describe, it, expect } from "vitest";
import { buildStablePromptPrefix } from "@/services/agents/generic-dispatcher";
import { BRAND_VOICE_FOOTER, OPSEC_FOOTER } from "@/services/agents/opsec-footer";
import { renderRulesBlock } from "../load";

const BASE = {
  body_markdown: "# pm\n\nYou are an agent.\n",
  tenant: { name: "Acme" },
  memory: { company: "c", ops: "o", policies: "", disputes: "", support: "" },
};

describe("founder rules in the stable prefix", () => {
  it("no rules: the prefix is byte-identical to a build without the argument (acceptance 12)", () => {
    expect(buildStablePromptPrefix({ ...BASE, rulesBlock: undefined })).toBe(buildStablePromptPrefix(BASE));
  });

  it("rules sit last before the product-voice and opsec footers, which stay the floor", () => {
    const block = renderRulesBlock("Acme", [
      { id: "a", scope_kind: "all", scope_slug: null, text: "Never post on weekends", approved_at: null },
    ])!;
    const p = buildStablePromptPrefix({ ...BASE, rulesBlock: block });
    const at = p.indexOf(block);
    expect(at).toBeGreaterThan(0);
    expect(p.indexOf(BRAND_VOICE_FOOTER)).toBeGreaterThan(at);
    expect(p.endsWith(BRAND_VOICE_FOOTER + OPSEC_FOOTER)).toBe(true);
  });
});
