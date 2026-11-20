import { describe, it, expect } from "vitest";
import { recipeDeliverableSchema } from "@/agents/lib/channel-recipe-step";

describe("geo's answer_check presentation", () => {
  it("parses on a list deliverable and keeps the questions as the portable content", () => {
    const d = recipeDeliverableSchema.parse({
      kind: "list",
      label: "Questions Zavi will ask",
      content: "1. Who fits blinds in Wimbledon?\n2. Where can I buy Silent Gliss tracks in London?",
      presentation: { type: "answer_check" },
    });
    expect(d.kind).toBe("list");
    expect(d.presentation).toEqual({ type: "answer_check" });
    expect(d.content).toContain("Wimbledon");
  });

  it("leaves a list without it exactly as before", () => {
    const d = recipeDeliverableSchema.parse({ kind: "list", label: "Kit", content: "1. A question" });
    expect(d.presentation).toBeUndefined();
  });
});
