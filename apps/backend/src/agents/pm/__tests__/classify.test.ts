import { describe, it, expect } from "vitest";
import {
  classifyProductPmMode,
  classifyProductPmChatModeRaw,
} from "../classify";

describe("classifyProductPmMode — DELIVERY-default invariant", () => {
  it.each([
    ["cron", "growth pricing strategy"],
    ["manual", ""],
    ["a2a", "how do I grow"],
    ["scheduled", "pricing"],
    [undefined as unknown as string, "growth"],
  ])("non-chat trigger %s → delivery", (trigger, t) => {
    expect(classifyProductPmMode({ trigger, userText: t })).toBe("delivery");
  });

  it.each([
    ["  "],
    ["hi"],
    ["what's the top backlog item this week?"],
    ["can you take a look at things?"],
    ["what churn-related backlog item should we ship next?"],
  ])("chat ambiguous/backlog %j → delivery (no prior artifact)", (t) => {
    expect(classifyProductPmMode({ trigger: "chat", userText: t })).toBe("delivery");
  });

  it.each([
    ["how can I grow the product? Indian parents won't spend much"],
    ["should we raise our pricing or add a free tier?"],
    ["how do we position against the incumbent competitor?"],
    ["who is our ideal customer and what's the wedge?"],
    ["why would anyone switch to us from the status quo?"],
  ])("chat strategy %j → strategy_memo (even with prior artifact)", (t) => {
    expect(
      classifyProductPmMode({
        trigger: "chat",
        userText: t,
        hasPriorArtifact: true,
      }),
    ).toBe("strategy_memo");
  });
});

describe("classifyProductPmMode — ITERATE mode (Slice B 2026-05-19)", () => {
  it("chat + prior artifact + non-strategy follow-up → iterate", () => {
    expect(
      classifyProductPmMode({
        trigger: "chat",
        userText: "Here's more info — the deal closed last Friday, redo the backlog with this in mind.",
        hasPriorArtifact: true,
      }),
    ).toBe("iterate");
  });

  it("chat + no prior artifact + non-strategy → delivery (iterate requires prior artifact)", () => {
    expect(
      classifyProductPmMode({
        trigger: "chat",
        userText: "Here's more info — redo the backlog please.",
        hasPriorArtifact: false,
      }),
    ).toBe("delivery");
  });

  it("strategy verb beats prior artifact (operator can pivot delivery→strategy)", () => {
    expect(
      classifyProductPmMode({
        trigger: "chat",
        userText: "how do we position against the incumbent competitor?",
        hasPriorArtifact: true,
      }),
    ).toBe("strategy_memo");
  });

  it("non-chat trigger never iterates (cron hard invariant)", () => {
    expect(
      classifyProductPmMode({
        trigger: "cron",
        userText: "redo the backlog with new info",
        hasPriorArtifact: true,
      }),
    ).toBe("delivery");
  });
});

describe("classifyProductPmChatModeRaw — overlap bands → ambiguous", () => {
  it.each([
    ["how should we grow completed trips — give me a RICE-ranked backlog of what to ship"],
    ["should we expand or fix retention first? RICE-rank what to ship next"],
  ])("strategy-verb + delivery ask %j → ambiguous", (t) => {
    expect(classifyProductPmChatModeRaw({ trigger: "chat", userText: t })).toBe(
      "ambiguous",
    );
  });

  it.each([
    ["a fraud scare wants us to tighten verification, but supply is thin — what's the call?"],
    ["tighten the trust gates versus keep supply flowing — what's the right balance?"],
    ["do we charge a fee at launch or not, and do we roll out in one region or go wide?"],
  ])("tradeoff w/o verb %j → ambiguous", (t) => {
    expect(classifyProductPmChatModeRaw({ trigger: "chat", userText: t })).toBe(
      "ambiguous",
    );
  });
});

describe("classifyProductPmChatModeRaw — clear cases never trip the tiebreaker", () => {
  it("clear strategy verb (no delivery shape) → strategy_memo", () => {
    expect(
      classifyProductPmChatModeRaw({
        trigger: "chat",
        userText: "should we raise our pricing or add a free tier?",
      }),
    ).toBe("strategy_memo");
  });

  it.each([
    ["what's the top backlog item this week?"],
    ["what churn-related backlog item should we ship next?"],
  ])("clear delivery/backlog %j → delivery (no prior)", (t) => {
    expect(classifyProductPmChatModeRaw({ trigger: "chat", userText: t })).toBe(
      "delivery",
    );
  });

  it("non-chat trigger → delivery (hard invariant preserved)", () => {
    expect(
      classifyProductPmChatModeRaw({ trigger: "cron", userText: "what's the call here?" }),
    ).toBe("delivery");
  });

  it("prior artifact + non-strategy follow-up → iterate (preserved)", () => {
    expect(
      classifyProductPmChatModeRaw({
        trigger: "chat",
        userText: "Here's more info — the deal closed Friday, redo the backlog with this in mind.",
        hasPriorArtifact: true,
      }),
    ).toBe("iterate");
  });
});

describe("ENGINEER_HANDOFF_INTENT — chat handoff → delivery (2026-06-07)", () => {
  const handoffAsks = [
    "send this PDF to the engineer to update the codebase",
    "have the engineer implement this pricing page",
    "dispatch the engineer to fix the signup flow",
    "can you hand this off to the engineer",
    "route this to the engineer to build",
    "get the engineer to wire up the new endpoint",
    "the engineer should implement the redesign",
    "fire the engineer on this bug",
  ];

  it.each(handoffAsks)("raw classifier: %s → delivery", (t) => {
    expect(classifyProductPmChatModeRaw({ trigger: "chat", userText: t })).toBe(
      "delivery",
    );
  });

  it("handoff beats prior artifact (would otherwise iterate)", () => {
    expect(
      classifyProductPmChatModeRaw({
        trigger: "chat",
        userText: "send this PDF to the engineer to update the codebase",
        hasPriorArtifact: true,
      }),
    ).toBe("delivery");
  });

  it("handoff beats a strategy verb in the same turn", () => {
    expect(
      classifyProductPmChatModeRaw({
        trigger: "chat",
        userText: "have the engineer implement the new pricing page now",
        hasPriorArtifact: true,
      }),
    ).toBe("delivery");
  });

  it("original classifier also routes handoff → delivery", () => {
    expect(
      classifyProductPmMode({
        trigger: "chat",
        userText: "send this to the engineer to ship",
        hasPriorArtifact: true,
      }),
    ).toBe("delivery");
  });

  it("does NOT over-trigger: strategy turn that merely mentions engineering", () => {
    expect(
      classifyProductPmChatModeRaw({
        trigger: "chat",
        userText: "what's the right pricing strategy for our engineering tools",
      }),
    ).toBe("strategy_memo");
  });

  it("does NOT trigger on a non-engineer handoff (stays non-delivery for redirect)", () => {
    const m = classifyProductPmChatModeRaw({
      trigger: "chat",
      userText: "send this to support so they can follow up",
      hasPriorArtifact: true,
    });
    expect(m).toBe("iterate");
  });
});

describe("Fix #2 — short follow-ups respect prior artifact", () => {
  const both: Array<[string, (a: { trigger: string; userText: string; hasPriorArtifact?: boolean }) => string]> = [
    ["raw", (a) => classifyProductPmChatModeRaw(a)],
    ["original", (a) => classifyProductPmMode(a)],
  ];

  for (const [name, fn] of both) {
    it(`${name}: short follow-up + prior artifact → iterate ("redo")`, () => {
      expect(fn({ trigger: "chat", userText: "redo", hasPriorArtifact: true })).toBe("iterate");
    });
    it(`${name}: short follow-up + prior artifact → iterate ("do that")`, () => {
      expect(fn({ trigger: "chat", userText: "do that", hasPriorArtifact: true })).toBe("iterate");
    });
    it(`${name}: short turn, NO prior artifact → delivery (cheap short-circuit kept)`, () => {
      expect(fn({ trigger: "chat", userText: "redo", hasPriorArtifact: false })).toBe("delivery");
    });
    it(`${name}: empty turn + prior artifact → delivery (no regeneration)`, () => {
      expect(fn({ trigger: "chat", userText: "", hasPriorArtifact: true })).toBe("delivery");
    });
    it(`${name}: whitespace turn + prior artifact → delivery (no regeneration)`, () => {
      expect(fn({ trigger: "chat", userText: "   ", hasPriorArtifact: true })).toBe("delivery");
    });
    it(`${name}: precedence preserved — handoff + prior artifact → delivery`, () => {
      expect(
        fn({ trigger: "chat", userText: "send this to the engineer to ship it", hasPriorArtifact: true }),
      ).toBe("delivery");
    });
    it(`${name}: precedence preserved — strategy verb + prior artifact → strategy_memo`, () => {
      expect(
        fn({ trigger: "chat", userText: "should we raise our pricing?", hasPriorArtifact: true }),
      ).toBe("strategy_memo");
    });
  }
});
