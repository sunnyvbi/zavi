
import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcMock, deliverCsvMock, materializeMock, capturedTextMock, configBlob } =
  vi.hoisted(() => ({
    rpcMock: vi.fn(async () => ({ error: null })),
    deliverCsvMock: vi.fn(async () => {}),
    materializeMock: vi.fn(
      async (): Promise<{ added: number; already_saved: number } | null> => null,
    ),
    capturedTextMock: vi.fn((_url: string): string | null => null),
    configBlob: { value: {} as Record<string, unknown> },
  }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: rpcMock,
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { blob: configBlob.value },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/services/reports/deliver-csv", () => ({ deliverCsv: deliverCsvMock }));
vi.mock("@/services/agents/engine/capture-ledger", () => ({
  getCapturedText: (_runId: string, url: string) => capturedTextMock(url),
}));
vi.mock("../materialize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../materialize")>();
  return { ...actual, materializeInvestors: materializeMock };
});

import { fundraisingPostProcess, __test__ } from "../post-run";
import type { FundraisingInvestor } from "../output-schema";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

const { groundAndDedupInvestors } = __test__;

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

const PAGE_URL = "https://riverstone.vc/team";
const PAGE =
  "<untrusted_web_content>\nRiverstone Ventures backs seed-stage marketplaces. " +
  "The fund invests at seed and leads rounds across mobility.\n</untrusted_web_content>";

function pageText(url: string): string | null {
  return url === PAGE_URL ? PAGE : null;
}

function webRow(over: Partial<FundraisingInvestor>): FundraisingInvestor {
  return {
    firm: "Riverstone Ventures",
    name: "",
    tier: 1,
    focus: "",
    stage_focus: "",
    check_size: "",
    fit_rationale: "fits",
    contact_hint: "",
    suggested_message: "",
    source: "web",
    source_url: PAGE_URL,
    evidence_text: "Riverstone Ventures backs seed-stage marketplaces",
    evidence_span:
      "Riverstone Ventures backs seed-stage marketplaces. The fund invests at seed and leads rounds across mobility.",
    source_kind: "investor_directory",
    ...over,
  } as FundraisingInvestor;
}

function ctx(): AgentContext {
  return {
    tenant_id: TENANT,
    runId: "11111111-1111-1111-1111-111111111111",
    trigger: "chat",
    agent: { slug: "fundraising", metadata_praxis: {} },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
  } as unknown as AgentContext;
}

function result(parsed: unknown): DispatcherResult {
  return {
    output_text: "list",
    parsed: JSON.parse(JSON.stringify(parsed)),
    parse_ok: true,
    raw_response_text: "",
    prompt_snapshot: "",
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as DispatcherResult;
}

type Merge = { added: number; already_saved: number; dropped: string[] };
function mergeOf(r: DispatcherResult): Merge | undefined {
  return (r.parsed as { merge?: Merge }).merge;
}

beforeEach(() => {
  rpcMock.mockClear();
  deliverCsvMock.mockClear();
  materializeMock.mockClear();
  materializeMock.mockResolvedValue(null);
  capturedTextMock.mockImplementation(pageText);
  configBlob.value = { fundraising_pipeline: true };
});

describe("grounding gate — the dropped list", () => {
  it("emits exactly one line per dropped row, with the firm and the real reason", () => {
    const rows = [
      webRow({}),
      webRow({ firm: "Ghost Capital", source_url: "https://ghost.example/team" }),
      webRow({
        firm: "Phantom Partners",
        source: "investor_db",
        source_url: "https://phantom.example/team",
      }),
    ];

    const gate = groundAndDedupInvestors(rows, pageText, () => false);

    expect(gate.kept).toHaveLength(1);
    expect(gate.dropped).toHaveLength(gate.webDropped + gate.provenanceDropped);
    expect(gate.dropped).toHaveLength(2);
    expect(gate.dropped[0]).toContain("Ghost Capital");
    expect(gate.dropped[0]).toMatch(/couldn't confirm it on a page/i);
    expect(gate.dropped[1]).toContain("Phantom Partners");
    expect(gate.dropped[1]).toMatch(/investor database/i);
  });

  it("a clean run drops nothing and says so with an empty list, not a missing one", () => {
    const gate = groundAndDedupInvestors([webRow({})], pageText, () => false);
    expect(gate.kept).toHaveLength(1);
    expect(gate.dropped).toEqual([]);
  });

  it("never names the partner on a dropped firm row — that name is exactly what could not be verified", () => {
    const gate = groundAndDedupInvestors(
      [
        webRow({
          firm: "Ghost Capital",
          name: "Jane Doe",
          source_url: "https://ghost.example/team",
        }),
      ],
      pageText,
      () => false,
    );
    expect(gate.dropped).toHaveLength(1);
    expect(gate.dropped[0]).not.toContain("Jane Doe");
    expect(gate.dropped[0]).toContain("Ghost Capital");
  });

  it("falls back to the person's name for an angel row, which has no firm to name", () => {
    const gate = groundAndDedupInvestors(
      [
        webRow({
          firm: "",
          name: "Hunter Walk",
          source_url: "https://unfetched.example/x",
        }),
      ],
      pageText,
      () => false,
    );
    expect(gate.dropped).toHaveLength(1);
    expect(gate.dropped[0]).toContain("Hunter Walk");
  });
});

describe("fundraising post-run — persisting the receipt", () => {
  it("a source run persists added / already_saved / dropped onto parsed.merge", async () => {
    materializeMock.mockResolvedValue({ added: 9, already_saved: 3 });
    const r = result({
      investors: [
        webRow({}),
        webRow({ firm: "Ghost Capital", source_url: "https://ghost.example/a" }),
        webRow({ firm: "Vapor Ventures", source_url: "https://vapor.example/b" }),
      ],
      rendered_markdown: "## Investors",
    });

    await fundraisingPostProcess(ctx(), r, undefined as never);

    expect(mergeOf(r)).toEqual({
      added: 9,
      already_saved: 3,
      dropped: [
        expect.stringContaining("Ghost Capital"),
        expect.stringContaining("Vapor Ventures"),
      ],
    });
  });

  it("added: 0 is PUBLISHED when nothing was new — silence would read as a broken query", async () => {
    materializeMock.mockResolvedValue({ added: 0, already_saved: 4 });
    const r = result({
      investors: [webRow({})],
      rendered_markdown: "## Investors",
    });

    await fundraisingPostProcess(ctx(), r, undefined as never);

    const merge = mergeOf(r);
    expect(merge).toBeDefined();
    expect(merge!.added).toBe(0);
    expect(merge!.already_saved).toBe(4);
    expect(merge!.dropped).toEqual([]);
  });

  it("OMITS merge entirely when the split is not determinable (baseline unreadable)", async () => {
    materializeMock.mockResolvedValue(null);
    const r = result({
      investors: [
        webRow({}),
        webRow({ firm: "Ghost Capital", source_url: "https://ghost.example/a" }),
      ],
      rendered_markdown: "## Investors",
    });

    await fundraisingPostProcess(ctx(), r, undefined as never);

    expect(mergeOf(r)).toBeUndefined();
  });

  it("OMITS merge when the durable pipeline is off (nothing was saved, so nothing can be 'already saved')", async () => {
    configBlob.value = { fundraising_pipeline: false };
    const r = result({
      investors: [webRow({})],
      rendered_markdown: "## Investors",
    });

    await fundraisingPostProcess(ctx(), r, undefined as never);

    expect(materializeMock).not.toHaveBeenCalled();
    expect(mergeOf(r)).toBeUndefined();
  });

  it("OMITS merge when materialize throws", async () => {
    materializeMock.mockRejectedValue(new Error("rpc down"));
    const r = result({
      investors: [webRow({})],
      rendered_markdown: "## Investors",
    });

    await fundraisingPostProcess(ctx(), r, undefined as never);

    expect(mergeOf(r)).toBeUndefined();
  });

  it("an ALL-DROPPED run still owes a receipt: 0 new, 0 already saved, every drop named", async () => {
    const r = result({
      investors: [
        webRow({ firm: "Ghost Capital", source_url: "https://ghost.example/a" }),
        webRow({ firm: "Vapor Ventures", source_url: "https://vapor.example/b" }),
      ],
      rendered_markdown: "## Investors\n\n- Ghost Capital\n- Vapor Ventures",
    });

    await fundraisingPostProcess(ctx(), r, undefined as never);

    const merge = mergeOf(r);
    expect(merge).toBeDefined();
    expect(merge!.added).toBe(0);
    expect(merge!.already_saved).toBe(0);
    expect(merge!.dropped).toHaveLength(2);
    expect((r.parsed as { investors: unknown[] }).investors).toEqual([]);
  });

  it("does not put investor content into a log-shaped field (C14): merge lives on parsed only", async () => {
    materializeMock.mockResolvedValue({ added: 1, already_saved: 0 });
    const r = result({
      investors: [
        webRow({}),
        webRow({ firm: "Ghost Capital", source_url: "https://ghost.example/a" }),
      ],
      rendered_markdown: "## Investors",
    });

    await fundraisingPostProcess(ctx(), r, undefined as never);

    expect(JSON.stringify(mergeOf(r))).toContain("Ghost Capital");
    expect(String(r.output_text)).not.toContain("Ghost Capital");
  });

  it("a strategy run never emits a merge receipt (it merges no list)", async () => {
    const r = result({
      investors: [webRow({})],
      mode: "strategy",
      rendered_markdown: "## Plan",
    });

    await fundraisingPostProcess(ctx(), r, undefined as never);

    expect(mergeOf(r)).toBeUndefined();
  });
});
