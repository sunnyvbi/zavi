
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_MD = join(__dirname, "..", "agent.md");

describe("onboarding-discovery agent.md", () => {
  it("declares NO output_envelope (its output is its WRITES, not its prose)", () => {
    const src = readFileSync(AGENT_MD, "utf8");
    const declares = /^\s*output_envelope\s*:/m.test(
      src.split(/^---$/m)[1] ?? "",
    );
    expect(
      declares,
      "onboarding-discovery must not declare output_envelope — it is a brain WRITER; " +
        "grade it by the anchors it wrote (receipts), not a self-authored envelope (claims). " +
        "Re-adding this without ALSO teaching the tag in the body reproduces the 24/24 parse_failed outage.",
    ).toBe(false);
  });

  it("still declares the write tool it is actually measured by", () => {
    const src = readFileSync(AGENT_MD, "utf8");
    expect(src).toContain("onboarding_discovery__write_anchor");
  });
});
