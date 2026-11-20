import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcMock, deliverCsvMock, materializeMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(async () => ({ error: null })),
  deliverCsvMock: vi.fn(async () => {}),
  materializeMock: vi.fn(async () => {}),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: rpcMock,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  }),
}));
vi.mock("@/services/reports/deliver-csv", () => ({ deliverCsv: deliverCsvMock }));
vi.mock("../materialize", () => ({ materializeInvestors: materializeMock }));

import { fundraisingPostProcess } from "../post-run";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

function ctx(o: Partial<AgentContext> = {}): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: "11111111-1111-1111-1111-111111111111",
    trigger: "chat",
    agent: { slug: "fundraising", metadata_praxis: {} },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    ...o,
  } as unknown as AgentContext;
}

function result(parsed: unknown): DispatcherResult {
  return {
    output_text: "advisor note",
    parsed: JSON.parse(JSON.stringify(parsed)),
    parse_ok: true,
    raw_response_text: "",
    prompt_snapshot: "",
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as DispatcherResult;
}

beforeEach(() => {
  rpcMock.mockClear();
  deliverCsvMock.mockClear();
  materializeMock.mockClear();
});

describe("advise mode post-run (Slice 3)", () => {
  it("readiness run whose brain lacks revenue → persists an honest-gap snapshot, no number (invariants a + persist)", async () => {
    const r = result({
      investors: [],
      mode: "advise",
      advice: {
        topic: "readiness",
        readiness: [
          {
            key: "revenue",
            status: "gap",
            verdict:
              "No MRR in the brain. When an investor asks, give the real number out loud or say you're pre-revenue.",
            basis: "brain",
            source_ref: "brain: no revenue metric found",
          },
          {
            key: "retention",
            status: "good",
            verdict: "Strong month-2 retention.",
            basis: "brain",
            source_ref: "brain: cohort note",
          },
        ],
      },
      rendered_markdown: "## Readiness\n\nRevenue is an honest gap.",
    });

    await fundraisingPostProcess(ctx(), r);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [fn, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(fn).toBe("fundraising_set_raise_snapshot");
    expect(args.p_tenant_id).toBe("73db45ff-457e-4541-bc8f-bdb625390204");
    expect(args.p_run_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(args.p_round_design).toBeNull();
    const dims = args.p_readiness.dimensions as Array<Record<string, unknown>>;
    const rev = dims.find((d) => d.key === "revenue")!;
    expect(rev.status).toBe("gap");
    expect(String(rev.verdict)).not.toMatch(/\$\s?\d|\d+\s?(k|m|arr|mrr)\b/i);

    expect(deliverCsvMock).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();

    expect((r.parsed as any).advice.topic).toBe("readiness");
    expect((r.parsed as any).investors).toEqual([]);
    expect((r.parsed as any).gated).toBe(true);
  });

  it("round_design run → persists round_design snapshot, readiness NULL (coalesce-preserve)", async () => {
    const r = result({
      investors: [],
      mode: "advise",
      advice: {
        topic: "round_design",
        round_design: {
          ask: "$750k",
          verdict: "Raise a pre-seed to 18 months of runway.",
          basis: "playbook",
          source_ref: "",
        },
      },
      rendered_markdown: "## Round design",
    });

    await fundraisingPostProcess(ctx(), r);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [fn, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(fn).toBe("fundraising_set_raise_snapshot");
    expect(args.p_readiness).toBeNull();
    expect(args.p_round_design.ask).toBe("$750k");
    expect(deliverCsvMock).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("meeting_prep run → NO snapshot persist (per-moment coaching), still no CSV/materialize", async () => {
    const r = result({
      investors: [],
      mode: "advise",
      advice: {
        topic: "meeting_prep",
        meeting_prep: {
          partner: "Uncork",
          thesis: "Early marketplace thesis.",
          objections: [
            { key: "gmv", verdict: "Answer GMV straight.", basis: "playbook", source_ref: "" },
          ],
          questions: ["What's your ownership target?"],
        },
      },
      rendered_markdown: "## Meeting prep",
    });

    await fundraisingPostProcess(ctx(), r);

    expect(rpcMock).not.toHaveBeenCalled();
    expect(deliverCsvMock).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
    expect((r.parsed as any).advice.topic).toBe("meeting_prep");
  });

  it("topic OMITTED + payload.advice_topic=readiness → snapshot still persists", async () => {
    const r = result({
      investors: [],
      mode: "advise",
      advice: {
        readiness: [
          {
            key: "provenance",
            status: "gap",
            verdict: "Stripe Connect is not wired live, so there is no verifiable revenue.",
            basis: "brain",
            source_ref: "brain: fundraising readiness gate",
          },
        ],
      },
      rendered_markdown: "## Readiness\n\nNot yet.",
    });

    await fundraisingPostProcess(ctx(), r, { advice_topic: "readiness" });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [fn, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(fn).toBe("fundraising_set_raise_snapshot");
    expect(args.p_readiness).not.toBeNull();
    expect(args.p_round_design).toBeNull();
    expect((r.parsed as any).advice.topic).toBe("readiness");
  });

  it("topic omitted AND no payload topic → inferred from the single block present", async () => {
    const r = result({
      investors: [],
      mode: "advise",
      advice: {
        round_design: {
          ask: "$750k",
          cap: "$8M",
          verdict: "Raise enough for 18 months.",
          basis: "playbook",
          source_ref: "",
        },
      },
      rendered_markdown: "## Round",
    });

    await fundraisingPostProcess(ctx(), r, {});

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [, args] = rpcMock.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(args.p_round_design).not.toBeNull();
    expect(args.p_readiness).toBeNull();
  });

  it("payload topic DISAGREES with the block present → persists NOTHING, no label", async () => {
    const r = result({
      investors: [],
      mode: "advise",
      advice: {
        round_design: {
          ask: "$750k",
          cap: "$8M",
          verdict: "Raise enough for 18 months.",
          basis: "playbook",
          source_ref: "",
        },
      },
      rendered_markdown: "## Round",
    });

    await fundraisingPostProcess(ctx(), r, { advice_topic: "readiness" });

    expect(rpcMock).not.toHaveBeenCalled();
    expect((r.parsed as any).advice.topic).toBeUndefined();
  });

  it("garbage payload topic → persists nothing, never defaults to readiness", async () => {
    const r = result({
      investors: [],
      mode: "advise",
      advice: {
        meeting_prep: { partner: "Uncork", thesis: "Marketplaces." },
      },
      rendered_markdown: "## Prep",
    });

    await fundraisingPostProcess(ctx(), r, { advice_topic: "not-a-real-topic" });

    expect(rpcMock).not.toHaveBeenCalled();
    expect((r.parsed as any).advice.topic).not.toBe("readiness");
  });

  it("ambiguous envelope (two blocks filled) → persists nothing", async () => {
    const r = result({
      investors: [],
      mode: "advise",
      advice: {
        readiness: [
          { key: "revenue", status: "gap", verdict: "No MRR.", basis: "brain", source_ref: "x" },
        ],
        round_design: {
          ask: "$750k",
          cap: "$8M",
          verdict: "Raise 18 months.",
          basis: "playbook",
          source_ref: "",
        },
      },
      rendered_markdown: "## Both",
    });

    await fundraisingPostProcess(ctx(), r, { advice_topic: "readiness" });

    expect(rpcMock).not.toHaveBeenCalled();
  });
});
