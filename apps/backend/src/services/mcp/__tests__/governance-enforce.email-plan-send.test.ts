import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  runs: new Map<string, Record<string, unknown>>(),
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  runReadFails: false,
  killed: false,
}));

vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/services/settings", async (orig) => ({
  ...(await orig<typeof import("@/services/settings")>()),
  getStringSetting: async () => "enforce",
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));
vi.mock("../discovery", () => ({ getEnabledStreamableServer: async () => null }));
vi.mock("../streamable-client", () => ({
  callStreamableTool: vi.fn(),
  advertisedReadToolNames: () => undefined,
  advertisedComposioWriteTool: () => null,
}));
vi.mock("@/services/agents/entitlement", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: async () => ({ enforced: true, tier: "pro", required_tier: "pro", allowed: true }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: "approval", error: null }),
    from: (table: string) => {
      const eqs: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => ((eqs[col] = v), q),
        maybeSingle: async () => {
          if (table === "tenant_agent_kill_switch") return { data: db.killed ? { agent_slug: "email_marketing" } : null, error: null };
          if (table !== "agent_runs") return { data: null, error: null };
          if (db.runReadFails && "tenant_id" in eqs) return { data: null, error: { message: "down" } };
          const row = db.runs.get(String(eqs.id));
          if (!row) return { data: null, error: null };
          const match = Object.entries(eqs).every(([k, v]) => row[k] === v);
          return { data: match ? row : null, error: null };
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantRpc: async (_t: string, name: string, args: Record<string, unknown>) => {
    db.rpcs.push({ name, args });
    if (name === "email_plan_run_context") {
      return { data: { found: true, mode: "weekly_plan", briefed: false }, error: null };
    }
    if (name === "plan_email_send") return { data: { ok: true, id: "item-1", replayed: false }, error: null };
    return { data: null, error: { message: `unexpected ${name}` } };
  },
  tenantClient: () => {
    let table = "";
    const q = {
      from: (t: string) => ((table = t), q),
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: table === "agent_runs" ? { trigger: "channel_recipe", payload: {} } : null, error: null }),
    };
    return q;
  },
}));
vi.mock("@/services/analytics/tenant-timezone", () => ({
  resolveReportingTimezone: async () => ({ tz: "UTC", source: "tenant" }),
}));
vi.mock("@/services/comms/bulk-outbound/lists", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/lists")>()),
  listSummaries: async () => [{ id: LIST, name: "Founders 30", active: true }],
}));
vi.mock("@/services/email-plan/preflight", () => ({
  emailRunPreflight: async () => ({ verdict: "ok" }),
}));

import { callMcpTool, type CallMcpContext } from "../execute";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER_TENANT = "6fcb0904-4e2b-41dc-aa92-83810a902d2d";
const LIST = "11111111-1111-4111-8111-111111111111";
const RUN = "5717aed4-0000-4000-8000-000000000001";
const WEEKLY = { email_plan: { mode: "weekly_plan", timezone: "UTC", week_of: "2026-11-02" } };

function planArgs() {
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  return { route: "zavi_list", list_id: LIST, date: day, time: "10:00", angle: "Spring offer", why: "Last send to this list did well." };
}

function seedRun(over: Record<string, unknown> = {}) {
  db.runs.set(RUN, { id: RUN, tenant_id: TENANT, agent_slug: "email_marketing", trigger: "channel_recipe", payload: WEEKLY, ...over });
}

const ctx = (over: Partial<CallMcpContext> = {}): CallMcpContext => ({
  tenant_id: TENANT,
  run_id: RUN,
  agent_slug: "email_marketing",
  trigger: "channel_recipe",
  ...over,
});

const planRows = () => db.rpcs.filter((r) => r.name === "plan_email_send");
const errorOf = (r: { content: string }) => JSON.parse(r.content).error as string;

beforeEach(() => {
  db.runs.clear();
  db.rpcs.length = 0;
  db.runReadFails = false;
  db.killed = false;
  seedRun();
});

describe("email__plan_send through callMcpTool, weekly_plan run", () => {
  it("reaches the tool, writes the planned row and files no card", async () => {
    const emit = vi.fn(async () => "dec-1");
    const out = await callMcpTool(ctx({ emit_decision: emit }), "email", "plan_send", planArgs());
    expect(out.is_error ?? false).toBe(false);
    expect(JSON.parse(out.content).planned).toMatchObject({ id: "item-1", list: "Founders 30" });
    expect(planRows()).toHaveLength(1);
    expect(planRows()[0].args).toMatchObject({ p_source: "email_agent", p_route: "zavi_list", p_list_id: LIST, p_actor: null });
    expect(emit).not.toHaveBeenCalled();
  });

  it("reaches the tool with no emit channel on the run, the shape of run 5717aed4", async () => {
    const out = await callMcpTool(ctx(), "email", "plan_send", planArgs());
    expect(out.is_error ?? false).toBe(false);
    expect(planRows()).toHaveLength(1);
  });

  it("the model cannot make a run weekly: ctx says email_marketing, the row decides", async () => {
    seedRun({ payload: {} });
    const out = await callMcpTool(ctx(), "email", "plan_send", { ...planArgs(), email_plan: { mode: "weekly_plan" } });
    expect(errorOf(out)).toBe("approval_channel_unavailable");
    expect(planRows()).toHaveLength(0);
  });

  it("a stopped run is still refused, nothing planned", async () => {
    seedRun({ stop_requested: true });
    const out = await callMcpTool(ctx(), "email", "plan_send", planArgs());
    expect(errorOf(out)).toBe("run_cancelled");
    expect(planRows()).toHaveLength(0);
  });

  it("a killed agent is still refused, nothing planned", async () => {
    db.killed = true;
    const out = await callMcpTool(ctx(), "email", "plan_send", planArgs());
    expect(errorOf(out)).toBe("run_cancelled");
    expect(planRows()).toHaveLength(0);
  });

  it("an unreadable run row fails closed", async () => {
    db.runReadFails = true;
    const out = await callMcpTool(ctx(), "email", "plan_send", planArgs());
    expect(errorOf(out)).toBe("approval_channel_unavailable");
    expect(planRows()).toHaveLength(0);
  });
});

describe("the same weekly_plan run still may not send", () => {
  const send = { to: "customer@example.com", subject: "Hello", body_text: "Hi there" };

  it("email__send with no channel is refused", async () => {
    const out = await callMcpTool(ctx(), "email", "send", send);
    expect(errorOf(out)).toBe("approval_channel_unavailable");
  });

  it("email__send with a channel only files its card", async () => {
    const emit = vi.fn(async () => "dec-2");
    const out = await callMcpTool(ctx({ emit_decision: emit }), "email", "send", send);
    expect(errorOf(out)).toBe("pending_approval");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]).toEqual(expect.arrayContaining(["send_email"]));
  });

  it.each(["MAILCHIMP_SEND_CAMPAIGN", "MAILCHIMP_SCHEDULE_CAMPAIGN"])("raw %s is refused outright", async (slug) => {
    const emit = vi.fn(async () => "dec-3");
    const out = await callMcpTool(ctx({ emit_decision: emit }), "composio", slug, {});
    expect(errorOf(out)).toBe("use_email_campaign_tool");
    expect(emit).not.toHaveBeenCalled();
  });

  it("email__propose_campaign is refused by the tool on a plan run", async () => {
    const out = await callMcpTool(ctx({ emit_decision: vi.fn(async () => "dec-4") }), "email", "propose_campaign", {
      route: "mailchimp",
      audience_id: "L1",
      variants: [{ subject: "Hi", preview_text: "p", title: "t", paragraphs: ["a"], button: { label: "Go", url: "https://acme.test" } }],
    });
    expect(errorOf(out)).toBe("plan_run_plans_only");
  });
});

describe("every other run behaves as today", () => {
  it.each<[string, Record<string, unknown>]>([
    ["no email_plan mode", { payload: {} }],
    ["a planned_draft run", { payload: { email_plan: { mode: "planned_draft", item_id: "i", version: 1 } } }],
    ["a malformed mode", { payload: { email_plan: { mode: "weekly_plan" } } }],
    ["another agent holding the mode", { agent_slug: "growth-lead" }],
    ["a chat trigger holding the mode", { trigger: "chat" }],
    ["another tenant's weekly run", { tenant_id: OTHER_TENANT }],
  ])("%s stays blocked and plans nothing", async (_label, over) => {
    seedRun(over);
    const out = await callMcpTool(ctx(), "email", "plan_send", planArgs());
    expect(errorOf(out)).toBe("approval_channel_unavailable");
    expect(planRows()).toHaveLength(0);
  });

  it("a chat run with an emit channel is blocked the same way: the class is what is missing, not the channel", async () => {
    seedRun({ payload: {}, trigger: "chat" });
    const emit = vi.fn(async () => "dec-5");
    const out = await callMcpTool(ctx({ trigger: "chat", chat_thread_id: "t", emit_decision: emit }), "email", "plan_send", planArgs());
    expect(errorOf(out)).toBe("approval_channel_unavailable");
    expect(JSON.parse(out.content).decision_class).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it("a call with no run stays blocked", async () => {
    const out = await callMcpTool(ctx({ run_id: undefined }), "email", "plan_send", planArgs());
    expect(errorOf(out)).toBe("approval_channel_unavailable");
    expect(planRows()).toHaveLength(0);
  });
});
