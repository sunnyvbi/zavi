import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const SECRET = "test-slack-signing-secret";
const TENANT = "00000000-0000-0000-0000-000000000abc";

const m = vi.hoisted(() => {
  const upsert = vi.fn(async () => ({ error: null }));
  const maybeSingle = vi.fn(async () => ({ data: { tenant_id: "00000000-0000-0000-0000-000000000abc", bot_user_id: "UBOT" }, error: null }));
  const eq: any = vi.fn(() => ({ eq, maybeSingle }));
  const svc = {
    from: vi.fn(() => ({ select: () => ({ eq }), upsert })),
    rpc: vi.fn(async (name: string) => (name === "ingest_event" ? { data: "ie-1", error: null } : { data: null, error: null })),
  };
  return {
    svc,
    upsert,
    enqueueWorkItem: vi.fn(async () => ({ work_item_id: "wi" })),
    enqueueAgentRun: vi.fn(async () => ({ run_id: "run-custom" })),
    resolve: vi.fn(),
    send: vi.fn(async () => ({})),
  };
});

vi.mock("@/services/supabase", () => ({ serviceClient: () => m.svc }));
vi.mock("@/services/agents/work-queue", () => ({ enqueueWorkItem: m.enqueueWorkItem }));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: m.enqueueAgentRun,
  InsufficientCreditsError: class extends Error {},
}));
vi.mock("@/services/agents/fleet-halt", () => ({ FleetHaltedError: class extends Error {} }));
vi.mock("@/../workers/client", () => ({ inngest: { send: m.send } }));
vi.mock("@/services/tools/slack/_reactions", () => ({ ACK_EMOJI: "eyes", addReaction: async () => {} }));
vi.mock("@/services/redactor/slack-payload-sanitizer", () => ({ sanitizeSlackEventPayload: (b: unknown) => b }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn(async () => ({})) }));
vi.mock("@/services/agents/slack-pr-followup", () => ({ handleSlackEngineerFollowup: async () => ({ action: "skip" }) }));
vi.mock("@/services/agents/visibility", () => ({ getEffectiveVisibility: async () => ({ visible: true }) }));
vi.mock("@/services/slack/outbox", () => ({ reserveSlackAnswerBarrier: async () => {} }));
vi.mock("@/services/meetings/slack-summon", () => ({ detectSummon: () => null, handleSlackSummon: async () => {} }));
vi.mock("@/services/memory-cards/slack-remember", () => ({ detectRemember: () => false, handleRemember: async () => {} }));
vi.mock("@/services/approvals/slack-approval-nl", () => ({ looksLikeApprovalIntent: () => false }));
vi.mock("@/services/agents/custom-agent-chat", () => ({
  resolveCustomAgentMention: m.resolve,
  customAgentPausedReply: (n: string) => `${n} is paused. Resume it on its Agent Builder page.`,
  customMentionTask: (t: string) => t,
  planRefusalText: () => "Custom agents are available on paid plans.",
}));

import { slackWebhook } from "../../routes/webhooks/slack";

function req(text: string, eventId = "Ev1"): Request {
  const raw = JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event_id: eventId,
    event: { type: "app_mention", channel: "C1", ts: "1.0", user: "U1", text },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  const h: Record<string, string> = { "x-slack-request-timestamp": ts, "x-slack-signature": sig };
  return { body: Buffer.from(raw), header: (n: string) => h[n.toLowerCase()] } as unknown as Request;
}
function res() {
  const r: any = { code: 200, body: null };
  r.status = (c: number) => ((r.code = c), r);
  r.json = (b: unknown) => ((r.body = b), r);
  return r as Response & { code: number; body: any };
}

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  for (const f of [m.enqueueWorkItem, m.enqueueAgentRun, m.resolve, m.send, m.upsert]) f.mockClear();
});

describe("Slack webhook @name", () => {
  it("an active custom agent of the team's tenant runs, the operator does not wake", async () => {
    m.resolve.mockResolvedValue({ kind: "run", agent: { id: "ag", slug: "c-aaaaaaaa01", name: "Standup", status: "active" }, task: "go" });
    const r = res();
    await slackWebhook(req("<@UBOT> @Standup go"), r);
    expect(r.body).toEqual({ ok: true, custom_agent: "routed" });
    expect(m.resolve).toHaveBeenCalledWith(TENANT, "<@UBOT> @Standup go");
    expect(m.enqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({ agent_slug: "c-aaaaaaaa01", tenant_id: TENANT, trigger: "slack", cron_dedupe_key: "slack:Ev1" }));
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("no match: the operator path runs unchanged", async () => {
    m.resolve.mockResolvedValue(null);
    const r = res();
    await slackWebhook(req("<@UBOT> what shipped?", "Ev2"), r);
    expect(r.body).toEqual({ ok: true });
    expect(m.enqueueAgentRun).not.toHaveBeenCalled();
    expect(m.enqueueWorkItem).toHaveBeenCalledWith(expect.objectContaining({ agent_slug: "operator", dedupe_key: "slack:Ev2" }));
    expect(m.send).toHaveBeenCalled();
  });
});
