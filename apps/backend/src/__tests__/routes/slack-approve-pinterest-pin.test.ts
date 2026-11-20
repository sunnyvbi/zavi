import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const SECRET = "test-signing-secret";
const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";
const APPROVER_A = "10000000-0000-4000-8000-00000000000a";
const APPROVER_B = "10000000-0000-4000-8000-00000000000b";
const DECISION = "20000000-0000-4000-8000-000000000015";
const TEAM_A = "TTEAMA";
const TEAM_B = "TTEAMB";
const SLACK_USER = "USLACK1";

const m = vi.hoisted(() => {
  const state = {
    workspaces: {} as Record<string, string>,
    approvers: {} as Record<string, string>,
    roles: {} as Record<string, string>,
    decision: null as Record<string, unknown> | null,
  };
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const resolve = (table: string, f: Record<string, unknown>) => {
    if (table === "slack_workspaces") {
      const t = state.workspaces[String(f.team_id)];
      return t ? { tenant_id: t } : null;
    }
    if (table === "decisions") return state.decision && state.decision.id === f.id ? { ...state.decision } : null;
    if (table === "tenant_users") {
      const r = state.roles[`${f.user_id}:${f.tenant_id}`];
      return r ? { role: r } : null;
    }
    return null;
  };
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (k: string, v: unknown) => {
      filters[k] = v;
      return b;
    };
    b.in = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.maybeSingle = async () => ({ data: resolve(table, filters), error: null });
    b.single = b.maybeSingle;
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
    return b;
  };
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (fn === "resolve_slack_approver") {
      return { data: state.approvers[`${args.p_tenant_id}:${args.p_team_id}:${args.p_slack_user_id}`] ?? null, error: null };
    }
    if (fn === "approve_social_draft_as_actor" || fn === "decide_decision_as_actor") {
      return { data: { changed: true, status: "approved" }, error: null };
    }
    return { data: null, error: null };
  });
  const send = vi.fn(async (_e: unknown) => ({ ids: ["e1"] }));
  const publishPin = vi.fn();
  const composioExec = vi.fn();
  const auth = { tenant_id: "", user_id: "" };
  return { state, rpcCalls, from, rpc, send, publishPin, composioExec, auth };
});

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: m.send } }));
vi.mock("@/services/approvals/decide-service", async (orig) => {
  const real = await orig<typeof import("@/services/approvals/decide-service")>();
  return { ...real, decideOnDecision: vi.fn(real.decideOnDecision) };
});
vi.mock("@/services/slack/approval-post-target", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  refreshApprovalCard: vi.fn(async () => true),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: m.auth.tenant_id, user_id: m.auth.user_id })),
}));
vi.mock("@/services/connectors/pinterest-composio/publish", () => ({ publishPinterestPinViaComposio: m.publishPin }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: m.composioExec }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/analytics/action-events", () => ({ trackApprovalCardDecided: vi.fn(), trackSocialPostPublished: vi.fn() }));
vi.mock("@/services/growth/bind-action-outcome", () => ({ bindActionOutcome: vi.fn(async () => {}) }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecision: vi.fn(async () => {}) }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/staff/capture-admin-correction", () => ({ captureAdminCorrection: vi.fn(async () => {}) }));

import { decideOnDecision } from "@/services/approvals/decide-service";
import { buildApprovalBlocks } from "@/services/approvals/slack-approval-blocks";
import { slackInteractionsWebhook } from "../../routes/webhooks/slack-interactions";
import { approvalsApprove } from "../../routes/approvals/decide";

const decide = vi.mocked(decideOnDecision);

function pinDecision(tenant: string) {
  return {
    id: DECISION,
    tenant_id: tenant,
    status: "proposed",
    decision_class: "social.publish.v2",
    agent_run_id: "30000000-0000-4000-8000-000000000001",
    body: {
      channel: "pinterest_pin",
      scheduled_at: null,
      payload: {
        image_path: `${tenant}/40000000-0000-4000-8000-000000000001.jpg`,
        title: "Linen duvet cover",
        text: "Stonewashed linen that softens with every wash.",
        board_id: "222",
        board_name: "Linen bedding",
        link: "https://acme.com/p/duvet",
      },
    },
  };
}

function cardApproveValue(): string {
  const blocks = buildApprovalBlocks({ ...(m.state.decision as { id: string; decision_class: string; body: unknown }) }) as Array<{
    type: string;
    elements?: Array<{ action_id?: string; value?: string }>;
  }>;
  const btn = blocks.find((b) => b.type === "actions")?.elements?.find((e) => e.action_id === "praxis_approve");
  if (!btn?.value) throw new Error("pin card has no Approve button");
  return btn.value;
}

function signedClick(team: string, value: string, extra: Record<string, unknown> = {}): Request {
  const payload = {
    type: "block_actions",
    team: { id: team },
    user: { id: SLACK_USER },
    response_url: "https://hooks.slack.test/r1",
    actions: [{ action_id: "praxis_approve", value }],
    ...extra,
  };
  const raw = "payload=" + encodeURIComponent(JSON.stringify(payload));
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  const headers: Record<string, string> = { "x-slack-request-timestamp": ts, "x-slack-signature": sig };
  return { body: Buffer.from(raw, "utf8"), header: (n: string) => headers[n.toLowerCase()] } as unknown as Request;
}

function mkRes() {
  const out = { status: 200, body: null as unknown };
  const res = {
    status(c: number) { out.status = c; return res; },
    sendStatus(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
  } as unknown as Response;
  return { res, out };
}

const flipCalls = () => m.rpcCalls.filter((c) => c.fn === "approve_social_draft_as_actor" || c.fn.startsWith("decide_decision_as"));
const sentNames = () => m.send.mock.calls.map((c) => (c[0] as { name: string }).name);
const slackUpdates = () =>
  (vi.mocked(fetch).mock.calls as unknown as Array<[string, RequestInit]>)
    .filter((c) => c[0] === "https://hooks.slack.test/r1")
    .map((c) => JSON.parse(String(c[1].body)).text as string);

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  m.rpcCalls.length = 0;
  m.rpc.mockClear();
  m.send.mockClear();
  m.publishPin.mockClear();
  m.composioExec.mockClear();
  decide.mockClear();
  m.state.workspaces = { [TEAM_A]: TENANT_A, [TEAM_B]: TENANT_B };
  m.state.approvers = {
    [`${TENANT_A}:${TEAM_A}:${SLACK_USER}`]: APPROVER_A,
    [`${TENANT_B}:${TEAM_B}:${SLACK_USER}`]: APPROVER_B,
  };
  m.state.roles = { [`${APPROVER_A}:${TENANT_A}`]: "owner", [`${APPROVER_B}:${TENANT_B}`]: "owner" };
  m.state.decision = pinDecision(TENANT_A);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })) as unknown as typeof fetch);
});

describe("Approve on a Slack Pinterest pin card (flow 15)", () => {
  it("runs the shared decide path for the workspace's tenant, queues dispatch, and publishes nothing itself", async () => {
    const value = cardApproveValue();
    const { res, out } = mkRes();
    await slackInteractionsWebhook(signedClick(TEAM_A, value), res);

    expect(out.status).toBe(200);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0][0]).toMatchObject({
      decision_id: DECISION,
      tenant_id: TENANT_A,
      action: "approve",
      actor: { user_id: APPROVER_A },
    });
    expect(flipCalls()).toHaveLength(1);
    expect(flipCalls()[0]).toMatchObject({
      fn: "approve_social_draft_as_actor",
      args: { p_decision_id: DECISION, p_tenant_id: TENANT_A, p_actor_user_id: APPROVER_A },
    });
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0][0]).toMatchObject({
      name: "decision.approved",
      data: { decision_id: DECISION, tenant_id: TENANT_A, decision_class: "social.publish.v2" },
    });
    expect(sentNames()).not.toContain("social/publish.requested");
    expect(m.publishPin).not.toHaveBeenCalled();
    expect(m.composioExec).not.toHaveBeenCalled();
    const said = slackUpdates().join("\n");
    expect(said).toContain("dispatch queued");
    expect(said).not.toContain("Posted on Pinterest");
  });

  it("makes the same decide call and the same flip as the web Approve button", async () => {
    const { res: sres } = mkRes();
    await slackInteractionsWebhook(signedClick(TEAM_A, cardApproveValue()), sres);
    const slackDecide = decide.mock.calls[0][0];
    const slackFlip = flipCalls()[0];

    m.rpcCalls.length = 0;
    decide.mockClear();
    m.send.mockClear();
    m.auth.tenant_id = TENANT_A;
    m.auth.user_id = APPROVER_A;
    const { res: wres, out: wout } = mkRes();
    await approvalsApprove({ params: { decision_id: DECISION }, body: { expected_scheduled_at: null }, query: {} } as unknown as Request, wres);

    expect(wout.status).toBe(200);
    expect(decide).toHaveBeenCalledTimes(1);
    const webDecide = decide.mock.calls[0][0];
    for (const k of ["decision_id", "tenant_id", "action", "actor", "expected_scheduled_at"] as const) {
      expect(slackDecide[k]).toEqual(webDecide[k]);
    }
    expect(flipCalls()).toEqual([slackFlip]);
    expect(m.send.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ name: "decision.approved", data: expect.objectContaining({ decision_id: DECISION, tenant_id: TENANT_A }) }),
    ]);
  });

  it("does not post a pin with an unverified link check on a Slack click, and says why", async () => {
    const d = pinDecision(TENANT_A);
    m.state.decision = {
      ...d,
      body: {
        ...d.body,
        readiness: {
          ok: true,
          checks: { board: { status: "pass" }, media: { status: "pass" }, link: { status: "unverified", reason_code: "pinterest_link_unchecked", reason: "Zavi could not open the page this pin links to." }, identity: { status: "pass" } },
        },
      },
    };
    const { res, out } = mkRes();
    await slackInteractionsWebhook(signedClick(TEAM_A, cardApproveValue()), res);

    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, ignored: "requires_unverified_confirm" });
    expect(flipCalls()).toEqual([]);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.publishPin).not.toHaveBeenCalled();
    const said = slackUpdates().join("\n");
    expect(said).toContain("Not posted. Zavi could not check everything on this pin. Link: Zavi could not open the page this pin links to.");
    expect(said).toContain("post it anyway");
  });

  it("refuses a click from another tenant's workspace on this pin: no flip, no dispatch, no publish", async () => {
    const value = cardApproveValue();
    const { res, out } = mkRes();
    await slackInteractionsWebhook(signedClick(TEAM_B, value), res);

    expect(out.status).toBe(403);
    expect((out.body as { error: { code: string } }).error.code).toBe("cross_tenant");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0][0]).toMatchObject({ decision_id: DECISION, tenant_id: TENANT_B, actor: { user_id: APPROVER_B } });
    expect(flipCalls()).toEqual([]);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.publishPin).not.toHaveBeenCalled();
    expect(m.state.decision?.status).toBe("proposed");
  });

  it("takes the tenant from the signed team, never from anything the click carries", async () => {
    const forged = `${DECISION}|sa=`;
    const { res, out } = mkRes();
    await slackInteractionsWebhook(
      signedClick(TEAM_B, forged, { tenant_id: TENANT_A, team_id: TEAM_A, user: { id: SLACK_USER, team_id: TEAM_A } }),
      res,
    );
    expect(out.status).toBe(403);
    expect(decide.mock.calls.map((c) => c[0].tenant_id)).toEqual([TENANT_B]);
    expect(m.rpcCalls.filter((c) => c.fn === "resolve_slack_approver").map((c) => c.args.p_tenant_id)).toEqual([TENANT_B]);
    expect(flipCalls()).toEqual([]);
    expect(m.send).not.toHaveBeenCalled();
  });
});
