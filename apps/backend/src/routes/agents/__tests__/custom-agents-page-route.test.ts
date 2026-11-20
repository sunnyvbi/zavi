
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  auth: null as null | { user_id: string; tenant_id: string; access_token: string },
  rpc: vi.fn(),
  plan: "starter" as string | null,
  audits: [] as Array<Record<string, unknown>>,
}));

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let limit = Infinity;
  const run = () => (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit);
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
    order: () => b,
    limit: (n: number) => ((limit = n), b),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: run(), error: null }).then(res, rej),
  };
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (t: string) => query(t) }),
  serverClientFromBearer: (token: string) => ({ rpc: (fn: string, args: unknown) => m.rpc(fn, args, token) }),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (!m.auth) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return null;
    }
    return m.auth;
  },
}));
vi.mock("@/services/agents/entitlement", () => ({
  tenantPlanForDisplay: async () => m.plan,
}));
vi.mock("@/services/memory/mutation-audit", async (orig) => {
  const real = await orig<typeof import("@/services/memory/mutation-audit")>();
  return { ...real, writeMutationAudit: async (p: Record<string, unknown>) => void m.audits.push(p) };
});
vi.mock("@/services/agents/registry", () => ({ listGlobalAgentSlugs: () => ["operator"] }));
vi.mock("@/services/agents/runner", () => {
  class E extends Error {}
  return {
    enqueueAgentRun: vi.fn(),
    AgentNotFoundError: class extends E {},
    FleetHaltedError: class extends E {},
    InsufficientCreditsError: class extends E {},
    SafetyGateError: class extends E {},
    BudgetExceededError: class extends E {},
  };
});

import {
  customAgentsList,
  customAgentsNoteDelete,
  customAgentsNotes,
  customAgentsRuns,
  runSummary,
} from "../custom-agents";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "44444444-4444-4444-8444-444444444444";
const AGENT_B = "55555555-5555-4555-8555-555555555555";
const NOTE_A = "66666666-6666-4666-8666-666666666666";
const NOTE_B = "77777777-7777-4777-8777-777777777777";

function res() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}
const req = (params: Record<string, string> = {}, query: Record<string, string> = {}) =>
  ({ body: {}, params, query }) as never;

const agent = (id: string, tenant_id: string, slug: string, status = "active") => ({
  id,
  tenant_id,
  slug,
  name: `Agent ${slug}`,
  role: "",
  instructions: "Do it.",
  tools: [],
  default_deliver: null,
  status,
  paused_reason: null,
  version: 1,
  test_run_id: null,
  created_at: "x",
  updated_at: "x",
});

beforeEach(() => {
  m.tables = {
    custom_agents: [
      agent(AGENT_A, A, "c-aaaaaaaa01"),
      agent(AGENT_B, B, "c-bbbbbbbb01"),
      agent("88888888-8888-4888-8888-888888888888", A, "c-dddddddd01", "draft"),
    ],
    custom_agent_triggers: [],
    agent_runs: [
      { id: "r-a1", tenant_id: A, agent_slug: "c-aaaaaaaa01", status: "success", trigger: "cron", enqueued_at: "2026-09-25T16:00:00Z", output_text: "## Standup\n- 3 things changed" },
      { id: "r-b1", tenant_id: B, agent_slug: "c-aaaaaaaa01", status: "success", trigger: "cron", enqueued_at: "2026-09-26T16:00:00Z", output_text: "B secret" },
      { id: "r-b2", tenant_id: B, agent_slug: "c-bbbbbbbb01", status: "error", trigger: "cron", enqueued_at: "2026-09-26T16:00:00Z", output_text: "B only" },
    ],
    memory_note: [
      { id: NOTE_A, tenant_id: A, custom_agent_id: AGENT_A, title: "Spend held at $40", body_markdown: "x", run_id: "r-a1", created_at: "2026-09-25", source: "agent_run", note_type: "untyped", trust_tier: 2, updated_at: "2026-09-25" },
      { id: NOTE_B, tenant_id: B, custom_agent_id: AGENT_B, title: "B note", body_markdown: "x", run_id: "r-b2", created_at: "2026-09-25" },
      { id: "n-plain", tenant_id: A, custom_agent_id: null, title: "Not from an agent", body_markdown: "x", created_at: "2026-09-25" },
    ],
  };
  m.rpc.mockReset();
  m.audits = [];
  m.plan = "starter";
  m.auth = { user_id: "u-a", tenant_id: A, access_token: "tok-a" };
});

describe("GET /api/custom-agents: last run per agent", () => {
  it("joins each agent's last run from its own tenant only", async () => {
    const r = res();
    await customAgentsList(req(), r as never);
    const body = r.body as { agents: Array<{ id: string; last_run: { id: string; summary: string } | null }>; refusal: unknown };
    expect(body.agents.map((a) => a.id)).toEqual([AGENT_A]);
    expect(body.agents[0].last_run?.id).toBe("r-a1");
    expect(body.agents[0].last_run?.summary).toBe("3 things changed");
    expect(JSON.stringify(body)).not.toContain("B secret");
    expect(body.refusal).toBeNull();
  });

  it("a Free workspace gets the typed refusal with the list", async () => {
    m.plan = "free";
    const r = res();
    await customAgentsList(req(), r as never);
    expect((r.body as { refusal: unknown }).refusal).toEqual({
      code: "plan_upgrade_required",
      message: "Custom agents are available on paid plans.",
      action: "upgrade",
      required_tier: "starter",
    });
  });

  it("an unreadable plan is no refusal (the create RPC still enforces it)", async () => {
    m.plan = null;
    const r = res();
    await customAgentsList(req(), r as never);
    expect((r.body as { refusal: unknown }).refusal).toBeNull();
  });
});

describe("GET /api/custom-agents/:id/runs", () => {
  it("lists this tenant's runs of the agent", async () => {
    const r = res();
    await customAgentsRuns(req({ id: AGENT_A }), r as never);
    expect(r.statusCode).toBe(200);
    expect((r.body as { runs: Array<{ id: string }> }).runs.map((x) => x.id)).toEqual(["r-a1"]);
  });

  it("another tenant's agent id is a 404 and reads no runs", async () => {
    const r = res();
    await customAgentsRuns(req({ id: AGENT_B }), r as never);
    expect(r.statusCode).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain("B only");
  });
});

describe("GET /api/custom-agents/:id/notes", () => {
  it("lists only notes stamped with this agent in this tenant", async () => {
    const r = res();
    await customAgentsNotes(req({ id: AGENT_A }), r as never);
    expect((r.body as { notes: Array<{ id: string; text: string }> }).notes).toEqual([
      { id: NOTE_A, text: "Spend held at $40", run_id: "r-a1", created_at: "2026-09-25" },
    ]);
  });

  it("another tenant's agent is a 404", async () => {
    const r = res();
    await customAgentsNotes(req({ id: AGENT_B }), r as never);
    expect(r.statusCode).toBe(404);
  });
});

describe("DELETE /api/custom-agents/:id/notes/:noteId", () => {
  it("calls the member RPC with the AUTH tenant and the caller's own token; the audit is the RPC's, not the route's", async () => {
    m.rpc.mockResolvedValue({ data: true, error: null });
    const r = res();
    await customAgentsNoteDelete(req({ id: AGENT_A, noteId: NOTE_A }), r as never);
    expect(r.statusCode).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith(
      "delete_custom_agent_note",
      { p_tenant_id: A, p_agent_id: AGENT_A, p_note_id: NOTE_A },
      "tok-a",
    );
    expect(m.audits).toHaveLength(0);
  });

  it("another tenant's agent / note: the RPC deletes nothing, so a 404", async () => {
    m.rpc.mockResolvedValue({ data: false, error: null });
    const r = res();
    await customAgentsNoteDelete(req({ id: AGENT_B, noteId: NOTE_B }), r as never);
    expect(r.statusCode).toBe(404);
    expect(m.rpc.mock.calls[0][1]).toMatchObject({ p_tenant_id: A });
  });

  it("a non-member is a 403", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "not a member of tenant" } });
    const r = res();
    await customAgentsNoteDelete(req({ id: AGENT_A, noteId: NOTE_A }), r as never);
    expect(r.statusCode).toBe(403);
    expect(m.audits).toHaveLength(0);
  });

  it("a malformed id never reaches the RPC", async () => {
    const r = res();
    await customAgentsNoteDelete(req({ id: AGENT_A, noteId: "nope" }), r as never);
    expect(r.statusCode).toBe(404);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe("runSummary", () => {
  it("takes the first meaningful line without markdown", () => {
    expect(runSummary("\n\n**Since last time**\n- a")).toBe("Since last time");
    expect(runSummary(null)).toBeNull();
    expect(runSummary("x".repeat(500))!.length).toBe(200);
  });
});
