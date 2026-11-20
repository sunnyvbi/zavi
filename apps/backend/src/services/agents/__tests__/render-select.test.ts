import { describe, it, expect } from "vitest";
import {
  selectRenderedText,
  isMetaPlaceholder,
  synthesizeClarifyingMarkdown,
  stripChatJsonFences,
} from "../render-select";

const META_RM =
  "Asking 5 clarifying questions before building the GTM. No backlog items emitted — this is a strategy memo clarification turn.";

describe("isMetaPlaceholder", () => {
  it("flags short meta-comment phrasings", () => {
    expect(isMetaPlaceholder(META_RM)).toBe(true);
    expect(isMetaPlaceholder("Asking 3 questions first.")).toBe(true);
    expect(isMetaPlaceholder("No backlog items emitted.")).toBe(true);
  });

  it("does NOT flag a substantive answer", () => {
    const real =
      "## Reframe\nThe student subscription is a discount instrument. Expanding to all users is a monetization model shift that gates on Stripe Connect being live before recurring billing can collect reliably across the host payout rail.";
    expect(isMetaPlaceholder(real)).toBe(false);
  });

  it("does NOT flag a matching phrase that is over the length cap", () => {
    const long = "Asking 5 questions " + "x".repeat(200);
    expect(isMetaPlaceholder(long)).toBe(false);
  });

  it("handles undefined/empty", () => {
    expect(isMetaPlaceholder(undefined)).toBe(false);
    expect(isMetaPlaceholder("")).toBe(false);
  });
});

describe("selectRenderedText", () => {
  it("(a) attaches card + intro-only bubble (meta-rm) for pm", () => {
    const parsed = {
      rendered_markdown: META_RM,
      strategy: {
        clarifications_needed: {
          questions: ["What is the price point?", "Drivers or hosts first?"],
        },
      },
    };
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed,
      rawText: `some prose\n<product_pm_backlog>{...}</product_pm_backlog>`,
    });
    expect(out.rescueKind).toBe("structured_questions");
    expect(out.clarifyEnvelope).toBeTruthy();
    expect(out.clarifyEnvelope?.questions).toHaveLength(2);
    expect(out.text).toBe("I have a few questions before I continue:");
    expect(out.text).not.toContain("What is the price point?");
  });

  it("(a-eng) engineer (structured_clarifications flag) ALSO gets the rescue", () => {
    const out = selectRenderedText({
      envelope: "engineer_change_plan",
      agentSlug: "engineer",
      parsed: {
        rendered_markdown: META_RM,
        clarifications: ["Which repo?", "Deploy target?"],
      },
      rawText: `prose\n<engineer_change_plan>{...}</engineer_change_plan>`,
    });
    expect(out.rescueKind).toBe("structured_questions");
    expect(out.clarifyEnvelope?.questions).toHaveLength(2);
  });

  it("(a-neg) a non-rescue agent (research: no structured_clarifications flag) is NOT rescued", () => {
    const out = selectRenderedText({
      envelope: "research_report",
      agentSlug: "research",
      parsed: {
        rendered_markdown: META_RM,
        clarifications: ["Which market?", "What timeframe?"],
      },
      rawText: `prose\n<research_report>{...}</research_report>`,
    });
    expect(out.rescueKind).not.toBe("structured_questions");
  });

  it("(a2) attaches card on a real strategy_memo clarify turn (long prose rm)", () => {
    const longRm =
      "## Subscription GTM — 5 clarifying questions\n\nI have the architecture context (host tiers in SCRUM-4945). Before I rank GTM options I need 5 answers:\n\n**1. Which side leads the launch?**\nSCRUM detail.\n**2. What are the price points?**\nEven rough ranges help.";
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed: {
        rendered_markdown: longRm,
        strategy: {
          clarifications_needed: {
            questions: ["Which side leads?", "What are the price points?"],
          },
        },
      },
      rawText: `<product_pm_backlog>{...}</product_pm_backlog>`,
    });
    expect(out.rescueKind).toBe("structured_questions");
    expect(out.clarifyEnvelope).toBeTruthy();
    expect(out.text).toContain("Before I rank GTM options");
    expect(out.text).not.toContain("**1.");
    expect(out.text).not.toContain("Which side leads the launch");
  });

  it("(a3) falls back to generic intro when rm has no usable intro", () => {
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed: {
        rendered_markdown: "**1. First?**\n**2. Second?**",
        strategy: { clarifications_needed: { questions: ["First?", "Second?"] } },
      },
      rawText: `<product_pm_backlog>{...}</product_pm_backlog>`,
    });
    expect(out.rescueKind).toBe("structured_questions");
    expect(out.clarifyEnvelope).toBeTruthy();
    expect(out.text).toBe("I have a few questions before I continue:");
  });

  it("(a4) generic intro when rm opens directly with a long question", () => {
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed: {
        rendered_markdown:
          "**1. Which side should launch first — drivers or hosts simultaneously?**\n**2. What are the price points?**",
        strategy: { clarifications_needed: { questions: ["Which side?", "Price points?"] } },
      },
      rawText: `<product_pm_backlog>{...}</product_pm_backlog>`,
    });
    expect(out.clarifyEnvelope).toBeTruthy();
    expect(out.text).toBe("I have a few questions before I continue:");
    expect(out.text).not.toContain("Which side should launch first");
  });

  it("(a4b) generic intro for **1.**-style list with no real intro", () => {
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed: {
        rendered_markdown:
          "**1.** Which side launches first, drivers or hosts?\n**2.** What are the price points across tiers?",
        strategy: { clarifications_needed: { questions: ["Which side?", "Prices?"] } },
      },
      rawText: `<product_pm_backlog>{...}</product_pm_backlog>`,
    });
    expect(out.clarifyEnvelope).toBeTruthy();
    expect(out.text).toBe("I have a few questions before I continue:");
    expect(out.text).not.toContain("Which side launches first");
  });

  it("(a5) reframe_options + questions → card ATTACHED + full memo analysis in bubble", () => {
    const analysis =
      "Premise check: subscriptions are a retention play at your scale, not growth. The three reframe options below all assume warm-host distribution.";
    const realRm = `${analysis}\n\n1. What are the price points per tier?\n2. Which features unlock at each tier?`;
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed: {
        rendered_markdown: realRm,
        strategy: {
          reframe_options: [{ title: "Option A", rank: 1 }],
          clarifications_needed: { questions: ["What are the price points per tier?", "Which features unlock at each tier?"] },
        },
      },
      rawText: `<product_pm_backlog>{...}</product_pm_backlog>`,
    });
    expect(out.rescueKind).toBe("structured_questions");
    expect(out.clarifyEnvelope).toBeTruthy();
    expect(out.clarifyEnvelope?.questions).toHaveLength(2);
    expect(out.text).toContain("Premise check");
    expect(out.text).toContain("reframe options below");
  });

  it("(a5b) questions with thin memo → card attached, intro-only bubble", () => {
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed: {
        rendered_markdown: "Asking 1 question.",
        strategy: {
          reframe_options: [{ title: "Option A", rank: 1 }],
          clarifications_needed: { questions: ["a stray question?"] },
        },
      },
      rawText: `<product_pm_backlog>{...}</product_pm_backlog>`,
    });
    expect(out.rescueKind).toBe("structured_questions");
    expect(out.clarifyEnvelope).toBeTruthy();
  });

  it("(b) falls back to preceding prose when no structured field", () => {
    const longProse =
      "Before I build the GTM, here are the five things that materially change the strategy and why each one matters to the launch sequencing.";
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed: { rendered_markdown: META_RM },
      rawText: `${longProse}\n<product_pm_backlog>{"status":"no_signal"}</product_pm_backlog>`,
    });
    expect(out.rescueKind).toBe("preceding_prose");
    expect(out.text).toBe(longProse);
  });

  it("(c) returns rendered_markdown unchanged for a normal memo (no clarifications)", () => {
    const realRm =
      "## Reframe\nThis is a real strategy memo with substantive content that should pass through untouched as the chat body.";
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed: {
        rendered_markdown: realRm,
        strategy: { clarifications_needed: false },
      },
      rawText: `<product_pm_backlog>{...}</product_pm_backlog>`,
    });
    expect(out.rescueKind).toBeFalsy();
    expect(out.clarifyEnvelope).toBeFalsy();
    expect(out.text).toBe(realRm);
  });

  it("(d) does NOT structured-rescue an agent outside the gated set", () => {
    const out = selectRenderedText({
      envelope: "dispute_envelope",
      agentSlug: "dispute-response",
      parsed: {
        rendered_markdown: META_RM,
        questions: ["should not be used"],
      },
      rawText: `<dispute_envelope>{...}</dispute_envelope>`,
    });
    expect(out.rescueKind).toBeFalsy();
    expect(out.text).toBe(META_RM);
  });

  it("no-rendered_markdown path synthesizes from summary.bullets", () => {
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed: { summary: { bullets: ["finding one", "finding two"] } },
      rawText: `<product_pm_backlog>{...}</product_pm_backlog>`,
    });
    expect(out.rescueKind).toBeFalsy();
    expect(out.text).toContain("• finding one");
    expect(out.text).toContain("• finding two");
  });
});

describe("synthesizeClarifyingMarkdown", () => {
  it("numbers questions under a header and drops blanks", () => {
    const md = synthesizeClarifyingMarkdown(["a?", "  ", "b?"]);
    expect(md).toBe("## Clarifying questions\n\n1. a?\n\n2. b?");
  });
});

describe("stripChatJsonFences", () => {
  it("removes a fenced ```json recommendations block, keeping the prose", () => {
    const input =
      'Found 3 copy issues.\n\n```json\n{ "recommendations": [ { "title": "x" } ] }\n```';
    const out = stripChatJsonFences(input);
    expect(out).toBe("Found 3 copy issues.");
    expect(out).not.toContain("recommendations");
    expect(out).not.toContain("```");
  });

  it("removes a trailing un-fenced recommendations JSON object", () => {
    const input = 'Here is the summary.\n\n{ "recommendations": [ { "a": 1 } ] }';
    expect(stripChatJsonFences(input)).toBe("Here is the summary.");
  });

  it("leaves clean human prose untouched", () => {
    const prose = "A clean human summary with no JSON at all.";
    expect(stripChatJsonFences(prose)).toBe(prose);
  });
});

describe("structured rescue keeps the draft", () => {
  const plan =
    "Here is what I think is actually wrong. The constraint is supply, in one metro. " +
    "Hosts are the bottleneck and every paid dollar on the demand side is wasted until " +
    "that is fixed. Start with host acquisition in the lead metro and hold paid flat.";

  it("shows the model's prose when rendered_markdown is absent, and still attaches the card", () => {
    const out = selectRenderedText({
      envelope: "strategy",
      agentSlug: "cgo",
      parsed: {
        questions: ["What monthly budget can you commit?"],
      },
      rawText: `${plan}\n<strategy>{"questions":["What monthly budget can you commit?"]}</strategy>`,
    });
    expect(out.text).toContain("The constraint is supply");
    expect(out.text).not.toBe("I have a few questions before I continue:");
    expect(out.clarifyEnvelope).toBeTruthy();
    expect(out.clarifyEnvelope?.questions).toHaveLength(1);
  });

  it("still falls back to the intro when there is genuinely no prose to show", () => {
    const out = selectRenderedText({
      envelope: "strategy",
      agentSlug: "cgo",
      parsed: { questions: ["What monthly budget can you commit?"] },
      rawText: `<strategy>{"questions":["What monthly budget can you commit?"]}</strategy>`,
    });
    expect(out.text).toBe("I have a few questions before I continue:");
    expect(out.clarifyEnvelope).toBeTruthy();
  });
});

describe("the trim must not eat a numbered plan", () => {
  const planWithSteps =
    "The constraint is supply, in one metro.\n\n" +
    "1. Recruit 40 hosts in the lead metro this quarter.\n" +
    "2. Hold paid flat until host supply clears 200.\n" +
    "3. Fix the inquiry-response gap before spending more.";

  it("keeps the whole plan when the numbered lines are plan steps, not questions", () => {
    const out = selectRenderedText({
      envelope: "strategy",
      agentSlug: "cgo",
      parsed: {
        rendered_markdown: planWithSteps,
        questions: ["What monthly budget can you commit?"],
      },
      rawText: `<strategy>{}</strategy>`,
    });
    expect(out.text).toContain("Recruit 40 hosts");
    expect(out.text).toContain("Fix the inquiry-response gap");
    expect(out.clarifyEnvelope?.questions).toHaveLength(1);
    expect(out.text).not.toContain("What monthly budget can you commit?");
  });

  it("pm still trims, because for pm a numbered list really is the questions", () => {
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed: {
        rendered_markdown:
          "Before I rank the options I need two answers:\n\n" +
          "1. What monthly budget can you commit?\n" +
          "2. Which metro leads this quarter?",
        strategy: {
          clarifications_needed: {
            questions: [
              "What monthly budget can you commit?",
              "Which metro leads this quarter?",
            ],
          },
        },
      },
      rawText: `<product_pm_backlog>{}</product_pm_backlog>`,
    });
    expect(out.text).toContain("Before I rank the options");
    expect(out.text).not.toContain("1. What monthly budget");
  });
});

describe("round-3: blank rm, truncation, and the pm/cgo split on raw text", () => {
  const plan =
    "The constraint is supply, in one metro. Recruit 40 hosts this quarter and " +
    "hold paid flat until supply clears 200. Fix inquiry response before spending.";

  it("F2: a BLANK rendered_markdown still recovers the plan from outside the envelope", () => {
    const out = selectRenderedText({
      envelope: "strategy",
      agentSlug: "cgo",
      parsed: { rendered_markdown: "   ", questions: ["Budget?"] },
      rawText: `${plan}\n<strategy>{"questions":["Budget?"]}</strategy>`,
    });
    expect(out.text).toContain("The constraint is supply");
    expect(out.text.trim().length).toBeGreaterThan(50);
  });

  it("F3: a TRUNCATED envelope (no closing tag) does not leak raw JSON into the bubble", () => {
    const out = selectRenderedText({
      envelope: "strategy",
      agentSlug: "cgo",
      parsed: { questions: ["Budget?"] },
      rawText: `${plan}\n<strategy>{"questions":["Budget?"],"bets":[{"title":"partial`,
    });
    expect(out.text).toContain("The constraint is supply");
    expect(out.text).not.toContain('"bets"');
    expect(out.text).not.toContain("partial");
  });

  it("F1: pm does NOT get a pre-envelope question list as its bubble", () => {
    const out = selectRenderedText({
      envelope: "product_pm_backlog",
      agentSlug: "pm",
      parsed: {
        rendered_markdown: "Asking 2 clarifying questions. No backlog items emitted.",
        strategy: {
          clarifications_needed: {
            questions: ["What monthly budget can you commit?", "Which metro leads?"],
          },
        },
      },
      rawText:
        "1. What monthly budget can you commit?\n2. Which metro leads?\n" +
        "<product_pm_backlog>{}</product_pm_backlog>",
    });
    expect(out.text).toBe("I have a few questions before I continue:");
  });
});
