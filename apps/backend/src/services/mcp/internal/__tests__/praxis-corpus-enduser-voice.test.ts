
import { describe, it, expect, vi, beforeEach } from "vitest";
import { callPraxisCorpusTool } from "../praxis-corpus";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

type Result = { data: unknown; error: unknown };

function mkBuilder(opts: {
  limit?: Result;
  maybeSingle?: Result;
  eqCalls: Array<[string, unknown]>;
}) {
  const b = {
    select: vi.fn(),
    eq: vi.fn(),
    gte: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(async () => opts.limit ?? ({ data: [], error: null } as Result)),
    maybeSingle: vi.fn(async () => opts.maybeSingle ?? ({ data: null, error: null } as Result)),
  };
  b.select.mockImplementation(() => b);
  b.eq.mockImplementation((col: string, val: unknown) => {
    opts.eqCalls.push([col, val]);
    return b;
  });
  b.gte.mockImplementation(() => b);
  b.order.mockImplementation(() => b);
  return b;
}

function mkSvc(tables: Record<string, ReturnType<typeof mkBuilder>>) {
  const svc = {
    from: vi.fn((table: string) => {
      const b = tables[table];
      if (!b) throw new Error(`unexpected table in test: ${table}`);
      return b;
    }),
  };
  mocks.serviceClientMock.mockReturnValue(svc);
  return svc;
}

const TENANT = "tenant-A";

const PII_EMAIL = "jane.doe@example.com";
const PII_PHONE = "+1-555-867-5309";
const PII_SSN = "123-45-6789";
const PII_CARD = "4111 1111 1111 1111";
const PII_TOKENS = [PII_EMAIL, PII_PHONE, PII_SSN, PII_CARD];

function parseContent(res: { content: string }): Record<string, unknown> {
  return JSON.parse(res.content) as Record<string, unknown>;
}

function assertNoPii(serialized: string) {
  for (const tok of PII_TOKENS) {
    expect(serialized).not.toContain(tok);
  }
  expect(serialized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("query_operator_feedback", () => {
  it("aggregates per-agent CSAT, surfaces lowest-rated agents, and SCRUBS comment PII before the model sees it", async () => {
    const eqCalls: Array<[string, unknown]> = [];
    const feedbackRows = [
      { agent_slug: "support-lead", target_type: "agent_run", rating: 1, comment: null, created_at: "2026-06-10T00:00:00Z" },
      { agent_slug: "support-lead", target_type: "agent_run", rating: -1, comment: `Wrong answer, contact ${PII_EMAIL} who complained`, created_at: "2026-06-10T01:00:00Z" },
      { agent_slug: "support-lead", target_type: "agent_run", rating: -1, comment: `caller ${PII_PHONE} still unhappy`, created_at: "2026-06-10T02:00:00Z" },
      { agent_slug: "support-lead", target_type: "agent_run", rating: -1, comment: null, created_at: "2026-06-10T03:00:00Z" },
      { agent_slug: "support-lead", target_type: "agent_run", rating: -1, comment: null, created_at: "2026-06-10T04:00:00Z" },
      { agent_slug: "pm", target_type: "agent_run", rating: 1, comment: `SSN ${PII_SSN} leaked? great catch`, created_at: "2026-06-09T00:00:00Z" },
      { agent_slug: "pm", target_type: "decision", rating: 1, comment: null, created_at: "2026-06-09T01:00:00Z" },
      { agent_slug: "pm", target_type: "agent_run", rating: 1, comment: `card ${PII_CARD} mentioned in thread`, created_at: "2026-06-09T02:00:00Z" },
    ];
    const b = mkBuilder({ limit: { data: feedbackRows, error: null }, eqCalls });
    mkSvc({ agent_feedback: b });

    const res = await callPraxisCorpusTool(TENANT, "query_operator_feedback", { days: 30 });
    expect(res.is_error).toBe(false);
    const out = parseContent(res);

    expect(eqCalls).toContainEqual(["tenant_id", TENANT]);

    const byAgent = out.by_agent as Array<Record<string, unknown>>;
    const support = byAgent.find((a) => a.agent_slug === "support-lead")!;
    expect(support.thumbs_up).toBe(1);
    expect(support.thumbs_down).toBe(4);
    expect(support.total).toBe(5);
    expect(support.pct_positive).toBe(0.2);
    const pm = byAgent.find((a) => a.agent_slug === "pm")!;
    expect(pm.pct_positive).toBe(1);

    const lowest = out.lowest_rated_agents as Array<Record<string, unknown>>;
    expect(lowest[0].agent_slug).toBe("support-lead");

    assertNoPii(res.content);
    expect(res.content).toContain("[EMAIL]");
  });

  it("returns an empty digest (no throw) when the tenant has no feedback", async () => {
    const eqCalls: Array<[string, unknown]> = [];
    const b = mkBuilder({ limit: { data: [], error: null }, eqCalls });
    mkSvc({ agent_feedback: b });

    const res = await callPraxisCorpusTool(TENANT, "query_operator_feedback", {});
    expect(res.is_error).toBe(false);
    const out = parseContent(res);
    expect(out.by_agent).toEqual([]);
    expect(out.lowest_rated_agents).toEqual([]);
    expect(out.samples).toEqual([]);
    expect(out.feedback_rows_seen).toBe(0);
  });
});

describe("query_support_themes", () => {
  it("returns SERVER-SIDE REDACTED topic counts + scrubbed snippets — zero PII reaches the model", async () => {
    const slackEqCalls: Array<[string, unknown]> = [];
    const killEqCalls: Array<[string, unknown]> = [];
    const slackRows = [
      { text_redacted: `I was double charged on my invoice, refund please — ${PII_EMAIL}`, conversation_type: "channel_public", created_at: "2026-06-10T00:00:00Z" },
      { text_redacted: `billing is broken, got charged twice, call me ${PII_PHONE}`, conversation_type: "dm", created_at: "2026-06-10T01:00:00Z" },
      { text_redacted: `can't log in, password reset link is broken`, conversation_type: "dm", created_at: "2026-06-10T02:00:00Z" },
      { text_redacted: `login fails every time, locked out`, conversation_type: "channel_public", created_at: "2026-06-10T03:00:00Z" },
      { text_redacted: `just saying hi, no issue here`, conversation_type: "channel_public", created_at: "2026-06-10T04:00:00Z" },
    ];
    const killB = mkBuilder({ maybeSingle: { data: { disabled_at: null }, error: null }, eqCalls: killEqCalls });
    const slackB = mkBuilder({ limit: { data: slackRows, error: null }, eqCalls: slackEqCalls });
    mkSvc({ tenant_slack_index_state: killB, slack_message_index: slackB });

    const res = await callPraxisCorpusTool(TENANT, "query_support_themes", { days: 14 });
    expect(res.is_error).toBe(false);
    const out = parseContent(res);

    expect(out.available).toBe(true);
    expect(out.messages_seen).toBe(5);

    expect(killEqCalls).toContainEqual(["tenant_id", TENANT]);
    expect(slackEqCalls).toContainEqual(["tenant_id", TENANT]);

    const themes = out.themes as Array<Record<string, unknown>>;
    const byTheme = new Map(themes.map((t) => [t.theme as string, t]));
    expect(byTheme.get("billing / payments")!.count).toBe(2);
    expect(byTheme.get("login / auth / access")!.count).toBe(2);

    assertNoPii(res.content);
    const billingSnips = byTheme.get("billing / payments")!.sample_snippets as string[];
    expect(billingSnips.length).toBeGreaterThan(0);
    expect(billingSnips.join(" ")).toContain("[EMAIL]");
  });

  it("respects the Slack-index KILL-SWITCH — disabled tenant gets an empty digest, no content read", async () => {
    const killEqCalls: Array<[string, unknown]> = [];
    const slackEqCalls: Array<[string, unknown]> = [];
    const killB = mkBuilder({ maybeSingle: { data: { disabled_at: "2026-06-01T00:00:00Z" }, error: null }, eqCalls: killEqCalls });
    const slackB = mkBuilder({ limit: { data: [{ text_redacted: "should never be read", conversation_type: "dm", created_at: "2026-06-10T00:00:00Z" }], error: null }, eqCalls: slackEqCalls });
    const svc = mkSvc({ tenant_slack_index_state: killB, slack_message_index: slackB });

    const res = await callPraxisCorpusTool(TENANT, "query_support_themes", {});
    expect(res.is_error).toBe(false);
    const out = parseContent(res);
    expect(out.available).toBe(false);
    expect(out.reason).toBe("slack_index_disabled");
    expect(out.themes).toEqual([]);
    expect(svc.from).not.toHaveBeenCalledWith("slack_message_index");
  });

  it("fails CLOSED when the kill-switch state can't be read (no content surfaced)", async () => {
    const killB = mkBuilder({ maybeSingle: { data: null, error: { message: "boom" } }, eqCalls: [] });
    const slackB = mkBuilder({ limit: { data: [], error: null }, eqCalls: [] });
    const svc = mkSvc({ tenant_slack_index_state: killB, slack_message_index: slackB });

    const res = await callPraxisCorpusTool(TENANT, "query_support_themes", {});
    expect(res.is_error).toBe(false);
    const out = parseContent(res);
    expect(out.available).toBe(false);
    expect(out.reason).toBe("slack_index_state_unreadable");
    expect(out.themes).toEqual([]);
    expect(svc.from).not.toHaveBeenCalledWith("slack_message_index");
  });

  it("returns an empty digest (no throw) when the tenant has no Slack rows", async () => {
    const killB = mkBuilder({ maybeSingle: { data: null, error: null }, eqCalls: [] });
    const slackB = mkBuilder({ limit: { data: [], error: null }, eqCalls: [] });
    mkSvc({ tenant_slack_index_state: killB, slack_message_index: slackB });

    const res = await callPraxisCorpusTool(TENANT, "query_support_themes", {});
    expect(res.is_error).toBe(false);
    const out = parseContent(res);
    expect(out.available).toBe(true);
    expect(out.messages_seen).toBe(0);
    expect(out.themes).toEqual([]);
  });
});

describe("discovery — new tools are advertised on praxis_corpus", () => {
  it("lists query_operator_feedback + query_support_themes", async () => {
    const { listPraxisCorpusTools } = await import("../praxis-corpus");
    const names = listPraxisCorpusTools().map((t) => t.tool_name);
    expect(names).toContain("query_operator_feedback");
    expect(names).toContain("query_support_themes");
  });
});
