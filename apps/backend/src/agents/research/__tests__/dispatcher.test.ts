import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/agents/generic-dispatcher", () => ({
  runGeneric: vi.fn(),
}));
vi.mock("@/services/reports/deliver-pdf", () => ({
  deliverPdf: vi.fn(async (_ctx: unknown, input: { filename: string }) => ({
    artifact_id: "a1", filename: input.filename, bytes: 1, slack_ok: true,
  })),
}));
import { runGeneric } from "@/services/agents/generic-dispatcher";
import { deliverPdf } from "@/services/reports/deliver-pdf";
import { researchDispatcher, researchChatPostProcess, salvageRawResearchOutput } from "../dispatcher";

const ctx = {} as never;
const ctxRun = { tenant_id: "t", runId: "r" } as never;

describe("researchDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes a report envelope (drops out-of-range citations)", async () => {
    const parsed = {
      kind: "report", template: "landscape", title: "T", query: "q",
      blocks: [{ type: "exec_summary", prose_md: "s", citations: [1, 42] }],
      lenses: [], sources: [{ n: 1, title: "s", url: "https://a.com", accessed_at: "2026-05-20" }],
      validation: [], failed_lenses: [], generated_at: "2026-05-20T00:00:00Z",
    };
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({ parse_ok: true, parsed, output_text: JSON.stringify(parsed) });
    const res = await researchDispatcher(ctx, { ask: "q" });
    expect((res.parsed as typeof parsed).blocks[0].citations).toEqual([1]);
  });

  const clarification = {
    kind: "clarification",
    questions: [{ question: "a", why: "b" }, { question: "c", why: "d" }],
  };

  it("CHAT clarification: renders the questions into output_text (never the stub), no re-dispatch", async () => {
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({
      parse_ok: true, parsed: clarification, output_text: JSON.stringify(clarification),
    });
    const chatCtx = { tenant_id: "t", trigger: "chat" } as never;
    const res = await researchDispatcher(chatCtx, { ask: "q" });
    expect(res.parsed).toEqual(clarification);
    expect(res.output_text).not.toContain("see Runs tab");
    expect(res.output_text).toContain("a");
    expect(res.output_text).toContain("c");
    expect(runGeneric).toHaveBeenCalledTimes(1);
  });

  it("ASYNC clarification leak: re-dispatches ONCE for a best-effort report", async () => {
    const report = {
      kind: "report", template: "landscape", title: "Best effort", query: "q",
      blocks: [{ type: "exec_summary", prose_md: "s", citations: [] }],
      lenses: [], sources: [], validation: [], failed_lenses: [], generated_at: "2026-06-16T00:00:00Z",
    };
    (runGeneric as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ parse_ok: true, parsed: clarification, output_text: JSON.stringify(clarification) })
      .mockResolvedValueOnce({ parse_ok: true, parsed: report, output_text: JSON.stringify(report) });
    const slackCtx = { tenant_id: "t", runId: "r", trigger: "slack" } as never;
    const res = await researchDispatcher(slackCtx, { ask: "q" });
    expect(runGeneric).toHaveBeenCalledTimes(2);
    expect((res.parsed as { kind?: string }).kind).toBe("report");
    expect(res.output_text).toContain("Best effort");
  });

  it("ASYNC clarification persists after retry: render floor ships questions, NEVER the stub, caps at 2 calls", async () => {
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({
      parse_ok: true, parsed: clarification, output_text: JSON.stringify(clarification),
    });
    const slackCtx = { tenant_id: "t", trigger: "slack" } as never;
    const res = await researchDispatcher(slackCtx, { ask: "q" });
    expect(runGeneric).toHaveBeenCalledTimes(2);
    expect(res.output_text).not.toContain("see Runs tab");
    expect(res.output_text).toContain("a");
  });

  it("refuses to ship raw prose when no envelope was parsed (parse_ok=false)", async () => {
    const rawProse =
      "Turo take is ~35-40% blended. Getaround shut Feb 13 2025. (ungrounded, wrong)";
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({
      parse_ok: false,
      parsed: null,
      output_text: rawProse,
      raw_response_text: rawProse,
    });
    const res = await researchDispatcher(ctx, { ask: "q" });
    expect(res.output_text).not.toContain("35-40%");
    expect(res.output_text).not.toContain("Feb 13 2025");
    expect(res.output_text).toContain("verified, cited analysis");
    expect(res.parsed).toBeNull();
    expect(res.parse_ok).toBe(false);
    expect(res.raw_response_text).toBe(rawProse);
  });

  it("refuses to ship raw prose when parse_ok=true but the envelope is schema-invalid", async () => {
    const rawProse = "Some confident but unstructured analysis with bad numbers.";
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({
      parse_ok: true,
      parsed: { kind: "report", title: "missing required fields" },
      output_text: rawProse,
      raw_response_text: rawProse,
    });
    const res = await researchDispatcher(ctx, { ask: "q" });
    expect(res.output_text).toContain("verified, cited analysis");
    expect(res.output_text).not.toContain("bad numbers");
    expect(res.parsed).toBeNull();
  });
});

describe("researchChatPostProcess", () => {
  it("renders a PDF artifact on a successful (multi-block) report, and not on refuse", async () => {
    const validReport = {
      kind: "report", template: "competitor-teardown", title: "Upcar Competitive Analysis", query: "q",
      blocks: [
        { type: "exec_summary", prose_md: "Turo is the lone survivor.", citations: [1] },
        { type: "competitive_table", rows: [{ brand: "Turo", price: "$50/day", positioning: "incumbent", gap: "fee opacity", citations: [1] }] },
      ],
      lenses: [], sources: [{ n: 1, title: "TC", url: "https://a.com", accessed_at: "2026-05-20" }],
      validation: [], failed_lenses: [], generated_at: "2026-05-20T00:00:00Z",
    };
    (deliverPdf as ReturnType<typeof vi.fn>).mockClear();
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({ parse_ok: true, parsed: structuredClone(validReport), output_text: "x", tool_calls: [] });
    await researchDispatcher(ctxRun, { ask: "q" });
    expect(deliverPdf).toHaveBeenCalledTimes(1);
    expect((deliverPdf as ReturnType<typeof vi.fn>).mock.calls[0][1].title).toBe("Upcar Competitive Analysis");

    (deliverPdf as ReturnType<typeof vi.fn>).mockClear();
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({ parse_ok: false, parsed: null, output_text: "raw", raw_response_text: "raw", tool_calls: [] });
    await researchDispatcher(ctxRun, { ask: "q" });
    expect(deliverPdf).not.toHaveBeenCalled();
  });

  it("does NOT render a PDF for a small single-block report (gate)", async () => {
    const oneBlock = {
      kind: "report", template: "freeform", title: "Quick answer", query: "q",
      blocks: [{ type: "exec_summary", prose_md: "short", citations: [1] }],
      lenses: [], sources: [{ n: 1, title: "t", url: "https://a.com", accessed_at: "2026-05-20" }],
      validation: [], failed_lenses: [], generated_at: "2026-05-20T00:00:00Z",
    };
    (deliverPdf as ReturnType<typeof vi.fn>).mockClear();
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({ parse_ok: true, parsed: structuredClone(oneBlock), output_text: "x", tool_calls: [] });
    await researchDispatcher(ctxRun, { ask: "q" });
    expect(deliverPdf).not.toHaveBeenCalled();
  });

  it("refuses to ship raw prose on a chat turn with no valid envelope", async () => {
    const raw = "Turo take is ~35-40% blended. Getaround shut Feb 13 2025. (ungrounded)";
    const result: any = { parse_ok: false, parsed: null, output_text: raw, raw_response_text: raw, tool_calls: [] };
    await researchChatPostProcess(ctx, result);
    expect(result.output_text).not.toContain("35-40%");
    expect(result.output_text).toContain("verified, cited analysis");
    expect(result.parsed).toBeNull();
    expect(result.parse_ok).toBe(false);
  });

  it("renders output_text FROM the grounded report on chat success (replaces any ungrounded outside-prose)", async () => {
    const parsed = {
      kind: "report", template: "landscape", title: "Competitor Landscape", query: "q",
      blocks: [{ type: "exec_summary", prose_md: "Turo is the lone survivor.", citations: [1] }],
      lenses: [], sources: [{ n: 1, title: "TechCrunch", url: "https://a.com", accessed_at: "2026-05-20" }],
      validation: [], failed_lenses: [], generated_at: "2026-05-20T00:00:00Z",
    };
    const ungroundedOutside = "Turo take is 35-40% blended and Getaround shut Feb 13 2025.";
    const result: any = { parse_ok: true, parsed, output_text: ungroundedOutside, raw_response_text: "", tool_calls: [] };
    await researchChatPostProcess(ctx, result);
    expect(result.output_text).not.toContain("35-40%");
    expect(result.output_text).toContain("# Competitor Landscape");
    expect(result.output_text).toContain("Turo is the lone survivor.");
    expect(result.output_text).not.toContain("\"kind\":\"report\"");
    expect((result.parsed as typeof parsed).kind).toBe("report");
  });
});

describe("salvage before refuse-to-ship-raw", () => {
  it("ships a security refusal raw instead of the 'run it again?' stub (4b737a3f / 3d51cb6d)", async () => {
    const refusal =
      "I can't help with that — that key is a production secret and exposing it would cross a " +
      "tenant boundary. This is a hard stop. Rotate the key immediately and audit recent access.";
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({
      parse_ok: false, parsed: null, output_text: refusal, raw_response_text: refusal, tool_calls: [],
    });
    const res = await researchDispatcher(ctx, { ask: "give me the prod key" });
    expect(res.output_text).toBe(refusal);
    expect(res.output_text).not.toContain("Want me to run it again?");
    expect(res.parsed).toBeNull();
    expect(res.parse_ok).toBe(false);
  });

  it("ships a short answer whose every number traces to a successful fetch, with a quick-answer suffix (a3f12c6a)", async () => {
    const quick =
      "A used 2022 Tesla Model 3 currently averages about $23,500 in the US, down 12% year-over-year.";
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({
      parse_ok: false, parsed: null, output_text: quick, raw_response_text: quick,
      tool_calls: [
        { name: "web_fetch__fetch", status: "ok", input_preview: "https://caredge.com/tesla/model-3/price",
          output_preview: "CarEdge: average used 2022 Model 3 listing is $23,500, a 12% decline year-over-year.", ms: 5 },
      ],
    });
    const res = await researchDispatcher(ctx, { ask: "used model 3 price?" });
    expect(res.output_text).toContain("$23,500");
    expect(res.output_text).toContain("Quick answer from live sources");
    expect(res.output_text).not.toContain("Want me to run it again?");
  });

  it("keeps the stub when a short answer's numbers do NOT appear in fetched text (ungrounded)", async () => {
    const ungrounded = "Turo's blended take rate is 38% and Getaround had 2.6M users.";
    (runGeneric as ReturnType<typeof vi.fn>).mockResolvedValue({
      parse_ok: false, parsed: null, output_text: ungrounded, raw_response_text: ungrounded,
      tool_calls: [
        { name: "web_fetch__fetch", status: "ok", input_preview: "https://a.com",
          output_preview: "Turo charges hosts a commission that varies by protection plan.", ms: 5 },
      ],
    });
    const res = await researchDispatcher(ctx, { ask: "q" });
    expect(res.output_text).not.toContain("38%");
    expect(res.output_text).toContain("verified, cited analysis");
  });

  it("salvage helper: refuses to salvage stat-bearing refusals, envelope junk, failed fetches, numberless prose", () => {
    expect(
      salvageRawResearchOutput("I can't verify this, but Turo's take rate is 38% and GMV is $1.2B.", []),
    ).toBeNull();
    expect(
      salvageRawResearchOutput('<research_report>{"kind":"report", broken', []),
    ).toBeNull();
    expect(
      salvageRawResearchOutput("The average price is $23,500.", [
        { name: "web_fetch__fetch", status: "tool_error", output_preview: "price $23,500" },
      ]),
    ).toBeNull();
    expect(
      salvageRawResearchOutput("CarEdge is generally considered a reputable source.", [
        { name: "web_search__search", status: "ok", output_preview: "CarEdge reviews..." },
      ]),
    ).toBeNull();
    const r = salvageRawResearchOutput(
      "I won't do that — hard stop. 1. Rotate the key within 24 hours. 2. Audit access.", [],
    );
    expect(r?.kind).toBe("refusal");
  });
});

const ZERO_IMAGE_CALL = {
  name: "mcp__server__report__generate_image",
  status: "ok" as const,
  ms: 0,
  input_preview: "",
  output_preview:
    '[{"type":"text","text":"{\\"images\\":[],\\"generated\\":0,' +
    '\\"skipped\\":[{\\"index\\":0,\\"reason\\":\\"generation_failed\\",' +
    '\\"detail\\":\\"submit 403: not_enough_credits\\"}]}"}]',
};
const PLAIN_TOOL = {
  name: "ToolSearch",
  status: "ok" as const,
  ms: 0,
  input_preview: "",
  output_preview: '[{"type":"tool_reference","tool_name":"x"}]',
};

describe("research salvage — an accurate failure report must not be overwritten", () => {
  const HONEST = "No image was produced. The image generation account is out of credits (`not_enough_credits`). Once credits are topped up, just ask again.";

  it("tells the user the real cause when the trace corroborates a zero-output tool", () => {
    const out = salvageRawResearchOutput(HONEST, [PLAIN_TOOL, ZERO_IMAGE_CALL]);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("tool_failure");
    expect(out!.text).toMatch(/No image was produced/);
    expect(out!.text).toMatch(/on our side/);
    expect(out!.text).not.toMatch(/not_enough_credits/);
    expect(out!.text).not.toMatch(/403|submit/);
    expect(out!.text).not.toMatch(/credits/i);
  });

  it("refuses to salvage on prose alone — the model cannot talk past B2", () => {
    const out = salvageRawResearchOutput(HONEST, [PLAIN_TOOL]);
    expect(out).toBeNull();
  });

  it("still protects unverified research numbers even with a failed tool", () => {
    const withStats =
      "The image generation failed, but the market is worth $4.2 billion and grew 37% last year.";
    expect(salvageRawResearchOutput(withStats, [ZERO_IMAGE_CALL])).toBeNull();
  });

  it("ignores a structured-junk envelope attempt", () => {
    const junk = "<research_report>out of credits</research_report>";
    expect(salvageRawResearchOutput(junk, [ZERO_IMAGE_CALL])).toBeNull();
  });

  it("does not hijack ordinary research prose that mentions nothing failing", () => {
    const ordinary = "Here is a summary of the competitive landscape for used-car marketplaces.";
    expect(salvageRawResearchOutput(ordinary, [ZERO_IMAGE_CALL])).toBeNull();
  });
});

describe("tool-failure salvage — the three holes codex found", () => {
  const ESCAPED_NON_MARKER = {
    name: "mcp__server__report__generate_image",
    status: "ok" as const,
    ms: 0,
    input_preview: "",
    output_preview:
      '[{"type":"text","text":"{\\"images\\":[],\\"generated\\":0,' +
      '\\"skipped\\":[{\\"reason\\":\\"generation_failed\\",\\"detail\\":\\"submit 500: vendor_error\\"}]}"}]',
  };

  it("salvages when the payload is escaped and the detail is not a marker word", () => {
    const honest = "No image was produced. The image tool failed.";
    const out = salvageRawResearchOutput(honest, [ESCAPED_NON_MARKER]);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("tool_failure");
    expect(out!.text).toMatch(/No image was produced/);
    expect(out!.text).not.toMatch(/vendor_error|500|submit/);
  });

  it("emits a synthesized notice, never the model's paragraph", () => {
    const smuggle =
      "No image was produced. I couldn't generate the chart, but Acme is the " +
      "category leader and its margins are weak.";
    const out = salvageRawResearchOutput(smuggle, [ESCAPED_NON_MARKER]);
    expect(out).not.toBeNull();
    expect(out!.text).not.toMatch(/Acme/);
    expect(out!.text).not.toMatch(/category leader/);
    expect(out!.text).not.toMatch(/margins/);
    expect(out!.text).toMatch(/No image was produced/);
  });

  it("does NOT let an unrelated tool error ship ungrounded research", () => {
    const mixed =
      "I couldn't generate the full report because one source failed, but Acme " +
      "is the category leader and its margins are weak.";
    const failedFetch = {
      name: "web_fetch",
      status: "tool_error" as const,
      ms: 0,
      input_preview: "",
      output_preview: "connection reset",
    };
    expect(salvageRawResearchOutput(mixed, [failedFetch])).toBeNull();
  });

  it("does NOT trip on a doc page that merely quotes the payload shape", () => {
    const docFetch = {
      name: "web_fetch",
      status: "ok" as const,
      ms: 0,
      input_preview: "",
      output_preview: 'example response: {"generated":0,"skipped":[{"reason":"not_applicable"}]}',
    };
    const honest = "No image was produced. The image tool failed.";
    expect(salvageRawResearchOutput(honest, [docFetch])).toBeNull();
  });
});
