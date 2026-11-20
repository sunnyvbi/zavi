import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { synthMarkdownMock, deliverPdfMock } = vi.hoisted(() => ({
  synthMarkdownMock: vi.fn(),
  deliverPdfMock: vi.fn(),
}));

vi.mock("@/services/llm/synthMarkdown", () => ({
  synthMarkdown: synthMarkdownMock,
}));
vi.mock("@/services/reports/deliver-pdf", () => ({
  deliverPdf: deliverPdfMock,
}));

import { __test__ } from "../post-run";

const { injectCaveatsIntoMarkdown, buildPdfInput, buildEmailBody } = __test__;

const BASE_MARKDOWN = "## Decide today\n- Ship the wedge.\n\n## Next 30 days\n- Acquire 10 design partners.";

const FULL_ADVICE = {
  rendered_markdown: BASE_MARKDOWN,
  clarifications_needed: false as const,
  recommendations: {
    decide_today: [
      {
        title: "Launch paid pilot",
        rationale: "We have 3 design partners ready.",
        confidence: "evidence_grounded",
        disconfirming_signal: "If NPS from pilot 1 is below 40",
      },
      {
        title: "Hire a growth lead",
        rationale: "Current CAC is 3× target.",
        confidence: "inference",
        disconfirming_signal: "If CAC drops below $80 organically in 30 days",
      },
    ],
    lead_priority: "Launch paid pilot — everything else is noise until we have revenue.",
    deprioritize: ["seo", "brand refresh"],
  },
  dissent: {
    what_not_to_do: "Do NOT expand to a second vertical before hitting $1M ARR",
    why: "Splits focus and CAC pools — proven founder mistake at this stage",
  },
};

const NO_STRUCTURED_ADVICE = {
  rendered_markdown: BASE_MARKDOWN,
  clarifications_needed: false as const,
  recommendations: {
    decide_today: [],
    next_30d: [],
    watch_for: [],
    deprioritize: [],
  },
};

beforeEach(() => {
  synthMarkdownMock.mockReset();
  deliverPdfMock.mockReset();
  synthMarkdownMock.mockResolvedValue({
    markdown: "Short summary.",
    cost_usd: 0.001,
    model: "claude-sonnet-4-6",
    input_tokens: 10,
    output_tokens: 20,
  });
  deliverPdfMock.mockResolvedValue({
    artifact_id: "artifact-001",
    filename: "advisor-memo.pdf",
    bytes: 2048,
    slack_ok: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("injectCaveatsIntoMarkdown", () => {
  it("1a: lead_priority appears as a banner before the rendered_markdown", () => {
    const result = injectCaveatsIntoMarkdown(FULL_ADVICE);
    expect(result).toContain("Launch paid pilot — everything else is noise until we have revenue.");
    const bannerIdx = result.indexOf("Launch paid pilot — everything");
    const markdownIdx = result.indexOf("## Decide today");
    expect(bannerIdx).toBeLessThan(markdownIdx);
  });

  it("1b: decide_today confidence labels are injected", () => {
    const result = injectCaveatsIntoMarkdown(FULL_ADVICE);
    expect(result).toMatch(/Evidence-grounded/i);
    expect(result).toMatch(/Inference \(not fully verified\)/i);
  });

  it("1c: disconfirming_signal appears under each decide_today item", () => {
    const result = injectCaveatsIntoMarkdown(FULL_ADVICE);
    expect(result).toContain("If NPS from pilot 1 is below 40");
    expect(result).toContain("If CAC drops below $80 organically in 30 days");
    const pattern = /Would change my mind if:/g;
    const matches = result.match(pattern);
    expect(matches).toHaveLength(2);
  });

  it("1d: dissent block appears with what_not_to_do + why", () => {
    const result = injectCaveatsIntoMarkdown(FULL_ADVICE);
    expect(result).toContain("Do NOT expand to a second vertical before hitting $1M ARR");
    expect(result).toContain("Splits focus and CAC pools");
  });

  it("1e: no structured fields → rendered_markdown returned unchanged", () => {
    const result = injectCaveatsIntoMarkdown(NO_STRUCTURED_ADVICE);
    expect(result).toBe(BASE_MARKDOWN);
  });

  it("the injected block appears BEFORE the rendered_markdown (prepend pattern)", () => {
    const result = injectCaveatsIntoMarkdown(FULL_ADVICE);
    const injectedStart = result.indexOf("---");
    const markdownStart = result.indexOf(BASE_MARKDOWN);
    expect(injectedStart).toBeGreaterThanOrEqual(0);
    expect(injectedStart).toBeLessThan(markdownStart);
  });

  it("advice with lead_priority only (no decide_today/dissent) injects just the priority banner", () => {
    const sparse = {
      rendered_markdown: BASE_MARKDOWN,
      clarifications_needed: false as const,
      recommendations: {
        decide_today: [],
        lead_priority: "Ship the wedge first.",
      },
    };
    const result = injectCaveatsIntoMarkdown(sparse);
    expect(result).toContain("Ship the wedge first.");
    expect(result).not.toContain("Would change my mind if:");
    expect(result).not.toContain("What NOT to do:");
  });

  it("decide_today item without disconfirming_signal is included without the subline", () => {
    const noSignal = {
      rendered_markdown: BASE_MARKDOWN,
      clarifications_needed: false as const,
      recommendations: {
        decide_today: [
          {
            title: "Close the pilot",
            rationale: "x",
            confidence: "low_confidence_speculation",
          },
        ],
        lead_priority: "Close the pilot.",
      },
    };
    const result = injectCaveatsIntoMarkdown(noSignal);
    expect(result).toContain("Close the pilot");
    expect(result).toContain("Low-confidence speculation");
    expect(result).not.toContain("Would change my mind if:");
  });
});

describe("buildPdfInput — P1 caveat injection", () => {
  it("sections[0].body_markdown contains the injected lead_priority", () => {
    const pdf = buildPdfInput(FULL_ADVICE);
    expect(pdf.sections[0].body_markdown).toContain(
      "Launch paid pilot — everything else is noise",
    );
  });

  it("sections[0].body_markdown contains disconfirming signals", () => {
    const pdf = buildPdfInput(FULL_ADVICE);
    expect(pdf.sections[0].body_markdown).toContain("Would change my mind if:");
    expect(pdf.sections[0].body_markdown).toContain("If NPS from pilot 1 is below 40");
  });

  it("sections[0].body_markdown contains the dissent block", () => {
    const pdf = buildPdfInput(FULL_ADVICE);
    expect(pdf.sections[0].body_markdown).toContain(
      "Do NOT expand to a second vertical",
    );
  });

  it("advice with no structured fields → body_markdown equals rendered_markdown", () => {
    const pdf = buildPdfInput(NO_STRUCTURED_ADVICE);
    expect(pdf.sections[0].body_markdown).toBe(BASE_MARKDOWN);
  });
});

describe("buildEmailBody — P1 caveat injection passed to synthMarkdown", () => {
  it("synthMarkdown user_prompt contains lead_priority text", async () => {
    await buildEmailBody(FULL_ADVICE, "tenant-test");
    expect(synthMarkdownMock).toHaveBeenCalledTimes(1);
    const args = synthMarkdownMock.mock.calls[0][0];
    expect(args.user_prompt).toContain(
      "Launch paid pilot — everything else is noise",
    );
  });

  it("synthMarkdown user_prompt contains disconfirming signal text", async () => {
    await buildEmailBody(FULL_ADVICE, "tenant-test");
    const args = synthMarkdownMock.mock.calls[0][0];
    expect(args.user_prompt).toContain("Would change my mind if:");
    expect(args.user_prompt).toContain("If NPS from pilot 1 is below 40");
  });

  it("fallback (synthMarkdown throws) also uses enriched markdown", async () => {
    synthMarkdownMock.mockRejectedValueOnce(new Error("503 overloaded"));
    const body = await buildEmailBody(FULL_ADVICE, "tenant-test");
    expect(body).toContain("Launch paid pilot — everything else is noise");
  });

  it("no structured fields → synthMarkdown user_prompt equals rendered_markdown (unchanged)", async () => {
    await buildEmailBody(NO_STRUCTURED_ADVICE, "tenant-test");
    const args = synthMarkdownMock.mock.calls[0][0];
    expect(args.user_prompt).toContain(BASE_MARKDOWN);
    expect(args.user_prompt).not.toContain("Would change my mind if:");
  });
});
