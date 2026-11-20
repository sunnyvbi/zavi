
import { describe, it, expect, vi, beforeEach } from "vitest";

const { rpcMock, deliverCsvMock, materializeMock, getCapturedTextMock } = vi.hoisted(
  () => ({
    rpcMock: vi.fn(async () => ({ error: null })),
    deliverCsvMock: vi.fn(async () => {}),
    materializeMock: vi.fn(async () => {}),
    getCapturedTextMock: vi.fn((_runId: string, _url: string): string | null => null),
  }),
);

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: rpcMock,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  }),
}));
vi.mock("@/services/reports/deliver-csv", () => ({ deliverCsv: deliverCsvMock }));
vi.mock("../materialize", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, materializeInvestors: materializeMock };
});
vi.mock("@/services/agents/engine/capture-ledger", () => ({
  getCapturedText: getCapturedTextMock,
}));

import { fundraisingPostProcess, __test__ } from "../post-run";
import {
  DEEP_NO_PERSON_REFUSAL,
  fundraisingEnvelopeSchema,
  deepDossierSchema,
} from "../output-schema";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

const { processDeepDossier, renderDeepDossierMarkdown } = __test__;

const RUN_ID = "11111111-1111-1111-1111-111111111111";

function ctx(o: Partial<AgentContext> = {}): AgentContext {
  return {
    tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
    runId: RUN_ID,
    trigger: "chat",
    agent: { slug: "fundraising", metadata_praxis: {} },
    memory: { company: "", ops: "", policies: "", disputes: "", support: "" },
    ...o,
  } as unknown as AgentContext;
}

function result(parsed: unknown): DispatcherResult {
  return {
    output_text: "model prose",
    parsed: JSON.parse(JSON.stringify(parsed)),
    parse_ok: true,
    raw_response_text: "",
    prompt_snapshot: "",
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as DispatcherResult;
}

const TEAM_URL = "https://riverstone.vc/team";
const TEAM_PAGE =
  "Riverstone Ventures backs seed-stage marketplaces. Partner Jane Smith led the " +
  "recent seed in an adjacent mobility company and writes $500k checks.";

function deepEnvelope(over: Record<string, unknown> = {}) {
  return {
    stage: "Pre-seed",
    mode: "deep",
    investors: [],
    deep: {
      firm: "Riverstone Ventures",
      name: "Jane Smith",
      identity_key: "riverstone|jane smith",
      who_they_are: "Led the recent seed in an adjacent mobility marketplace.",
      why_this_company: "She writes the check size this round needs at this stage.",
      how_to_reach: {
        warm_path: "A portfolio founder at the adjacent mobility company.",
        best_channel: "Warm intro",
        who_to_go_through: "The founder of that portfolio company.",
      },
      draft_message: "Jane, we run a live marketplace doing real volume. 15 minutes?",
      pushbacks: [
        {
          objection: "Marketplaces are hard to grow on both sides.",
          honest_answer: "Supply is already there; the constraint is demand, and here is the number.",
        },
      ],
      sources: [{ url: TEAM_URL, claim: "Names Jane Smith as a partner." }],
      ...((over.deep as Record<string, unknown>) ?? {}),
    },
    rendered_markdown: "model wrote this prose, which may still contain the draft",
    ...over,
  };
}

beforeEach(() => {
  rpcMock.mockClear();
  deliverCsvMock.mockClear();
  materializeMock.mockClear();
  getCapturedTextMock.mockReset();
  getCapturedTextMock.mockImplementation((_runId: string, url: string) =>
    url === TEAM_URL ? TEAM_PAGE : null,
  );
});

describe("deep mode — envelope parsing", () => {
  it("a deep run parses into the envelope with all six sections", () => {
    const parsed = fundraisingEnvelopeSchema.safeParse(deepEnvelope());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.mode).toBe("deep");
    const d = parsed.data.deep;
    expect(d).toBeDefined();
    expect(d?.who_they_are).toContain("adjacent mobility");
    expect(d?.why_this_company).toBeTruthy();
    expect(d?.how_to_reach?.warm_path).toBeTruthy();
    expect(d?.draft_message).toBeTruthy();
    expect(d?.pushbacks).toHaveLength(1);
    expect(d?.sources).toHaveLength(1);
  });

  it("defaults pushbacks + sources to empty arrays (a thin dossier still parses)", () => {
    const parsed = deepDossierSchema.safeParse({ firm: "Acme", name: "Jane Smith" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.pushbacks).toEqual([]);
    expect(parsed.data.sources).toEqual([]);
  });
});

describe("deep mode — the honesty rule (no draft to an unverified person)", () => {
  it("NO verified person → refusal, NO draft, name blanked", async () => {
    const env = deepEnvelope({
      deep: { name: "Ghostly McNotreal", identity_key: "riverstone|ghostly mcnotreal" },
    });
    const r = result(env);
    await fundraisingPostProcess(ctx(), r, {});

    const d = (r.parsed as { deep: Record<string, unknown> }).deep;
    expect(d.draft_message).toBe("");
    expect(d.no_draft_reason).toBe(DEEP_NO_PERSON_REFUSAL);
    expect(d.name).toBe("");

    expect(r.output_text).toContain(DEEP_NO_PERSON_REFUSAL);
    expect(r.output_text).not.toContain("15 minutes?");
    expect(
      (r.parsed as { rendered_markdown: string }).rendered_markdown,
    ).toContain(DEEP_NO_PERSON_REFUSAL);
  });

  it("NO sources survived → no person can verify → refusal", async () => {
    getCapturedTextMock.mockImplementation(() => null);
    const r = result(deepEnvelope());
    await fundraisingPostProcess(ctx(), r, {});

    const d = (r.parsed as { deep: Record<string, unknown> }).deep;
    expect(d.sources).toEqual([]);
    expect(d.draft_message).toBe("");
    expect(d.no_draft_reason).toBe(DEEP_NO_PERSON_REFUSAL);
  });

  it("a VERIFIED person keeps the draft", async () => {
    const r = result(deepEnvelope());
    await fundraisingPostProcess(ctx(), r, {});

    const d = (r.parsed as { deep: Record<string, unknown> }).deep;
    expect(d.name).toBe("Jane Smith");
    expect(d.draft_message).toContain("15 minutes?");
    expect(d.no_draft_reason).toBe("");
    expect(r.output_text).toContain("Draft first message");
  });

  it("a fabricated email in the dossier is stripped (stripFabricatedEmails stays applied)", async () => {
    const r = result(
      deepEnvelope({
        deep: {
          who_they_are: "Reach her at jane@riverstone.vc for a first call.",
        },
      }),
    );
    await fundraisingPostProcess(ctx(), r, {});
    const d = (r.parsed as { deep: Record<string, unknown> }).deep;
    expect(String(d.who_they_are)).not.toContain("jane@riverstone.vc");
  });

  it("a single-token or finance-word 'name' never counts as a verified person", () => {
    const base = () => ({
      firm: "Riverstone Ventures",
      name: "",
      who_they_are: "",
      why_this_company: "",
      draft_message: "hello",
      no_draft_reason: "",
      pushbacks: [],
      sources: [{ url: TEAM_URL, claim: "" }],
    });
    const getText = (u: string) => (u === TEAM_URL ? TEAM_PAGE : null);

    const single = { ...base(), name: "Riverstone" };
    expect(processDeepDossier(single as never, getText).personVerified).toBe(false);

    const finance = { ...base(), name: "Seed Round" };
    expect(processDeepDossier(finance as never, getText).personVerified).toBe(false);

    const real = { ...base(), name: "Jane Smith" };
    expect(processDeepDossier(real as never, getText).personVerified).toBe(true);
  });
});

describe("deep mode — grounding + no side effects", () => {
  it("drops a cited page the run never fetched, keeps the one it did", async () => {
    const r = result(
      deepEnvelope({
        deep: {
          sources: [
            { url: TEAM_URL, claim: "Names Jane Smith as a partner." },
            { url: "https://never-fetched.example/post", claim: "Invented claim." },
          ],
        },
      }),
    );
    await fundraisingPostProcess(ctx(), r, {});
    const d = (r.parsed as { deep: { sources: Array<{ url: string }> } }).deep;
    expect(d.sources).toHaveLength(1);
    expect(d.sources[0].url).toBe(TEAM_URL);
    expect(r.output_text).not.toContain("never-fetched.example");
  });

  it("emits NO CSV and does NOT materialize (deep is not source)", async () => {
    const r = result(deepEnvelope());
    await fundraisingPostProcess(ctx(), r, {});
    expect(deliverCsvMock).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect((r.parsed as { investors: unknown[] }).investors).toEqual([]);
    expect((r.parsed as { gated: boolean }).gated).toBe(true);
  });

  it("mode:deep with no deep block renders nothing and still exports nothing", async () => {
    const r = result({
      mode: "deep",
      investors: [],
      rendered_markdown: "nothing here",
    });
    await fundraisingPostProcess(ctx(), r, {});
    expect((r.parsed as { deep: unknown }).deep).toBeNull();
    expect(deliverCsvMock).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("renders the six contracted sections, in order", () => {
    const md = renderDeepDossierMarkdown({
      firm: "Riverstone Ventures",
      name: "Jane Smith",
      identity_key: "",
      who_they_are: "who",
      why_this_company: "why",
      how_to_reach: { warm_path: "warm", best_channel: "email", who_to_go_through: "x" },
      draft_message: "draft",
      no_draft_reason: "",
      pushbacks: [{ objection: "o", honest_answer: "a" }],
      sources: [{ url: "https://x.example", claim: "c" }],
    });
    const order = [
      "## Who they are",
      "## Why this company",
      "## How to reach them",
      "## Draft first message",
      "## What they'll push back on",
      "## Sources",
    ];
    let cursor = -1;
    for (const h of order) {
      const at = md.indexOf(h);
      expect(at, `missing/out-of-order section ${h}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });
});

describe("deep mode addition does not change source / strategy / advise parsing", () => {
  const SOURCE_ENVELOPE = {
    stage: "Pre-seed",
    stage_rationale: "Pre-revenue with a sharp wedge.",
    investors: [
      {
        firm: "Acme Ventures",
        name: "Jane Partner",
        tier: 1,
        focus: "B2B SaaS",
        stage_focus: "pre-seed",
        check_size: "$250k-$1M",
        fit_rationale: "Thesis is dev-infra at seed.",
        contact_hint: "acme.vc",
        suggested_message: "Short note.",
        source: "investor_db",
      },
    ],
    rendered_markdown: "tiered summary",
  };

  const STRATEGY_ENVELOPE = {
    mode: "strategy",
    investors: [
      {
        firm: "Acme Ventures",
        name: "Jane Partner",
        tier: 1,
        fit_rationale: "fits",
        channel_segment: "email-ready",
        copy_variants: {
          cold_email: { subject: "s", body: "b" },
          linkedin_dm: "dm",
        },
      },
    ],
    cadence: "Day 0 cold email; Day 5 follow-up.",
    rollout_plan: "Wave 1 then Wave 2.",
    rendered_markdown: "plan",
  };

  const ADVISE_ENVELOPE = {
    mode: "advise",
    investors: [],
    advice: {
      topic: "readiness",
      readiness: [
        { key: "revenue", status: "gap", verdict: "no MRR in brain", basis: "brain" },
      ],
      dos: ["pull the number"],
      donts: ["do not project"],
    },
    rendered_markdown: "advisor note",
  };

  for (const [label, envelope] of [
    ["source", SOURCE_ENVELOPE],
    ["strategy", STRATEGY_ENVELOPE],
    ["advise", ADVISE_ENVELOPE],
  ] as const) {
    it(`${label} envelope still parses, and carries NO deep block`, () => {
      const parsed = fundraisingEnvelopeSchema.safeParse(envelope);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.deep).toBeUndefined();
      expect(parsed.data.mode).toBe(
        (envelope as { mode?: string }).mode as never,
      );
    });
  }

  it("strategy still short-circuits to display-only (no CSV, no materialize)", async () => {
    const r = result(STRATEGY_ENVELOPE);
    await fundraisingPostProcess(ctx(), r, {});
    expect(deliverCsvMock).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
    expect((r.parsed as { gated: boolean }).gated).toBe(true);
  });

  it("advise still persists its snapshot via the RPC and skips CSV/materialize", async () => {
    const r = result(ADVISE_ENVELOPE);
    await fundraisingPostProcess(ctx(), r, {});
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(deliverCsvMock).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("source mode still runs the grounding gate + delivers a CSV", async () => {
    const r = result(SOURCE_ENVELOPE);
    await fundraisingPostProcess(ctx(), r, {});
    expect((r.parsed as { investors: unknown[] }).investors).toEqual([]);
    expect(r.output_text).toContain("No investors could be verified");
    expect(materializeMock).not.toHaveBeenCalled();
  });
});

describe("dispatched mode outranks the model's echo", () => {
  const SOURCE_SHAPED_DEEP_OUTPUT = {
    stage: "Seed",
    stage_rationale: "Single-firm deep dive plus alternatives found on the way.",
    investors: [
      {
        firm: "Nexus Venture Partners",
        name: "",
        tier: 3,
        fit_rationale: "Cross-border thesis, but no marketplace in the portfolio.",
        source: "web",
        source_url: "https://nexusvp.com/team",
        evidence_text: "Nexus Venture Partners",
      },
    ],
    rendered_markdown: "### Nexus Venture Partners — honest fit verdict: Tier 3",
  };

  const DEEP_PAYLOAD = {
    mode: "deep",
    deep: {
      firm: "Nexus Venture Partners",
      name: "",
      identity_key: "nexus venture|",
      source_url: "https://nexusvp.com/team",
    },
  };

  it("a deep-DISPATCHED run whose model omitted `mode` does NOT take the source path", async () => {
    const r = result(SOURCE_SHAPED_DEEP_OUTPUT);
    await fundraisingPostProcess(ctx({ trigger: "manual" }), r, DEEP_PAYLOAD);

    expect(deliverCsvMock).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
    expect((r.parsed as { deep?: unknown }).deep).toBeNull();
    expect((r.parsed as { investors: unknown[] }).investors).toEqual([]);
  });

  it("a genuinely source-dispatched run is unaffected", async () => {
    const r = result(SOURCE_SHAPED_DEEP_OUTPUT);
    await fundraisingPostProcess(ctx({ trigger: "manual" }), r, { mode: "source" });
    expect((r.parsed as { deep?: unknown }).deep).toBeUndefined();
  });

  it("a CLASSIFIER-guessed payload.mode never overrides the model's own envelope", async () => {
    const r = result({
      mode: "advise",
      investors: [],
      advice: {
        topic: "readiness",
        readiness: [
          { key: "revenue", status: "gap", verdict: "no MRR in brain", basis: "brain" },
        ],
      },
      rendered_markdown: "readiness read",
    });
    await fundraisingPostProcess(ctx(), r, { mode: "source" });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(deliverCsvMock).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
  });

  it("a classifier-guessed \"strategy\" does not hijack a source envelope either", async () => {
    const r = result({
      stage: "Pre-seed",
      stage_rationale: "Pre-revenue with a sharp wedge.",
      investors: [
        {
          firm: "Acme Ventures",
          name: "Jane Partner",
          tier: 1,
          fit_rationale: "Dev-infra thesis at seed.",
          source: "investor_db",
        },
      ],
      rendered_markdown: "list",
    });
    await fundraisingPostProcess(ctx(), r, { mode: "strategy" });
    expect(r.output_text).toContain("No investors could be verified");
  });

  it("no payload mode at all still falls back to the model's echo", async () => {
    const r = result(deepEnvelope());
    await fundraisingPostProcess(ctx(), r, {});
    expect((r.parsed as { deep?: unknown }).deep).toBeTruthy();
    expect(deliverCsvMock).not.toHaveBeenCalled();
  });

  it("a junk payload mode is ignored rather than obeyed", async () => {
    const r = result(deepEnvelope());
    await fundraisingPostProcess(ctx(), r, { mode: "../../etc/passwd" });
    expect((r.parsed as { deep?: unknown }).deep).toBeTruthy();
    expect(materializeMock).not.toHaveBeenCalled();
  });
});
