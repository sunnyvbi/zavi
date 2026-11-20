import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/agents/generic-dispatcher", () => ({ runGeneric: vi.fn() }));
vi.mock("@/services/reports/deliver-pdf", () => ({
  deliverPdf: vi.fn(async () => ({ artifact_id: "a1", filename: "f", bytes: 1, slack_ok: true })),
}));

let fakeText = "";
const createSpy = vi.fn(async () => ({ content: [{ type: "text", text: fakeText }] }));
vi.mock("@/services/anthropic", () => ({
  getAnthropic: () => ({ messages: { create: createSpy } }),
  heliconePropertyHeaders: () => ({}),
}));

import { runGeneric } from "@/services/agents/generic-dispatcher";
import { researchDispatcher } from "../dispatcher";

const ctxRun = { tenant_id: "t", runId: "r" } as never;

const VALID_REPORT = {
  kind: "report",
  template: "landscape",
  title: "Reconstructed Findings",
  query: "q",
  blocks: [
    {
      type: "exec_summary",
      prose_md: "Source A reports a deficit; Source B reports a surplus — conflict noted.",
      citations: [],
    },
  ],
  lenses: [],
  sources: [],
  validation: [],
  failed_lenses: [],
  generated_at: "2026-06-20T00:00:00Z",
};

const FETCHED = [
  {
    name: "web_fetch__fetch",
    status: "ok",
    output_preview:
      "Bank of America's commodity desk projects a 2.0 million barrel-per-day crude DEFICIT " +
      "for H2 2026, citing OPEC+ discipline and resilient demand across Asia.",
  },
  {
    name: "web_search__search",
    status: "ok",
    output_preview:
      "Wood Mackenzie's latest oil-market outlook projects a SURPLUS of roughly 1.1 million " +
      "barrels per day over the same period, driven by non-OPEC supply growth in the Americas.",
  },
];

const BAIL = "I couldn't put together a verified, cited analysis. Want me to run it again?";

describe("research B2 reconstruct tier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEARCH_GROUNDING_DISABLED = "1";
    delete process.env.RESEARCH_B2_RECONSTRUCT_DISABLED;
  });
  afterEach(() => {
    delete process.env.RESEARCH_GROUNDING_DISABLED;
  });

  it("reconstructs a valid report from fetched data instead of bailing", async () => {
    fakeText = JSON.stringify(VALID_REPORT);
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({
      parse_ok: false,
      parsed: null,
      output_text: BAIL,
      raw_response_text: BAIL,
      tool_calls: FETCHED,
    });
    const res = await researchDispatcher(ctxRun, { ask: "oil balance?" });
    expect((res.parsed as { kind?: string } | null)?.kind).toBe("report");
    expect(res.output_text).not.toContain("run it again");
    expect(res.parse_ok).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("falls to a clarification floor (not the stub) when reconstruction fails but data was fetched", async () => {
    fakeText = "sorry, I cannot produce JSON here";
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({
      parse_ok: false,
      parsed: null,
      output_text: BAIL,
      raw_response_text: BAIL,
      tool_calls: FETCHED,
    });
    const res = await researchDispatcher(ctxRun, { ask: "oil balance?" });
    expect((res.parsed as { kind?: string } | null)?.kind).toBe("clarification");
    expect(res.output_text).not.toContain("run it again");
  });

  it("keeps the honest stub when there is NO usable fetched data (no regression)", async () => {
    fakeText = JSON.stringify(VALID_REPORT);
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({
      parse_ok: false,
      parsed: null,
      output_text: BAIL,
      raw_response_text: BAIL,
      tool_calls: [],
    });
    const res = await researchDispatcher(ctxRun, { ask: "q" });
    expect(res.parsed).toBeNull();
    expect(res.parse_ok).toBe(false);
    expect(res.output_text).toContain("verified, cited analysis");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("kill-switch RESEARCH_B2_RECONSTRUCT_DISABLED falls straight through to the stub", async () => {
    process.env.RESEARCH_B2_RECONSTRUCT_DISABLED = "1";
    fakeText = JSON.stringify(VALID_REPORT);
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({
      parse_ok: false,
      parsed: null,
      output_text: BAIL,
      raw_response_text: BAIL,
      tool_calls: FETCHED,
    });
    const res = await researchDispatcher(ctxRun, { ask: "q" });
    expect(res.parsed).toBeNull();
    expect(res.output_text).toContain("verified, cited analysis");
    expect(createSpy).not.toHaveBeenCalled();
  });
});
