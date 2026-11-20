import { describe, it, expect } from "vitest";
import { splitSystemPromptForCache } from "../system-prompt-cache-split";

const B = "<<BOUNDARY>>";

describe("splitSystemPromptForCache", () => {
  it("splits into [stable, boundary, dynamic] when the stable text is a real prefix", () => {
    const stable = "You are Zavi.\n\n## Rules\n…";
    const full = `${stable}\n\n---\nCurrent date: Sunday\n## Run context\n{}`;
    expect(splitSystemPromptForCache(full, stable, B)).toEqual([stable, B, "\n\n---\nCurrent date: Sunday\n## Run context\n{}"]);
  });

  it("rejoining the parts reproduces the exact prompt (the persisted snapshot is unchanged)", () => {
    const stable = "a".repeat(5000);
    const full = stable + "b".repeat(700);
    const parts = splitSystemPromptForCache(full, stable, B) as string[];
    expect(parts[0] + parts[2]).toBe(full);
  });

  it("falls back to the single string when the stable text is not a prefix, is empty, or nothing is dynamic", () => {
    expect(splitSystemPromptForCache("x" + "stable" + "dyn", "stable", B)).toBe("xstabledyn");
    expect(splitSystemPromptForCache("stabledyn", "", B)).toBe("stabledyn");
    expect(splitSystemPromptForCache("stable", "stable", B)).toBe("stable");
  });
});
