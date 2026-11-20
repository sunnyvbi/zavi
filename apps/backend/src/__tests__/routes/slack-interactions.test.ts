import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const SECRET = "test-signing-secret";
const TENANT = "00000000-0000-0000-0000-000000000001";
const APPROVER = "10000000-0000-0000-0000-000000000001";
const DECISION = "20000000-0000-0000-0000-000000000099";
const TEAM = "T12345";
const SLACK_USER = "U99999";

const m = vi.hoisted(() => {
  const state: {
    tenantRow: { tenant_id: string } | null;
    approverId: string | null;
    approverErr: unknown;
    decideResult: Record<string, unknown>;
    decisionRow: Record<string, unknown> | null;
    lastTable: string;
    useRealDecide: boolean;
  } = {
    tenantRow: { tenant_id: "00000000-0000-0000-0000-000000000001" },
    approverId: "10000000-0000-0000-0000-000000000001",
    approverErr: null,
    decideResult: { ok: true, code: "ok", changed: true, status: "approved", decision_id: "x" },
    decisionRow: null,
    lastTable: "",
    useRealDecide: false,
  };
  const real: { decide: ((args: unknown) => Promise<unknown>) | null } = { decide: null };

  const maybeSingle = vi.fn(async () => ({ data: state.lastTable === "decisions" ? state.decisionRow : state.tenantRow, error: null }));
  const eq2 = vi.fn(() => ({ maybeSingle }));
  const eq1 = vi.fn(() => ({ eq: eq2, maybeSingle }));
  const select = vi.fn(() => ({ eq: eq1 }));
  const from = vi.fn((table: string) => {
    state.lastTable = table;
    return { select };
  });
  const rpc = vi.fn(async () => ({ data: state.approverId, error: state.approverErr }));
  const serviceClient = vi.fn(() => ({ from, rpc }));

  const decideOnDecision = vi.fn(async (args: unknown) => (state.useRealDecide && real.decide ? real.decide(args) : state.decideResult));
  const refreshApprovalCard = vi.fn(async (_a: unknown) => true);
  const inngestSend = vi.fn(async (_e: unknown) => undefined);
  const approveEmailCard = vi.fn(async (..._a: unknown[]) => ({ ok: true, queued: true, changed: true }));
  const loadTenantRoleFor = vi.fn(async (..._a: unknown[]) => "owner");

  return { state, real, maybeSingle, eq1, eq2, select, from, rpc, serviceClient, decideOnDecision, refreshApprovalCard, inngestSend, approveEmailCard, loadTenantRoleFor };
});

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/approvals/decide-service", async () => {
  const actual = await vi.importActual<typeof import("@/services/approvals/decide-service")>("@/services/approvals/decide-service");
  m.real.decide = actual.decideOnDecision as unknown as (args: unknown) => Promise<unknown>;
  return { ...actual, decideOnDecision: m.decideOnDecision };
});
vi.mock("@/../workers/client", async (orig) => ({
  ...(await orig<typeof import("@/../workers/client")>()),
  inngest: { send: m.inngestSend },
}));
vi.mock("@/services/auth/tenant-role", async (orig) => ({
  ...(await orig<typeof import("@/services/auth/tenant-role")>()),
  loadTenantRoleFor: m.loadTenantRoleFor,
}));
vi.mock("@/services/email-cards/cards", async (orig) => ({
  ...(await orig<typeof import("@/services/email-cards/cards")>()),
  approveEmailCard: m.approveEmailCard,
  emailCardLink: (rail: string, id: string) => `https://app.test/workspace/email-cards/${rail}/${id}`,
}));
vi.mock("@/services/slack/approval-post-target", async () => ({
  ...(await vi.importActual<typeof import("@/services/slack/approval-post-target")>("@/services/slack/approval-post-target")),
  refreshApprovalCard: m.refreshApprovalCard,
}));

import { slackInteractionsWebhook } from "../../routes/webhooks/slack-interactions";
import { EMAIL_CARD_APPROVE_MESSAGE } from "@/services/email-cards/approve-gate";

function sign(rawBody: string, ts: string): string {
  return "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${rawBody}`).digest("hex");
}

function mkRes(): { res: Response; status: () => number; body: () => unknown } {
  let _s = 200;
  let _b: unknown = null;
  const res = {
    status(c: number) { _s = c; return res; },
    sendStatus(c: number) { _s = c; return res; },
    json(b: unknown) { _b = b; return res; },
  } as unknown as Response;
  return { res, status: () => _s, body: () => _b };
}

function mkReq(rawBody: string, headers: Record<string, string>): Request {
  return {
    body: Buffer.from(rawBody, "utf8"),
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function blockActionsBody(actionId: string, value: string = DECISION): string {
  const payload = {
    type: "block_actions",
    team: { id: TEAM },
    user: { id: SLACK_USER },
    response_url: "https://hooks.slack.test/abc",
    actions: [{ action_id: actionId, value }],
  };
  return "payload=" + encodeURIComponent(JSON.stringify(payload));
}

function signedReq(rawBody: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return mkReq(rawBody, { "x-slack-request-timestamp": ts, "x-slack-signature": sign(rawBody, ts) });
}

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  m.state.tenantRow = { tenant_id: TENANT };
  m.state.approverId = APPROVER;
  m.state.approverErr = null;
  m.state.decideResult = { ok: true, code: "ok", changed: true, status: "approved", decision_id: DECISION };
  m.state.decisionRow = null;
  m.state.useRealDecide = false;
  m.inngestSend.mockClear();
  m.approveEmailCard.mockClear();
  m.loadTenantRoleFor.mockClear();
  m.from.mockClear();
  m.maybeSingle.mockClear();
  m.rpc.mockClear();
  m.serviceClient.mockClear();
  m.decideOnDecision.mockClear();
  m.refreshApprovalCard.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })) as unknown as typeof fetch);
});

describe("slack interactions — happy path", () => {
  it("signed approve click → decide('approve') + 200", async () => {
    const raw = blockActionsBody("praxis_approve");
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(raw), res);
    expect(status()).toBe(200);
    expect((body() as { ok: boolean }).ok).toBe(true);
    expect(m.decideOnDecision).toHaveBeenCalledTimes(1);
    expect(m.decideOnDecision.mock.calls[0][0]).toMatchObject({
      decision_id: DECISION,
      tenant_id: TENANT,
      action: "approve",
      actor: { user_id: APPROVER },
    });
  });

  it("the approver lookup is team-aware and DB-only: no users.info, no link on a click", async () => {
    const { res, status } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve")), res);
    expect(status()).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("resolve_slack_approver", {
      p_tenant_id: TENANT,
      p_team_id: TEAM,
      p_slack_user_id: SLACK_USER,
    });
    const rpcNames = (m.rpc.mock.calls as unknown as Array<[string]>).map((c) => c[0]);
    expect(rpcNames).not.toContain("link_slack_identity_if_member");
    const urls = (vi.mocked(fetch).mock.calls as unknown as Array<[unknown]>).map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("users.info"))).toBe(false);
  });

  it("signed reject click → decide('reject')", async () => {
    m.state.decideResult = { ok: true, code: "ok", changed: true, status: "rejected", decision_id: DECISION };
    const { res, status } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_reject")), res);
    expect(status()).toBe(200);
    expect(m.decideOnDecision.mock.calls[0][0]).toMatchObject({ action: "reject" });
  });
});

describe("slack interactions — hard gates (decision untouched)", () => {
  it("bad signature → 403, decide NOT called", async () => {
    const raw = blockActionsBody("praxis_approve");
    const ts = String(Math.floor(Date.now() / 1000));
    const req = mkReq(raw, { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=deadbeef" });
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(req, res);
    expect(status()).toBe(403);
    expect((body() as { error: { code: string } }).error.code).toBe("bad_signature");
    expect(m.decideOnDecision).not.toHaveBeenCalled();
  });

  it("foreign/unknown team_id → 403, decide NOT called", async () => {
    m.state.tenantRow = null;
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve")), res);
    expect(status()).toBe(403);
    expect((body() as { error: { code: string } }).error.code).toBe("unknown_team");
    expect(m.decideOnDecision).not.toHaveBeenCalled();
  });

  it("non-authorized Slack user → 403, decide NOT called", async () => {
    m.state.approverId = null;
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve")), res);
    expect(status()).toBe(403);
    expect((body() as { error: { code: string } }).error.code).toBe("not_authorized");
    expect(m.decideOnDecision).not.toHaveBeenCalled();
  });

  it("cross-tenant decision (decide returns cross_tenant) → 403", async () => {
    m.state.decideResult = { ok: false, code: "cross_tenant", changed: false, status: "proposed", decision_id: DECISION };
    const { res, status } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve")), res);
    expect(status()).toBe(403);
  });

  it("unknown action_id → 200 ignored, decide NOT called", async () => {
    const { res, status } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("some_other_button")), res);
    expect(status()).toBe(200);
    expect(m.decideOnDecision).not.toHaveBeenCalled();
  });
});

describe("slack interactions — ship_red (approve refused, operator must be told)", () => {
  beforeEach(() => {
    m.state.decideResult = {
      ok: false,
      code: "requires_ship_red_override",
      changed: false,
      status: "proposed",
      decision_id: DECISION,
    };
  });

  it("ACKs 200 — a 4xx would show Slack's generic retry chrome, not our text", async () => {
    const { res, status } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve")), res);
    expect(status()).toBe(200);
  });

  it("tells the operator why, and where they CAN approve it", async () => {
    const { res } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve")), res);

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const update = calls.find((c) => c[0] === "https://hooks.slack.test/abc");
    expect(update).toBeTruthy();
    const text = JSON.parse(String((update![1] as RequestInit).body)).text as string;
    expect(text).toContain("broke a test");
    expect(text).toContain("Approvals page");
    expect(text).toContain("ship red");
  });

  it("leaves the red decision UNAPPROVED (no ship-anyway smuggled in from Slack)", async () => {
    const { res } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve")), res);
    expect(m.decideOnDecision).toHaveBeenCalledTimes(1);
    expect(m.decideOnDecision.mock.calls[0][0]).not.toMatchObject({ ship_anyway: true });
  });
});

describe("slack interactions — a social post with blanks is refused, and Slack says why", () => {
  beforeEach(() => {
    m.state.decideResult = {
      ok: false,
      code: "invalid_edit",
      changed: false,
      status: "proposed",
      decision_id: DECISION,
      detail: "Fill before publishing: [First name]",
    };
  });

  it("ACKs 200 and puts the reason in the Slack message", async () => {
    const { res, status } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve")), res);
    expect(status()).toBe(200);
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const update = calls.find((c) => c[0] === "https://hooks.slack.test/abc");
    expect(update).toBeTruthy();
    const text = JSON.parse(String((update![1] as RequestInit).body)).text as string;
    expect(text).toContain("Fill before publishing: [First name]");
    expect(text).toContain("Approvals page");
  });

  it("a title refusal keeps its own instruction and gets no contradicting edit hint", async () => {
    m.state.decideResult = {
      ...m.state.decideResult,
      detail:
        "Fill before publishing: [city]. The title can't be edited here: reject this post and ask Zavi to redo it with the blanks filled.",
    };
    const { res } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve")), res);
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const update = calls.find((c) => c[0] === "https://hooks.slack.test/abc");
    const text = JSON.parse(String((update![1] as RequestInit).body)).text as string;
    expect(text).toContain("reject this post and ask Zavi to redo it");
    expect(text).not.toContain("Edit it on the web Approvals page");
  });
});

describe("slack interactions — a Composio write cannot be approved from Slack (spec 12)", () => {
  beforeEach(() => {
    m.state.decideResult = { ok: false, code: "stale_card", changed: false, status: "proposed", decision_id: DECISION };
  });

  it("ACKs 200, sends no fingerprint, and points the operator at the full card", async () => {
    const { res, status } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve")), res);
    expect(status()).toBe(200);
    expect(m.decideOnDecision).toHaveBeenCalledTimes(1);
    expect((m.decideOnDecision.mock.calls[0][0] as Record<string, unknown>).expected_fingerprint).toBeUndefined();
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const update = calls.find((c) => c[0] === "https://hooks.slack.test/abc");
    expect(update).toBeTruthy();
    const text = JSON.parse(String((update![1] as RequestInit).body)).text as string;
    expect(text).toContain("its card in the Zavi chat");
  });
});

describe("slack interactions — a staged post moved after its card was posted", () => {
  const LOADED = "2099-01-02T09:00:00.000Z";
  const MOVED = "2099-03-04T17:00:00Z";

  it("the card's time rides the Approve value into decide as expected_scheduled_at", async () => {
    const { res, status } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve", `${DECISION}|sa=${LOADED}`)), res);
    expect(status()).toBe(200);
    expect(m.decideOnDecision.mock.calls[0][0]).toMatchObject({ decision_id: DECISION, expected_scheduled_at: LOADED });
  });

  it("a card rendered with no time sends expected null", async () => {
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve", `${DECISION}|sa=`)), mkRes().res);
    expect(m.decideOnDecision.mock.calls[0][0]).toMatchObject({ decision_id: DECISION, expected_scheduled_at: null });
  });

  it("stale value → not approved, card re-rendered, the clicker told the new time without replacing the card", async () => {
    m.state.decideResult = {
      ok: false,
      code: "schedule_changed",
      changed: false,
      status: "proposed",
      decision_id: DECISION,
      current_scheduled_at: MOVED,
    };
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve", `${DECISION}|sa=${LOADED}`)), res);
    expect(status()).toBe(200);
    expect(body()).toMatchObject({ ignored: "schedule_changed" });
    expect(m.refreshApprovalCard).toHaveBeenCalledWith({ tenant_id: TENANT, decision_id: DECISION });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const sent = JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as { body: string }).body));
    expect(sent).toMatchObject({ response_type: "ephemeral", replace_original: false });
    expect(sent.text).toMatch(/^This was moved to <!date\^\d+\^.+>\. Approve again\?$/);
  });

  it("an older card with a bare id (posted before this shipped) approves exactly as before", async () => {
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve", DECISION)), mkRes().res);
    const args = m.decideOnDecision.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({ decision_id: DECISION, action: "approve" });
    expect("expected_scheduled_at" in args).toBe(false);
  });

  it("Reject never carries a time", async () => {
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_reject", DECISION)), mkRes().res);
    expect("expected_scheduled_at" in (m.decideOnDecision.mock.calls[0][0] as Record<string, unknown>)).toBe(false);
  });
});

describe("slack interactions — an over-budget ad raise is chosen in Zavi (plan 2026-10-23)", () => {
  it("ACKs 200, tells the clicker the numbers and to open Zavi, and never sends a limit raise", async () => {
    m.state.decideResult = { ok: false, code: "budget_choice_in_zavi", changed: false, status: "proposed", decision_id: DECISION, detail: "October is projected at about $27,040, over your $27,000 budget. Open it in Zavi to choose." };
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(blockActionsBody("praxis_approve")), res);
    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true, ignored: "budget_choice_in_zavi" });
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const reply = calls.find((c) => c[0] === "https://hooks.slack.test/abc");
    expect(JSON.parse(String((reply![1] as RequestInit).body)).text).toBe("Not approved. October is projected at about $27,040, over your $27,000 budget. Open it in Zavi to choose.");
    const args = m.decideOnDecision.mock.calls[0][0] as Record<string, unknown>;
    expect(args.surface).toBeUndefined();
    expect(args.raise_budget_to_usd).toBeUndefined();
  });
});

describe("slack interactions — an email send is approved only from its email card", () => {
  beforeEach(() => {
    m.state.useRealDecide = true;
  });

  for (const cls of ["email_campaign.create_and_send", "bulk_outbound.send"]) {
    for (const actionId of ["praxis_approve", "praxis_approve_always"]) {
      it(`${actionId} on ${cls}: refused through the real decide, card rewritten to Open in Zavi, nothing approved`, async () => {
        m.state.decisionRow = { id: DECISION, tenant_id: TENANT, status: "proposed", decision_class: cls, agent_run_id: null, body: {} };
        const { res, status, body } = mkRes();
        await slackInteractionsWebhook(signedReq(blockActionsBody(actionId)), res);

        expect(status()).toBe(200);
        expect(body()).toEqual({ ok: true, ignored: "email_card_required" });

        expect(m.decideOnDecision).toHaveBeenCalledTimes(1);
        expect(m.decideOnDecision.mock.calls[0][0]).toMatchObject({
          decision_id: DECISION,
          tenant_id: TENANT,
          action: "approve",
          always_allow: actionId === "praxis_approve_always",
        });
        expect((m.decideOnDecision.mock.calls[0][0] as Record<string, unknown>).email_variant).toBeUndefined();
        expect(m.from.mock.calls.map((c) => c[0])).toContain("decisions");
        expect(m.loadTenantRoleFor).toHaveBeenCalledWith(APPROVER, TENANT);

        const rpcNames = (m.rpc.mock.calls as unknown as Array<[string]>).map((c) => c[0]);
        expect(rpcNames).toEqual(["resolve_slack_approver"]);
        expect(m.inngestSend).not.toHaveBeenCalled();
        expect(m.approveEmailCard).not.toHaveBeenCalled();

        const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe("https://hooks.slack.test/abc");
        expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toEqual({
          replace_original: true,
          text: `This email is still waiting for approval. ${EMAIL_CARD_APPROVE_MESSAGE} Open in Zavi: https://app.test/workspace/email-cards/decisions/${DECISION}`,
        });
        expect(JSON.parse(String((calls[0][1] as RequestInit).body)).text).not.toMatch(/not approved/i);
      });
    }
  }
});
