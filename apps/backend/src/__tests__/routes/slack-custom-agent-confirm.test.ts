import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const SECRET = "test-signing-secret";
const TENANT = "00000000-0000-0000-0000-000000000001";
const HASH = "a".repeat(64);

const m = vi.hoisted(() => {
  const state = { tenantRow: { tenant_id: "00000000-0000-0000-0000-000000000001" } as { tenant_id: string } | null };
  const maybeSingle = vi.fn(async () => ({ data: state.tenantRow, error: null }));
  const serviceClient = vi.fn(() => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }), rpc: vi.fn() }));
  const run = vi.fn();
  const decide = vi.fn();
  return { state, serviceClient, run, decide };
});

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: m.decide }));
vi.mock("@/services/agents/custom-agent-chat", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  runCustomAgentConfirm: m.run,
}));

import { slackInteractionsWebhook } from "../../routes/webhooks/slack-interactions";

function req(value: string, team = "T1", user = "U1"): Request {
  const payload = {
    type: "block_actions",
    team: { id: team },
    user: { id: user },
    response_url: "https://hooks.slack.test/r",
    actions: [{ action_id: "custom_agent_confirm", value }],
  };
  const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  const h: Record<string, string> = { "x-slack-request-timestamp": ts, "x-slack-signature": sig };
  return { body: Buffer.from(raw), header: (n: string) => h[n.toLowerCase()] } as unknown as Request;
}
function res() {
  const r: { code: number; body: unknown } & Record<string, unknown> = { code: 200, body: null };
  r.status = (c: number) => ((r.code = c), r);
  r.json = (b: unknown) => ((r.body = b), r);
  return r as unknown as Response & { code: number; body: any };
}
const posted = () => (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(String((c[1] as { body: string }).body)).text);

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  m.state.tenantRow = { tenant_id: TENANT };
  m.run.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
});

describe("Slack custom-agent Confirm", () => {
  it("ACKs first, then runs the Confirm in the team's tenant with team + user + hash and posts the result", async () => {
    let ackedBeforeRun = false;
    const r = res();
    m.run.mockImplementation(async () => {
      ackedBeforeRun = r.body?.queued === "custom_agent_confirm";
      return { ok: true, text: "Agent created. Open it in Agent Builder: x" };
    });
    await slackInteractionsWebhook(req(`ABCD2345:${HASH}`), r);
    expect(r.code).toBe(200);
    expect(ackedBeforeRun).toBe(true);
    expect(m.run).toHaveBeenCalledWith(
      TENANT,
      { code: "ABCD2345", surface: "slack", external_user_id: "U1", slack_team_id: "T1", draft_hash: HASH },
      { created_by: null, slack_user_id: "U1" },
    );
    expect(posted()).toEqual(["Agent created. Open it in Agent Builder: x"]);
    expect(m.decide).not.toHaveBeenCalled();
  });

  it("a team connected to no tenant is refused before any token read", async () => {
    m.state.tenantRow = null;
    const r = res();
    await slackInteractionsWebhook(req(`ABCD2345:${HASH}`, "T-FOREIGN"), r);
    expect(r.code).toBe(403);
    expect(m.run).not.toHaveBeenCalled();
  });

  it("a thrown Confirm still ACKed 200 and says it failed", async () => {
    m.run.mockRejectedValue(new Error("db"));
    const r = res();
    await slackInteractionsWebhook(req(`ABCD2345:${HASH}`), r);
    expect(r.code).toBe(200);
    expect(posted()).toEqual(["Something went wrong creating the agent. Please try again."]);
  });

  it("a malformed button value is invalid, nothing run", async () => {
    await slackInteractionsWebhook(req("nope"), res());
    expect(m.run).not.toHaveBeenCalled();
    expect(posted()).toEqual(["This confirm is not valid. Ask Zavi to draft the agent again."]);
  });
});
