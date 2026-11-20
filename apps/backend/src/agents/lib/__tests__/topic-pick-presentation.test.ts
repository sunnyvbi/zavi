import { describe, it, expect } from "vitest";
import { recipeDeliverableSchema, topicPickPresentationSchema } from "@/agents/lib/channel-recipe-step";

const topic = (n: number) => ({
  title: `Topic ${n}`,
  why: "People search it and you have no page.",
  searches: ["acme vs globex"],
  ranks: [{ site: "globex.com", note: "Their own page." }],
  your_site: "No comparison page.",
  have: [{ text: "Acme costs $20.", src: "acme.com/pricing" }],
  fill: ["One customer quote"],
});

describe("topic_pick presentation", () => {
  it("keeps up to 5 topics and clamps long text instead of failing", () => {
    const p = topicPickPresentationSchema.parse({
      type: "topic_pick",
      topics: [1, 2, 3, 4, 5, 6].map(topic).map((t, i) => (i === 0 ? { ...t, why: "x ".repeat(450) } : t)),
    });
    expect(p.topics).toHaveLength(5);
    expect(p.topics[0].why.length).toBeLessThanOrEqual(240);
  });

  it("drops a broken topic, not the card", () => {
    const d = recipeDeliverableSchema.parse({
      kind: "proof_topics",
      label: "Pick your next page",
      content: "1. Topic 1\n2. Topic 2",
      presentation: { type: "topic_pick", topics: [topic(1), { title: "" }, topic(2)] },
    });
    expect(d?.kind).toBe("proof_topics");
    expect((d?.presentation as { topics: unknown[] }).topics).toHaveLength(2);
  });

  it("a topic_pick with no usable topic costs the presentation, never the deliverable (kept as an ordinary card)", () => {
    const d = recipeDeliverableSchema.parse({
      kind: "proof_topics",
      label: "Pick your next page",
      content: "nothing usable",
      presentation: { type: "topic_pick", topics: [] },
    });
    expect(d?.kind).toBe("other");
    expect(d?.content).toBe("nothing usable");
    expect(d?.presentation).toBeUndefined();
  });

  it("no longer knows proof_question", () => {
    const d = recipeDeliverableSchema.parse({ kind: "proof_question", label: "q", content: "c" });
    expect(d?.kind).toBe("other");
  });
  it("a proof_topics card without usable topics becomes an ordinary card", () => {
    const broken = recipeDeliverableSchema.parse({ kind: "proof_topics", label: "Pick", content: "x", presentation: { type: "topic_pick", topics: [] } });
    expect(broken?.kind).toBe("other");
    const missing = recipeDeliverableSchema.parse({ kind: "proof_topics", label: "Pick", content: "x" });
    expect(missing?.kind).toBe("other");
    const ok = recipeDeliverableSchema.parse({ kind: "proof_topics", label: "Pick", content: "x", presentation: { type: "topic_pick", topics: [topic(1)] } });
    expect(ok?.kind).toBe("proof_topics");
  });
});
