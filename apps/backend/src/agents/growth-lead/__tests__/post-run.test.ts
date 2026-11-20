
import { describe, it, expect, vi, beforeEach } from "vitest";

const { writeNoteMock, listNotesMock, setExistingPlanNote } = vi.hoisted(() => {
  const state: { rows: Array<{ id: string }> } = { rows: [] };
  return {
    writeNoteMock: vi.fn(),
    listNotesMock: vi.fn(async () => state.rows),
    setExistingPlanNote: (id: string | null) => {
      state.rows = id ? [{ id }] : [];
    },
  };
});
vi.mock("@/services/memory", () => ({
  writeNote: writeNoteMock,
  listNotes: listNotesMock,
}));

const { diagnoseFunnelMock, setStageFunnel } = vi.hoisted(() => {
  const state: { funnel: unknown; throws: boolean } = {
    funnel: {
      steps: [
        { event: "signup", count: 100, conversion_from_top: 1 },
        { event: "purchase", count: 10, conversion_from_top: 0.1 },
      ],
    },
    throws: false,
  };
  return {
    diagnoseFunnelMock: vi.fn(async () => {
      if (state.throws) throw new Error("operator_db_not_connected");
      return { diagnosis_source: "native_events", funnel: state.funnel };
    }),
    setStageFunnel: (preset: "leaky_loop" | "pre_loop" | "data_not_ready") => {
      state.throws = false;
      if (preset === "data_not_ready") {
        state.throws = true;
      } else if (preset === "pre_loop") {
        state.funnel = {
          steps: [
            { event: "signup", count: 100, conversion_from_top: 1 },
            { event: "purchase", count: 0, conversion_from_top: 0 },
          ],
        };
      } else {
        state.funnel = {
          steps: [
            { event: "signup", count: 100, conversion_from_top: 1 },
            { event: "purchase", count: 10, conversion_from_top: 0.1 },
          ],
        };
      }
    },
  };
});
vi.mock("@/services/tools/growth/diagnose_funnel", () => ({
  diagnoseFunnelTool: { execute: diagnoseFunnelMock },
}));

const { serviceClientMock, setExistingDecisions, setConnectorRows } = vi.hoisted(() => {
  const state: {
    rows: Array<{ decision_class: string; body: unknown; status?: string }>;
    connectorRows: Array<{ slug: string }>;
    lastTable: string | null;
    inSlugs: string[] | null;
  } = { rows: [], connectorRows: [], lastTable: null, inSlugs: null };
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gte", "lte", "order", "limit"]) {
    builder[m] = () => builder;
  }
  builder.from = (table: string) => {
    state.lastTable = table;
    state.inSlugs = null;
    return builder;
  };
  builder.in = (col: string, vals: string[]) => {
    if (state.lastTable === "connector_metadata" && col === "slug") state.inSlugs = vals;
    return builder;
  };
  builder.then = (onFulfilled: (v: { data: unknown; error: null }) => unknown) =>
    onFulfilled({
      data: state.lastTable === "connector_metadata"
        ? state.connectorRows.filter((r) => !state.inSlugs || state.inSlugs.includes(r.slug))
        : state.rows,
      error: null,
    });
  return {
    serviceClientMock: vi.fn(() => builder),
    setExistingDecisions: (
      rows: Array<{ decision_class: string; body: unknown; status?: string }>,
    ) => {
      state.rows = rows.map((r) => ({ status: "proposed", ...r }));
    },
    setConnectorRows: (rows: Array<{ slug: string }>) => {
      state.connectorRows = rows;
    },
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));

const { getBoolSettingMock } = vi.hoisted(() => ({
  getBoolSettingMock: vi.fn(async () => true),
}));
vi.mock("@/services/settings", () => ({ getBoolSetting: getBoolSettingMock }));

const { getVisibleAgentSlugsMock, setVisibleFleet, setVisibleFleetThrows } =
  vi.hoisted(() => {
    const state: { slugs: string[]; throws: boolean } = {
      slugs: ["growth-lead", "performance-marketer", "pm", "engineer", "operator"],
      throws: false,
    };
    return {
      getVisibleAgentSlugsMock: vi.fn(async () => {
        if (state.throws) throw new Error("visibility read failed");
        return new Set(state.slugs);
      }),
      setVisibleFleet: (slugs: string[]) => {
        state.slugs = slugs;
        state.throws = false;
      },
      setVisibleFleetThrows: () => {
        state.throws = true;
      },
    };
  });
vi.mock("@/services/agents/visibility", () => ({
  getVisibleAgentSlugs: getVisibleAgentSlugsMock,
}));

import { growthOrchestratorPostProcess } from "../post-run";
import type { PostProcessorFn } from "@/agents/index";

const FANIN_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_UUID = "22222222-2222-4222-8222-222222222222";

function makeCtx() {
  const emitDecision = vi.fn(async (_c: string, _b: unknown) => "dec-1");
  const ctx = {
    tenant_id: "t-1",
    runId: "r-1",
    trigger: "cron",
    emitDecision,
  } as unknown as Parameters<PostProcessorFn>[0];
  return { ctx, emitDecision };
}

const CLEAN_PROSE =
  "Top move: ship the activation fix — it's the bottleneck. See approvals for the bets.";

function makeResult(md: string) {
  return {
    parse_ok: true,
    parsed: { rendered_markdown: CLEAN_PROSE, machine_digest: md },
  } as unknown as Parameters<PostProcessorFn>[1];
}

function makeLegacyResult(md: string) {
  return {
    parse_ok: true,
    parsed: { rendered_markdown: md },
  } as unknown as Parameters<PostProcessorFn>[1];
}

const digest = (tier1: string) =>
  `## Funnel diagnosis\nactivation\n\n## Tier 1\n${tier1}\n\n## Tier 2\nx`;

function bet(opts: {
  signals: string[];
  amount?: string;
  confidence?: string;
  lever?: string;
  suggestedDispatch?: string;
  betClaim?: string;
  draft?: string;
}) {
  const lines = [
    `Bet: ${opts.betClaim ?? "shift spend"}`,
    ...(opts.lever ? [`Lever: ${opts.lever}`] : []),
    `From → To: meta → google`,
    `Amount: ${opts.amount ?? "$40/wk"}`,
    `Source signals:`,
    ...opts.signals.map((s) => `  - ${s}`),
    `Confidence: ${opts.confidence ?? "high"}`,
    `Rationale: because the diagnosis says so.`,
    ...(opts.draft ? [`Draft:`, opts.draft] : []),
    ...(opts.suggestedDispatch ? [`Suggested dispatch: ${opts.suggestedDispatch}`] : []),
  ];
  return lines.join("\n");
}

beforeEach(() => {
  writeNoteMock.mockReset();
  writeNoteMock.mockResolvedValue(undefined);
  setExistingDecisions([]);
  setConnectorRows([]);
  getVisibleAgentSlugsMock.mockClear();
  setVisibleFleet(["growth-lead", "performance-marketer", "pm", "engineer", "operator"]);
  listNotesMock.mockClear();
  setExistingPlanNote(null);
  diagnoseFunnelMock.mockClear();
  setStageFunnel("leaky_loop");
});

function planNoteCall() {
  return writeNoteMock.mock.calls
    .map((c) => c[1] as {
      id?: string;
      note_type: string;
      tags?: string[];
      body_markdown: string;
      metadata?: { kind?: string; plan?: unknown };
    })
    .find((n) => n.tags?.includes("current-growth-plan"));
}

function writeNoteCalls() {
  return writeNoteMock.mock.calls.map((c) => c[1] as {
    note_type: string;
    tags?: string[];
    body_markdown: string;
  });
}

describe("growthOrchestratorPostProcess — Phase 1", () => {
  it("valid budget bet → 1 reallocate-budget decision", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [
              `{tool: 'growth__diagnose_funnel', signal: 'activation'}`,
            ],
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
    expect(emitDecision.mock.calls[0][0]).toBe("growth-lead.reallocate-budget");
  });

  it("tool-only bet with no fan-in set → accepted (zero-notes path)", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`],
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
  });

  it("note signal NOT in fan-in set → rejected; attribution snapshot still written with skip reason", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [
              `{agent: 'x', note_id: '${OTHER_UUID}', signal: 'y'}`,
            ],
          }),
        ),
      ),
      { fan_in_note_ids: [FANIN_UUID] },
    );
    expect(emitDecision).not.toHaveBeenCalled();
    const snapshot = writeNoteCalls().find(
      (n) => n.note_type === "growth_attribution_snapshot",
    );
    expect(snapshot).toBeDefined();
    expect(snapshot!.body_markdown).toMatch(/fan-in set/i);
  });

  it("note signal IN fan-in set → accepted; cross_bet tags include source-agent:pm", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [
              `{agent: 'pm', note_id: '${FANIN_UUID}', signal: 'cac'}`,
            ],
          }),
        ),
      ),
      { fan_in_note_ids: [FANIN_UUID] },
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
    const crossBet = writeNoteCalls().find(
      (n) => n.note_type === "growth_cross_bet",
    );
    expect(crossBet).toBeDefined();
    expect(crossBet!.tags).toContain("source-agent:pm");
  });

  it("mixed {agent,note_id}+{tool} provenance → rejected", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [
              `{agent: 'x', note_id: '${FANIN_UUID}', tool: 'growth__read_cohort', signal: 'z'}`,
            ],
          }),
        ),
      ),
      { fan_in_note_ids: [FANIN_UUID] },
    );
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("competitor_delta citation → rejected (unknown growth tool)", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [
              `{tool: 'growth__competitor_delta', signal: 'q'}`,
            ],
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("memory signal → accepted + source-memory tag; signal not routed into lever_signal", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [
              `{memory: 'company.live_issues', signal: 'verification_leak'}`,
            ],
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
    const crossBet = writeNoteCalls().find(
      (n) => n.note_type === "growth_cross_bet",
    );
    expect(crossBet).toBeDefined();
    expect(crossBet!.tags).toContain("source-memory:company.live_issues");
    const leverSignal = writeNoteCalls().find(
      (n) => n.note_type === "growth_lever_signal",
    );
    expect(leverSignal).toBeUndefined();
  });

  it("memory+tool mixed provenance → rejected", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [
              `{memory: 'x', tool: 'growth__read_cohort', signal: 'z'}`,
            ],
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("garbage Tier-1 block + 1 valid bet → partial recovery (exactly 1 decision)", async () => {
    const { ctx, emitDecision } = makeCtx();
    const garbage = [
      `Bet: malformed`,
      `From → To: meta → google`,
      `Source signals:`,
      `  - {tool: 'growth__diagnose_funnel', signal: 'a'}`,
      `Confidence: high`,
      `Rationale: no amount line.`,
    ].join("\n");
    const valid = bet({
      signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`],
    });
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(digest(`${garbage}\n\n${valid}`)),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
  });

  it("parse_failed envelope → no-op (no decision, no writeNote)", async () => {
    const { ctx, emitDecision } = makeCtx();
    const result = {
      parse_ok: false,
      parsed: null,
    } as unknown as Parameters<PostProcessorFn>[1];
    await growthOrchestratorPostProcess(ctx, result, {});
    expect(emitDecision).not.toHaveBeenCalled();
    expect(writeNoteMock).not.toHaveBeenCalled();
  });

  it("dedupe — bet matching an undecided pending decision is skipped", async () => {
    setExistingDecisions([
      {
        decision_class: "growth-lead.lifecycle-draft",
        body: { bet_claim: "shift spend", to_channel: "google" },
      },
    ]);
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({ lever: "lifecycle", draft: "email copy here", signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`] }),
        ),
      ),
      {},
    );
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("does not truncate a lifecycle Draft at an email 'From:' line", async () => {
    const { ctx, emitDecision } = makeCtx();
    const draftBody =
      "Subject: We miss you\nFrom: founder@acme.com\nHey {{first_name}}, here's 20% off to come back.\n— The team";
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            lever: "lifecycle",
            betClaim: "win-back email",
            amount: "qualitative",
            signals: [`{tool: 'growth__diagnose_funnel', signal: 'churn_spike'}`],
            draft: draftBody,
            suggestedDispatch: "founder",
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
    expect(emitDecision.mock.calls[0][0]).toBe("growth-lead.lifecycle-draft");
    const body = emitDecision.mock.calls[0][1] as { draft?: string };
    expect(body.draft).toContain("From: founder@acme.com");
    expect(body.draft).toContain("Hey {{first_name}}, here's 20% off");
    expect(body.draft).toContain("— The team");
  });

  it("dedupe — bet matching a recently acted decision is skipped", async () => {
    setExistingDecisions([
      {
        decision_class: "growth-lead.lifecycle-draft",
        body: { bet_claim: "shift spend", to_channel: "google" },
        status: "acted",
      },
    ]);
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({ lever: "lifecycle", draft: "email copy here", signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`] }),
        ),
      ),
      {},
    );
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("dedupe — bet matching a recently rejected decision is skipped", async () => {
    setExistingDecisions([
      {
        decision_class: "growth-lead.lifecycle-draft",
        body: { bet_claim: "shift spend", to_channel: "google" },
        status: "rejected",
      },
    ]);
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({ lever: "lifecycle", draft: "email copy here", signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`] }),
        ),
      ),
      {},
    );
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("cap — acted decisions do not count toward the pending cap", async () => {
    setExistingDecisions(
      Array.from({ length: 5 }, (_, i) => ({
        decision_class: "growth-lead.social-draft",
        body: { bet_claim: `done bet ${i}`, to_channel: `chan-${i}` },
        status: "acted",
      })),
    );
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({ lever: "lifecycle", draft: "email copy here", signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`] }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
  });

  it("cap — no new bet emitted once the per-tenant cap is already reached", async () => {
    setExistingDecisions(
      Array.from({ length: 5 }, (_, i) => ({
        decision_class: "growth-lead.social-draft",
        body: { bet_claim: `existing bet ${i}`, to_channel: `chan-${i}` },
      })),
    );
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({ lever: "social", draft: "post copy here", signals: [`{tool: 'growth__diagnose_funnel', signal: 'activation'}`] }),
        ),
      ),
      {},
    );
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("fresh bet under cap with no equivalent pending → still emitted", async () => {
    setExistingDecisions([
      { decision_class: "growth-lead.social-draft", body: { bet_claim: "unrelated", to_channel: "x" } },
    ]);
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({ lever: "lifecycle", draft: "email copy here", signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`] }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
  });
  it("prose lead before ## Funnel diagnosis → bet still emitted + funnel note still written", async () => {
    const { ctx, emitDecision } = makeCtx();
    const lead =
      "Ship the AI tutor paywall first — it's the one move that creates revenue with no reliability dependency. See Funnel diagnosis + Tier-1 bets below for the detail.\n\n";
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        lead +
          digest(
            bet({ signals: [`{tool: 'growth__diagnose_funnel', signal: 'activation'}`] }),
          ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
    const notes = writeNoteCalls().map((n) => n.note_type);
    expect(notes).toContain("growth_funnel_diagnosis");
  });

  it("machine_digest absent (legacy) → falls back to rendered_markdown; bet still emitted", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeLegacyResult(
        digest(
          bet({ signals: [`{tool: 'growth__diagnose_funnel', signal: 'activation'}`] }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
    const notes = writeNoteCalls().map((n) => n.note_type);
    expect(notes).toContain("growth_funnel_diagnosis");
  });

  it("machine_digest with no Tier-1 bets → no decision, no per-bet notes", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult("## Funnel diagnosis\nactivation\n\n## Tier 1\n(no bets this week)"),
      {},
    );
    expect(emitDecision).not.toHaveBeenCalled();
    const notes = writeNoteCalls().map((n) => n.note_type);
    expect(notes).not.toContain("growth_cross_bet");
    expect(notes).not.toContain("growth_lever_signal");
    expect(planNoteCall()).toBeDefined();
    expect(planNoteCall()!.note_type).toBe("growth_priorities");
  });

  it("funnel diagnosis is extracted from machine_digest (not rendered_markdown)", async () => {
    const { ctx } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({ signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`] }),
        ),
      ),
      {},
    );
    const funnel = writeNoteCalls().find(
      (n) => n.note_type === "growth_funnel_diagnosis",
    );
    expect(funnel).toBeDefined();
    expect(funnel!.body_markdown).toMatch(/activation/);
  });

  it("a formalized bet emits its decision AND writes the living plan note", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [
              `{tool: 'growth__diagnose_funnel', signal: 'activation'}`,
            ],
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalled();
    expect(planNoteCall()).toBeDefined();
    expect(planNoteCall()!.note_type).toBe("growth_priorities");
  });

  it("autopilot ON + chat trigger with a formalized bet → materializes (trigger-agnostic)", async () => {
    const emitDecision = vi.fn(async (_c: string, _b: unknown) => "dec-1");
    const chatCtx = {
      tenant_id: "t-1",
      runId: "r-chat-1",
      trigger: "chat",
      emitDecision,
    } as unknown as Parameters<PostProcessorFn>[0];
    await growthOrchestratorPostProcess(
      chatCtx,
      makeResult(
        digest(
          bet({
            signals: [
              `{tool: 'growth__diagnose_funnel', signal: 'activation'}`,
            ],
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
  });

  it("bet block with [P0] tag + trailing 'Do NOT:' guardrail still parses → 1 decision", async () => {
    const { ctx, emitDecision } = makeCtx();
    const decorated =
      bet({
        signals: [`{tool: 'growth__diagnose_funnel', signal: 'activation'}`],
      }).replace("Bet: shift spend", "Bet: [P0] shift spend") +
      "\nDo NOT: scale past $200/wk before payback confirms.";
    await growthOrchestratorPostProcess(ctx, makeResult(digest(decorated)), {});
    expect(emitDecision).toHaveBeenCalledTimes(1);
  });

  it("Suggested dispatch → real agent emits paired growth-lead.dispatch-specialist (post-approval only)", async () => {
    const emitDecision = vi.fn(async (cls: string, _b: unknown) =>
      cls === "growth-lead.dispatch-specialist" ? "disp-1" : "bet-1",
    );
    const ctx = {
      tenant_id: "t-1",
      runId: "r-1",
      trigger: "cron",
      emitDecision,
    } as unknown as Parameters<PostProcessorFn>[0];
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`],
            suggestedDispatch: "performance-marketer.weekly-plan   (founder triggers manually)",
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(2);
    const dispatchCall = emitDecision.mock.calls.find(
      (c) => c[0] === "growth-lead.dispatch-specialist",
    );
    expect(dispatchCall).toBeDefined();
    const body = dispatchCall![1] as Record<string, unknown>;
    expect(body.target_agent_slug).toBe("performance-marketer");
    expect(body.origin_decision_id).toBe("bet-1");
    expect(body.dispatched_by).toBe("growth-lead");
    expect(String(body.intent)).toMatch(/weekly-plan/);
  });

  it("dispatch is emit-only (proposed) — post-run never enqueues a specialist run", async () => {
    const emitDecision = vi.fn(async (_c: string, _b: unknown) => "id");
    const ctx = {
      tenant_id: "t-1",
      runId: "r-1",
      trigger: "cron",
      emitDecision,
      enqueueAgentRun: vi.fn(() => {
        throw new Error("post-run must NOT enqueue — approval is the boundary");
      }),
    } as unknown as Parameters<PostProcessorFn>[0];
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [`{tool: 'growth__diagnose_funnel', signal: 'activation'}`],
            suggestedDispatch: "engineer",
          }),
        ),
      ),
      {},
    );
    const classes = emitDecision.mock.calls.map((c) => c[0]);
    expect(classes).toContain("growth-lead.reallocate-budget");
    expect(classes).toContain("growth-lead.dispatch-specialist");
  });

  it("Suggested dispatch: growth-lead (self) → blocked, no dispatch decision", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`],
            suggestedDispatch: "growth-lead",
          }),
        ),
      ),
      {},
    );
    const classes = emitDecision.mock.calls.map((c) => c[0]);
    expect(classes).toContain("growth-lead.reallocate-budget");
    expect(classes).not.toContain("growth-lead.dispatch-specialist");
  });

  it("Suggested dispatch: operator → blocked, no dispatch decision", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`],
            suggestedDispatch: "operator",
          }),
        ),
      ),
      {},
    );
    const classes = emitDecision.mock.calls.map((c) => c[0]);
    expect(classes).not.toContain("growth-lead.dispatch-specialist");
  });

  it("Suggested dispatch: founder → no dispatch decision (advice-only bet)", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`],
            suggestedDispatch: "founder",
          }),
        ),
      ),
      {},
    );
    const classes = emitDecision.mock.calls.map((c) => c[0]);
    expect(classes).not.toContain("growth-lead.dispatch-specialist");
  });

  it("Suggested dispatch naming a non-visible agent → dropped, no dispatch decision", async () => {
    setVisibleFleet(["growth-lead", "pm", "operator"]);
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`],
            suggestedDispatch: "performance-marketer.weekly-plan",
          }),
        ),
      ),
      {},
    );
    const classes = emitDecision.mock.calls.map((c) => c[0]);
    expect(classes).toContain("growth-lead.reallocate-budget");
    expect(classes).not.toContain("growth-lead.dispatch-specialist");
  });

  it("visible-fleet lookup throws → bet still emitted, zero dispatch decisions", async () => {
    setVisibleFleetThrows();
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`],
            suggestedDispatch: "performance-marketer.weekly-plan",
          }),
        ),
      ),
      {},
    );
    const classes = emitDecision.mock.calls.map((c) => c[0]);
    expect(classes).toContain("growth-lead.reallocate-budget");
    expect(classes).not.toContain("growth-lead.dispatch-specialist");
  });

  it("no Suggested dispatch line → bet only, no dispatch decision", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({ signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`] }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
    expect(emitDecision.mock.calls[0][0]).toBe("growth-lead.reallocate-budget");
  });

  it("a suggested-dispatch bet emits its decisions", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`],
            suggestedDispatch: "performance-marketer.weekly-plan",
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalled();
  });
});

describe("growthOrchestratorPostProcess — Slice 2/3 (plan + stage-gate)", () => {
  it("I3 — scale-budget bet is DROPPED at stage=pre_loop", async () => {
    setStageFunnel("pre_loop");
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(bet({ signals: [`{tool: 'growth__diagnose_funnel', signal: 'a'}`] })),
      ),
      {},
    );
    expect(emitDecision).not.toHaveBeenCalled();
    const plan = planNoteCall()!.metadata!.plan as {
      now: { action: string } | null;
      next: unknown[];
    };
    expect(plan.now).toBeNull();
    expect(plan.next).toHaveLength(0);
  });

  it("I3 — scale-budget bet is DROPPED at stage=data_not_ready", async () => {
    setStageFunnel("data_not_ready");
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(bet({ signals: [`{tool: 'growth__diagnose_funnel', signal: 'a'}`] })),
      ),
      {},
    );
    expect(emitDecision).not.toHaveBeenCalled();
    const plan = planNoteCall()!.metadata!.plan as {
      stage: string;
      now: { exec: string } | null;
    };
    expect(plan.stage).toBe("data_not_ready");
    expect(plan.now!.exec).toBe("needs-connector");
  });

  it("data_not_ready + a connected growth-data source → 'too thin' message, NOT connect CTA", async () => {
    setStageFunnel("data_not_ready");
    setConnectorRows([{ slug: "operator_db" }]);
    const { ctx } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(bet({ signals: [`{tool: 'growth__diagnose_funnel', signal: 'a'}`] })),
      ),
      {},
    );
    const plan = planNoteCall()!.metadata!.plan as {
      stage: string;
      now: { action: string; exec: string } | null;
    };
    expect(plan.stage).toBe("data_not_ready");
    expect(plan.now!.exec).toBe("needs-data");
    expect(plan.now!.action).toMatch(/thin/i);
    expect(plan.now!.action).not.toMatch(/\/settings/);
    expect(plan.now!.action).not.toMatch(/connect your/i);
  });

  it("data_not_ready + only a native PostHog row → counted as connected ('too thin', not connect CTA)", async () => {
    setStageFunnel("data_not_ready");
    setConnectorRows([{ slug: "posthog" }]);
    const { ctx } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(digest(bet({ signals: [`{tool: 'growth__diagnose_funnel', signal: 'a'}`] }))),
      {},
    );
    const plan = planNoteCall()!.metadata!.plan as { now: { action: string; exec: string } | null };
    expect(plan.now!.exec).toBe("needs-data");
  });

  it("data_not_ready + NO connected growth-data source → connect CTA + needs-connector", async () => {
    setStageFunnel("data_not_ready");
    setConnectorRows([]);
    const { ctx } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(bet({ signals: [`{tool: 'growth__diagnose_funnel', signal: 'a'}`] })),
      ),
      {},
    );
    const plan = planNoteCall()!.metadata!.plan as {
      stage: string;
      now: { action: string; exec: string } | null;
    };
    expect(plan.stage).toBe("data_not_ready");
    expect(plan.now!.exec).toBe("needs-connector");
    expect(plan.now!.action).toMatch(/\/settings/);
  });

  it("I3 — the SAME scale-budget bet is KEPT at stage=leaky_loop → 1 decision", async () => {
    setStageFunnel("leaky_loop");
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(bet({ signals: [`{tool: 'growth__diagnose_funnel', signal: 'a'}`] })),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
  });

  it("I3 — at pre_loop, a budget bet is dropped but a lifecycle bet keeps flowing", async () => {
    setStageFunnel("pre_loop");
    const { ctx, emitDecision } = makeCtx();
    const two =
      bet({
        betClaim: "scale google spend",
        signals: [`{tool: 'growth__diagnose_funnel', signal: 'a'}`],
      }) +
      "\n\nBet: " +
      bet({
        betClaim: "win-back drip",
        lever: "lifecycle",
        draft: "Subject: come back\nWe miss you.",
        signals: [`{tool: 'growth__diagnose_funnel', signal: 'churn'}`],
      }).slice("Bet: ".length);
    await growthOrchestratorPostProcess(ctx, makeResult(digest(two)), {});
    expect(emitDecision).toHaveBeenCalledTimes(1);
    expect(emitDecision).toHaveBeenCalledWith(
      "growth-lead.lifecycle-draft",
      expect.anything(),
    );
  });

  it("I5 — consecutive runs UPDATE the one plan note in place (not a new row)", async () => {
    const d = digest(bet({ signals: [`{tool: 'growth__diagnose_funnel', signal: 'a'}`] }));

    const first = makeCtx();
    await growthOrchestratorPostProcess(first.ctx, makeResult(d), {});
    const created = planNoteCall();
    expect(created).toBeDefined();
    expect(created!.id).toBeUndefined();

    writeNoteMock.mockClear();
    setExistingPlanNote("plan-note-1");
    const second = makeCtx();
    await growthOrchestratorPostProcess(second.ctx, makeResult(d), {});
    const updated = planNoteCall();
    expect(updated).toBeDefined();
    expect(updated!.id).toBe("plan-note-1");
  });

  it("I6 — exec tags vary by bet/lever (yes / needs-connector / manual)", async () => {
    setStageFunnel("leaky_loop");
    const { ctx } = makeCtx();
    const yesBet = bet({
      betClaim: "scale google spend",
      amount: "$40/wk",
      signals: [`{tool: 'growth__read_ads_perf', signal: 'roas up'}`],
    });
    const connBet = bet({
      betClaim: "measure revenue per signup",
      amount: "$0/wk",
      signals: [`{tool: 'growth__diagnose_funnel', signal: 'stripe not connected'}`],
    });
    const manualBet = bet({
      betClaim: "reposition the hero narrative",
      lever: "social",
      amount: "qualitative",
      draft: "A founder-voice post about the mission.",
      signals: [`{tool: 'growth__diagnose_funnel', signal: 'narrative'}`],
    });
    const d = digest(`${yesBet}\n\nBet: ${connBet.slice("Bet: ".length)}\n\nBet: ${manualBet.slice("Bet: ".length)}`);
    await growthOrchestratorPostProcess(ctx, makeResult(d), {});
    const plan = planNoteCall()!.metadata!.plan as {
      now: { exec: string } | null;
      next: Array<{ exec: string }>;
    };
    const execs = [plan.now, ...plan.next].filter(Boolean).map((a) => a!.exec);
    expect(execs).toContain("yes");
    expect(execs).toContain("needs-connector");
    expect(execs).toContain("manual");
  });

  it("regression — valid budget bet at leaky_loop still emits 1 decision + growth_cross_bet", async () => {
    setStageFunnel("leaky_loop");
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(bet({ signals: [`{tool: 'growth__diagnose_funnel', signal: 'activation'}`] })),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
    expect(emitDecision).toHaveBeenCalledWith(
      "growth-lead.reallocate-budget",
      expect.anything(),
    );
    const crossBet = writeNoteCalls().find((n) => n.note_type === "growth_cross_bet");
    expect(crossBet).toBeDefined();
    expect(crossBet!.tags).toContain("lever:budget");
  });
});

describe("growth-lead agent.md — deliverable-structure invariants", () => {
  it("agent.md keeps the non-chat structure section + chat-stays-prose sentinel", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const md = fs.readFileSync(
      path.join(__dirname, "..", "agent.md"),
      "utf-8",
    );
    expect(md).toContain("## Deliverable structure (non-chat outputs only)");
    expect(md).toContain(
      "NEVER apply this structure to a chat-trigger conversational reply — chat answers stay prose",
    );
  });

  it("agent.md documents the P1-5 Draft requirement + P1-7 data-readiness lead", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const md = fs.readFileSync(path.join(__dirname, "..", "agent.md"), "utf-8");
    expect(md).toContain("Draft requirement (P1-5)");
    expect(md).toContain("DATA-READINESS LEAD (P1-7)");
    expect(md).toContain("POST /api/events/ingest");
  });

  it("agent.md worked example is valid JSON and its lifecycle bet has a Draft", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const md = fs.readFileSync(path.join(__dirname, "..", "agent.md"), "utf-8");
    const blocks = [...md.matchAll(/<digest>(\{[\s\S]*?\})<\/digest>/g)].map(
      (m) => m[1],
    );
    const real = blocks.find((b) => b.includes("Tier 1"));
    expect(real).toBeTruthy();
    const parsed = JSON.parse(real as string) as { machine_digest?: string };
    expect(typeof parsed.machine_digest).toBe("string");
    expect(parsed.machine_digest).toMatch(
      /Lever: lifecycle[\s\S]*?Draft:[\s\S]*?Suggested dispatch:/,
    );
  });
});

describe("growthOrchestratorPostProcess — P1-5 Draft on lifecycle/social", () => {
  it("lifecycle bet WITHOUT Draft → rejected (no decision emitted)", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            lever: "lifecycle",
            amount: "qualitative",
            signals: [`{tool: 'growth__diagnose_funnel', signal: 'churn'}`],
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("social bet WITHOUT Draft → rejected", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            lever: "social",
            amount: "qualitative",
            signals: [`{tool: 'growth__content_punchlist', signal: 'gap'}`],
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).not.toHaveBeenCalled();
  });

  it("lifecycle bet WITH Draft → accepted; draft stored in decision body + cross_bet note", async () => {
    const { ctx, emitDecision } = makeCtx();
    const draftCopy =
      "Subject: We miss you\n\nHey {{first_name}}, your trial lapsed — here's 20% off to come back.";
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            lever: "lifecycle",
            amount: "qualitative",
            signals: [`{tool: 'growth__diagnose_funnel', signal: 'churn'}`],
            draft: draftCopy,
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
    expect(emitDecision.mock.calls[0][0]).toBe("growth-lead.lifecycle-draft");
    const body = emitDecision.mock.calls[0][1] as { draft?: string };
    expect(body.draft).toContain("We miss you");
    expect(body.draft).toContain("20% off");
    const crossBet = writeNoteCalls().find((n) => n.note_type === "growth_cross_bet");
    expect(crossBet).toBeDefined();
    expect(crossBet?.body_markdown).toContain("### Draft");
    expect(crossBet?.body_markdown).toContain("We miss you");
  });

  it("budget bet WITHOUT Draft → still accepted; no draft in body", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(bet({ signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`] })),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
    expect(emitDecision.mock.calls[0][0]).toBe("growth-lead.reallocate-budget");
    const body = emitDecision.mock.calls[0][1] as { draft?: string };
    expect(body.draft).toBeUndefined();
  });

  it("budget bet WITH a stray Draft → accepted; draft ignored (not stored)", async () => {
    const { ctx, emitDecision } = makeCtx();
    await growthOrchestratorPostProcess(
      ctx,
      makeResult(
        digest(
          bet({
            signals: [`{tool: 'growth__read_ads_perf', signal: 'roas'}`],
            draft: "irrelevant copy",
          }),
        ),
      ),
      {},
    );
    expect(emitDecision).toHaveBeenCalledTimes(1);
    const body = emitDecision.mock.calls[0][1] as { draft?: string };
    expect(body.draft).toBeUndefined();
  });
});

describe("buildPublishPayload", () => {
  it("passes the whole draft as text for a non-reddit channel", async () => {
    const { buildPublishPayload } = await import("../post-run");
    expect(buildPublishPayload("linkedin", "hello world")).toEqual({
      text: "hello world",
    });
  });

  it("splits a reddit draft into subreddit / title / body", async () => {
    const { buildPublishPayload } = await import("../post-run");
    const draft = "Subreddit: SaaS\nTitle: How we cut churn 40%\n\nHere is the body.";
    expect(buildPublishPayload("reddit", draft)).toEqual({
      subreddit: "SaaS",
      title: "How we cut churn 40%",
      text: "Here is the body.",
    });
  });

  it("tolerates an r/ prefix the strict schema would reject", async () => {
    const { buildPublishPayload } = await import("../post-run");
    const draft = "Subreddit: r/SaaS\nTitle: t\n\nbody";
    expect(buildPublishPayload("reddit", draft)).toMatchObject({ subreddit: "SaaS" });
  });

  it("returns null when a reddit draft omits Subreddit", async () => {
    const { buildPublishPayload } = await import("../post-run");
    expect(buildPublishPayload("reddit", "Title: t\n\nbody")).toBeNull();
  });

  it("returns null when a reddit draft omits Title", async () => {
    const { buildPublishPayload } = await import("../post-run");
    expect(buildPublishPayload("reddit", "Subreddit: SaaS\n\nbody")).toBeNull();
  });

  it("returns null when a reddit draft has headers but no body", async () => {
    const { buildPublishPayload } = await import("../post-run");
    expect(buildPublishPayload("reddit", "Subreddit: SaaS\nTitle: t\n")).toBeNull();
  });
});
