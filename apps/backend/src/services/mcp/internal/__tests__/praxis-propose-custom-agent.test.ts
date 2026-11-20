
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  rpc: vi.fn(async () => ({ data: null, error: null })),
  slackFetch: vi.fn(async () => ({ ok: true, ts: "2.0" })),
  wa: vi.fn(async () => ({ ok: true, status: 200 })),
}));

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const run = () => (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
    neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
    in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
    order: () => b,
    limit: () => b,
    insert: async (row: Row | Row[]) => {
      for (const r of Array.isArray(row) ? row : [row]) (m.tables[table] ??= []).push(r);
      return { error: null };
    },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: run(), error: null }).then(res, rej),
  };
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (t: string) => query(t), rpc: m.rpc }),
  serverClientFromBearer: () => ({ from: (t: string) => query(t), rpc: m.rpc }),
}));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/agents/index", () => ({ dispatchers: {} }));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: m.slackFetch }));
vi.mock("@/services/connectors/whatsapp/adapter", () => ({ callWhatsApp: m.wa }));
vi.mock("../../../../../workers/functions/reminder-fire", () => ({ scheduleReminder: vi.fn(async () => {}) }));

import { callPraxisTool, listPraxisTools } from "../praxis";
import { takeRecordedCustomAgentCard } from "@/services/agents/custom-agents";

const TENANT = "11111111-1111-4111-8111-111111111111";
const THREAD = "55555555-5555-4555-8555-555555555555";
const ctx = {
  tenant_id: TENANT,
  run_id: "run-1",
  agent_slug: "operator",
  trigger: "chat",
  chat_thread_id: THREAD,
  user_id: "77777777-7777-4777-8777-777777777777",
} as never;

const args = {
  name: "Standup bot",
  instructions:
    "Every weekday, call praxis_corpus__query_recent_runs, praxis_corpus__query_pending_decisions and praxis_corpus__read_run_output, then summarize what Zavi did.",
  triggers: [{ kind: "schedule", cron: "0 9 * * 1-5" }],
};

function setTier(tier: string) {
  m.tables.tenant_subscriptions = [{ tenant_id: TENANT, tier, status: "active", comp_expires_at: null }];
}

beforeEach(() => {
  m.tables = {
    system_config: [{ id: 1, blob: { tier_gate_enforced: false } }],
    tenants: [{ id: TENANT, timezone: "America/Los_Angeles" }],
    custom_agents: [],
  };
  takeRecordedCustomAgentCard("run-1");
});

describe("praxis__propose_custom_agent", () => {
  it("is advertised, and its description names the praxis_corpus tools exactly", async () => {
    const t = listPraxisTools().find((x) => x.tool_name === "propose_custom_agent");
    expect(t).toBeTruthy();
    for (const n of ["query_recent_runs", "query_pending_decisions", "read_run_output"]) {
      expect(t!.description).toContain(`praxis_corpus__${n}`);
    }
  });

  it("Free tenant (gate OFF): typed refusal, card shows the upgrade notice, no draft", async () => {
    setTier("free");
    const r = await callPraxisTool(ctx, "propose_custom_agent", args);
    expect(r.ok).toBe(false);
    const body = JSON.parse(r.content);
    expect(body.error).toBe("plan_upgrade_required");
    expect(body.message).toBe("Custom agents are available on paid plans.");
    expect(takeRecordedCustomAgentCard("run-1")).toMatchObject({ kind: "refusal" });
  });

  it("Starter tenant: returns a draft (created:false), delivery derived from the thread, no credit estimate", async () => {
    setTier("starter");
    const r = await callPraxisTool(ctx, "propose_custom_agent", { ...args, deliver: { kind: "slack_channel", channel_id: "C0EVIL" } });
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.created).toBe(false);
    expect(body.draft.deliver).toEqual({ kind: "chat_thread", thread_id: THREAD });
    expect(body.draft.triggers[0]).toMatchObject({ kind: "schedule", cron: "0 9 * * 1-5", tz: "America/Los_Angeles" });
    expect(body.draft).not.toHaveProperty("est_daily_credits");
    expect(r.content).not.toMatch(/credit/i);
    expect(takeRecordedCustomAgentCard("run-1")).toMatchObject({ kind: "draft" });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("a Telegram turn derives a telegram destination from the run's own payload", async () => {
    setTier("starter");
    m.tables.agent_runs = [{ id: "run-1", tenant_id: TENANT, payload: { telegram: { chat_id: 424242 } } }];
    const tg = { ...(ctx as object), trigger: "telegram", chat_thread_id: undefined } as never;
    const r = await callPraxisTool(tg, "propose_custom_agent", args);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).draft.deliver).toEqual({ kind: "telegram", chat_id: 424242 });
  });

  it("a Discord turn derives a discord destination (with the guild the binding is checked on)", async () => {
    setTier("starter");
    m.tables.agent_runs = [{ id: "run-1", tenant_id: TENANT, payload: { discord: { channel_id: "D1", guild_id: "G1" } } }];
    const dc = { ...(ctx as object), trigger: "discord", chat_thread_id: undefined } as never;
    const r = await callPraxisTool(dc, "propose_custom_agent", args);
    expect(JSON.parse(r.content).draft.deliver).toEqual({ kind: "discord", channel_id: "D1", guild_id: "G1" });
  });

  it("a Telegram turn whose run belongs to another tenant derives nothing", async () => {
    setTier("starter");
    m.tables.agent_runs = [{ id: "run-1", tenant_id: "99999999-9999-4999-8999-999999999999", payload: { telegram: { chat_id: 1 } } }];
    const tg = { ...(ctx as object), trigger: "telegram", chat_thread_id: undefined } as never;
    const r = await callPraxisTool(tg, "propose_custom_agent", args);
    expect(JSON.parse(r.content).draft.deliver).toBeNull();
  });

  it("refuses a built-in name", async () => {
    setTier("pro");
    const r = await callPraxisTool(ctx, "propose_custom_agent", { ...args, name: "Operator" });
    expect(JSON.parse(r.content).error).toBe("name_reserved");
  });

  it("refuses a watch faster than 15 minutes", async () => {
    setTier("pro");
    const r = await callPraxisTool(ctx, "propose_custom_agent", {
      ...args,
      triggers: [{ kind: "watch", interval_minutes: 5, condition: "pricing changes" }],
    });
    expect(r.ok).toBe(false);
  });

  it("an unknown timezone is refused in plain words, never swapped for the workspace zone", async () => {
    setTier("pro");
    const r = await callPraxisTool(ctx, "propose_custom_agent", {
      ...args,
      triggers: [{ kind: "schedule", cron: "0 9 * * 1-5", tz: "Mars/Olympus" }],
    });
    expect(r.ok).toBe(false);
    const body = JSON.parse(r.content);
    expect(body.error).toBe("input_invalid");
    expect(body.message).toContain('Unknown timezone "Mars/Olympus". Use a name like America/New_York.');
    expect(body.message).not.toContain("[");
  });

  const watchArgs = (condition: string) => ({
    ...args,
    instructions: "Check the condition and report.",
    triggers: [{ kind: "watch", interval_minutes: 30, condition }],
  });

  it("refuses a watch with no web page and no connected source, in plain words", async () => {
    setTier("starter");
    m.tables.connector_metadata = [{ tenant_id: TENANT, slug: "github" }];
    const r = await callPraxisTool(ctx, "propose_custom_agent", watchArgs("when my competitor launches a new plan"));
    expect(r.ok).toBe(false);
    const body = JSON.parse(r.content);
    expect(body.error).toBe("watch_unobservable");
    expect(body.message).toBe(
      "Zavi can't see that yet, so it can't watch for it. Connect the source or name a web page to watch.",
    );
    expect(takeRecordedCustomAgentCard("run-1")).toEqual({
      kind: "refusal",
      refusal: {
        code: "watch_unobservable",
        message: "Zavi can't see that yet, so it can't watch for it. Connect the source or name a web page to watch.",
      },
    });
  });

  it("accepts a watch that names a web page", async () => {
    setTier("starter");
    const r = await callPraxisTool(ctx, "propose_custom_agent", watchArgs("when https://acme.com/pricing changes"));
    expect(r.ok).toBe(true);
  });

  it("accepts a watch that names a connected source", async () => {
    setTier("starter");
    m.tables.connector_metadata = [{ tenant_id: TENANT, slug: "stripe" }];
    const r = await callPraxisTool(ctx, "propose_custom_agent", watchArgs("when Stripe refunds go above 5 in a day"));
    expect(r.ok).toBe(true);
  });
});

describe("praxis__remind: recurring run reminders are paid-only", () => {
  const recurringRun = { mode: "run", note: "tell me the stalled approvals", when: { kind: "recurring", cron: "0 9 * * 1" } };

  beforeEach(() => {
    m.rpc.mockClear();
    m.rpc.mockResolvedValue({ data: "88888888-8888-4888-8888-888888888888", error: null } as never);
  });

  it("Free: recurring run → typed refusal, nothing stored", async () => {
    setTier("free");
    const r = await callPraxisTool(ctx, "remind", recurringRun);
    expect(r.ok).toBe(false);
    const body = JSON.parse(r.content);
    expect(body.error).toBe("plan_upgrade_required");
    expect(body.message).toBe("Custom agents are available on paid plans.");
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("Free: a recurring ping and a one-off run still work", async () => {
    setTier("free");
    const ping = await callPraxisTool(ctx, "remind", { ...recurringRun, mode: "ping" });
    expect(ping.ok).toBe(true);
    const once = await callPraxisTool(ctx, "remind", { mode: "run", note: "re-check the deploy", when: { kind: "in", seconds: 3600 } });
    expect(once.ok).toBe(true);
    expect(m.rpc).toHaveBeenCalledTimes(2);
  });

  it("Starter: recurring run is stored", async () => {
    setTier("starter");
    const r = await callPraxisTool(ctx, "remind", recurringRun);
    expect(r.ok).toBe(true);
    expect(m.rpc).toHaveBeenCalledWith("create_agent_reminder", expect.objectContaining({ p_mode: "run", p_schedule_kind: "recurring" }));
  });
});

describe("praxis__propose_custom_agent on Slack and WhatsApp (S5)", () => {
  const RUN = "99999999-9999-4999-8999-999999999999";
  const slackCtx = {
    tenant_id: TENANT,
    run_id: RUN,
    agent_slug: "operator",
    trigger: "slack",
    slack_routing: { channel_id: "C1", thread_ts: "1.0", original_ts: "1.0", event_id: "Ev1" },
  } as never;
  const waCtx = { tenant_id: TENANT, run_id: RUN, agent_slug: "operator", trigger: "whatsapp" } as never;

  beforeEach(() => {
    m.slackFetch.mockClear();
    m.wa.mockClear();
    m.tables.agent_runs = [
      {
        id: RUN,
        tenant_id: TENANT,
        payload: {
          slack: { team_id: "T1", user: "U1" },
          whatsapp: { wa_id: "1408", phone_number_id: "PN1", message_id: "wamid.1" },
        },
      },
    ];
    m.tables.custom_agent_confirm_tokens = [];
  });

  it("Slack: stores a token bound to tenant + team + user + draft hash, posts a Confirm button, no web-only note", async () => {
    setTier("starter");
    const r = await callPraxisTool(slackCtx, "propose_custom_agent", args);
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.note).not.toMatch(/cannot show/);
    const tok = m.tables.custom_agent_confirm_tokens[0];
    expect(tok).toMatchObject({ tenant_id: TENANT, surface: "slack", external_user_id: "U1", slack_team_id: "T1", action: "create", origin_run_id: RUN });
    expect(String(tok.draft_hash)).toMatch(/^[0-9a-f]{64}$/);
    const [, method, payload, team] = m.slackFetch.mock.calls[0] as unknown as [string, string, Record<string, string>, string];
    expect(method).toBe("chat.postMessage");
    expect(team).toBe("T1");
    const blocks = JSON.parse(payload.blocks) as Array<{ type: string; elements?: Array<{ action_id?: string; value?: string }> }>;
    const button = blocks.find((b) => b.type === "actions")!.elements![0];
    expect(button.action_id).toBe("custom_agent_confirm");
    expect(button.value).toBe(`${tok.code}:${tok.draft_hash}`);
    expect(JSON.stringify(blocks)).not.toMatch(/credit/i);
  });

  it("WhatsApp: a non-owner number is refused before any draft", async () => {
    setTier("starter");
    m.tables.whatsapp_threads = [{ tenant_id: TENANT, phone_number_id: "PN1", wa_id: "1408", status: "enabled", bound_by_user_id: "u-admin" }];
    m.tables.tenant_users = [{ tenant_id: TENANT, user_id: "u-admin", role: "admin" }];
    const r = await callPraxisTool(waCtx, "propose_custom_agent", args);
    expect(JSON.parse(r.content)).toMatchObject({
      error: "not_owner",
      message: "Only the workspace owner's verified number can create agents on WhatsApp. Ask your owner, or create it in Zavi or Slack.",
    });
    expect(m.wa).not.toHaveBeenCalled();
  });

  it("WhatsApp owner: interactive Confirm with the code, token bound to the sender", async () => {
    setTier("starter");
    m.tables.whatsapp_threads = [{ tenant_id: TENANT, phone_number_id: "PN1", wa_id: "1408", status: "enabled", bound_by_user_id: "u-owner" }];
    m.tables.tenant_users = [{ tenant_id: TENANT, user_id: "u-owner", role: "owner" }];
    const r = await callPraxisTool(waCtx, "propose_custom_agent", args);
    expect(r.ok).toBe(true);
    const tok = m.tables.custom_agent_confirm_tokens[0];
    expect(tok).toMatchObject({ surface: "whatsapp", external_user_id: "1408", phone_number_id: "PN1", origin: { message_id: "wamid.1" } });
    const [to, msg] = m.wa.mock.calls[0] as unknown as [string, any];
    expect(to).toBe("1408");
    expect(msg.interactive.body.text).toContain(`Reply CONFIRM ${tok.code} to create it.`);
    expect(msg.interactive.action.buttons[0].reply.id).toBe(`cac:${tok.code}:${tok.draft_hash}`);
  });

  it("edit: names an existing agent of this tenant; unknown name is refused; web edit points at the page", async () => {
    setTier("starter");
    m.tables.custom_agents = [{ tenant_id: TENANT, id: "ag-1", name: "Standup bot", status: "active" }];
    const miss = await callPraxisTool(slackCtx, "propose_custom_agent", { ...args, agent: "Nope" });
    expect(JSON.parse(miss.content).error).toBe("agent_not_found");
    const hit = await callPraxisTool(slackCtx, "propose_custom_agent", { ...args, agent: "standup-bot" });
    expect(hit.ok).toBe(true);
    expect(m.tables.custom_agent_confirm_tokens.at(-1)).toMatchObject({ action: "update", agent_id: "ag-1" });
    const web = await callPraxisTool(ctx, "propose_custom_agent", { ...args, agent: "Standup bot" });
    expect(JSON.parse(web.content).note).toContain("/workspace?tab=agent-builder&agent=ag-1");
    expect(takeRecordedCustomAgentCard("run-1")).toBeNull();
  });
});
