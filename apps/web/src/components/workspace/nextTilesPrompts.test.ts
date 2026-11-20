import { describe, expect, it } from "vitest";
import { NEXT_TILE_MAKE_PROMPTS, NEXT_TILE_THINK_PROMPTS } from "@zavi/shared";
import { MAKE_SUGGESTION_CHIPS, WORKSPACE_MODE_SUGGESTION_CHIPS } from "./ZaviWelcome";

const pairs = (items: ReadonlyArray<{ label: string; prompt: string }>) =>
  items.map(({ label, prompt }) => ({ label, prompt }));

describe("next-tile prompts mirror the Home chip rows", () => {
  it("THINK prompts equal the grow chips", () => {
    expect(pairs(NEXT_TILE_THINK_PROMPTS)).toEqual(pairs(WORKSPACE_MODE_SUGGESTION_CHIPS.grow));
  });

  it("MAKE prompts equal the make chips", () => {
    expect(pairs(NEXT_TILE_MAKE_PROMPTS)).toEqual(pairs(MAKE_SUGGESTION_CHIPS));
  });
});
