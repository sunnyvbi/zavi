
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuth = vi.fn();

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: (...a: unknown[]) => requireAuth(...a),
}));

let tables: Record<string, { data: unknown; error: unknown }> = {};

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => makeSb(),
}));

function makeSb() {
  const node = (table: string): Record<string, unknown> => {
    const result = tables[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self,
      eq: self,
      in: self,
      is: self,
      not: self,
      or: self,
      gte: self,
      lte: self,
      order: self,
      limit: self,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    });
    return chain;
  };
  return { from: (table: string) => node(table) };
}

const TENANT = "11111111-1111-1111-1111-111111111111";

function res() {
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  return {
    out,
    json: (b: Record<string, unknown>) => {
      out.body = b;
    },
    status: (s: number) => {
      out.status = s;
      return { json: (b: Record<string, unknown>) => (out.body = b) };
    },
  };
}

const SEO_CARD = { action_id: "a-9", claim_id: "c-9", exec_class: "seo.create_pr.v1" };

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ tenant_id: TENANT, access_token: "t", user_id: "u" });
  tables = {
    customer_visible_pending_decisions: {
      data: [
        { id: "d-site", agent_run_id: "run-site-pr", decision_class: "engineer.ship-pr", body: {}, status: "proposed", autonomy_at_emit: "approval", handler: "github.open_pr", emitted_at: "2026-10-09T10:00:00Z" },
        { id: "d-plain", agent_run_id: "run-plain", decision_class: "engineer.ship-pr", body: {}, status: "proposed", autonomy_at_emit: "approval", handler: "github.open_pr", emitted_at: "2026-10-09T09:00:00Z" },
      ],
      error: null,
    },
    customer_visible_open_channel_actions: { data: [], error: null },
    decision_classes: { data: [], error: null },
    agent_runs: {
      data: [
        { id: "run-site-pr", agent_slug: "engineer", payload: { repo_hint: "acme/site", site_pr_card: SEO_CARD }, channel_slug: null, enqueued_by: null },
        { id: "run-plain", agent_slug: "engineer", payload: { task_description: "fix" }, channel_slug: null, enqueued_by: null },
      ],
      error: null,
    },
  };
});

async function call(query: Record<string, unknown> = {}) {
  const { approvalsList } = await import("../list");
  const r = res();
  await approvalsList({ query } as never, r as never);
  return r.out.body as { decisions: Array<Record<string, unknown>>; channel_pending_counts?: Record<string, number> };
}

describe("a held site-PR engineer PR is listed under its card's channel (Ravi 2026-10-09, #4019)", () => {
  it("attributes the site-PR run's PR to seo and leaves an ordinary engineer PR unattributed", async () => {
    const body = await call();
    const site = body.decisions.find((d) => d.id === "d-site");
    const plain = body.decisions.find((d) => d.id === "d-plain");
    expect(site?.channel_slug).toBe("seo");
    expect(plain?.channel_slug ?? null).toBeNull();
    expect(body.channel_pending_counts?.seo).toBe(1);
  });

  it("returns it on the seo channel's own list", async () => {
    const body = await call({ channel: "seo" });
    expect(body.decisions.map((d) => d.id)).toContain("d-site");
  });

  it("a run a client enqueued never borrows a card's channel", async () => {
    tables.agent_runs = {
      data: [{ id: "run-site-pr", agent_slug: "engineer", payload: { site_pr_card: SEO_CARD }, channel_slug: null, enqueued_by: "u-1" }],
      error: null,
    };
    const body = await call();
    expect(body.decisions.find((d) => d.id === "d-site")?.channel_slug ?? null).toBeNull();
  });

  it("fails the seo list loudly rather than dropping the held PR when the list read fails", async () => {
    tables.customer_visible_pending_decisions = { data: null, error: { message: "boom" } };
    const { approvalsList } = await import("../list");
    const r = res();
    await approvalsList({ query: { channel: "seo" } } as never, r as never);
    expect(r.out.status).toBe(500);
  });
});
