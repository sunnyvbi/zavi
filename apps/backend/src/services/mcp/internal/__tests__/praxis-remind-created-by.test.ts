
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  rpc: vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: "rem-1", error: null as unknown })),
  slackFetch: vi.fn(async () => ({ ok: true, user: { tz: "America/Los_Angeles" } })),
}));

function query() {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.maybeSingle = async () => ({ data: { timezone: "America/Los_Angeles" }, error: null });
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => query(), rpc: m.rpc }),
  serverClientFromBearer: () => ({ from: () => query(), rpc: m.rpc }),
}));
vi.mock("@/services/agents/deepagent/engine", () => ({}));
vi.mock("@/agents/index", () => ({ dispatchers: {} }));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: m.slackFetch }));
vi.mock("../../../../../workers/functions/reminder-fire", () => ({ scheduleReminder: vi.fn(async () => {}) }));

import { callPraxisTool } from "../praxis";

const TENANT = "11111111-1111-4111-8111-111111111111";
const THREAD = "55555555-5555-4555-8555-555555555555";
const ACTOR = "88888888-8888-4888-8888-888888888888";
const CHAT_USER = "77777777-7777-4777-8777-777777777777";

const slackCtx = (actor_user_id: string | null) =>
  ({
    tenant_id: TENANT,
    run_id: "run-1",
    agent_slug: "operator",
    trigger: "slack",
    slack_routing: { channel_id: "C1ABC", thread_ts: "1720.1", original_ts: "1720.1", event_id: "Ev1", team_id: "T1" },
    actor: {
      actor_user_id,
      actor_source: "slack",
      slack_user_id: "U1ABC",
      slack_team_id: "T1",
      resolved_tenant_member: actor_user_id != null,
      provenance_label: actor_user_id ? "verified member" : "unverified external",
    },
  }) as never;

const ARGS = { mode: "ping", note: "check the deploy", when: { kind: "in", seconds: 600 } };

function createArgs(): Record<string, unknown> {
  const call = m.rpc.mock.calls.find((c) => c[0] === "create_agent_reminder");
  expect(call).toBeDefined();
  return call![1];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("praxis__remind created_by", () => {
  it("a Slack run stamps the actor envelope's resolved user", async () => {
    const r = await callPraxisTool(slackCtx(ACTOR), "remind", ARGS);
    expect(r.ok).toBe(true);
    expect(createArgs()).toMatchObject({ p_created_by: ACTOR, p_slack_user_id: "U1ABC" });
  });

  it("an unmapped Slack sender leaves created_by null (no guessing)", async () => {
    await callPraxisTool(slackCtx(null), "remind", ARGS);
    expect(createArgs()).toMatchObject({ p_created_by: null, p_slack_user_id: "U1ABC" });
  });

  it("a chat run stamps the signed-in user, ahead of any actor", async () => {
    const ctx = {
      tenant_id: TENANT,
      agent_slug: "operator",
      trigger: "chat",
      chat_thread_id: THREAD,
      user_id: CHAT_USER,
      actor: { actor_user_id: ACTOR, actor_source: "chat", resolved_tenant_member: true, provenance_label: "x" },
    } as never;
    await callPraxisTool(ctx, "remind", ARGS);
    expect(createArgs()).toMatchObject({ p_created_by: CHAT_USER });
  });

  it("ignores a created_by supplied in the model's arguments", async () => {
    await callPraxisTool(slackCtx(null), "remind", { ...ARGS, created_by: CHAT_USER, p_created_by: CHAT_USER });
    expect(createArgs()).toMatchObject({ p_created_by: null });
  });
});
