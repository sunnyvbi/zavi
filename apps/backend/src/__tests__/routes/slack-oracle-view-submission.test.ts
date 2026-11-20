import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const SECRET = "test-signing-secret";
const TENANT = "00000000-0000-0000-0000-000000000001";
const APPROVER = "10000000-0000-0000-0000-000000000001";
const RUN = "30000000-0000-0000-0000-0000000000aa";
const TEAM = "T12345";
const SLACK_USER = "U99999";

const m = vi.hoisted(() => {
  const state: {
    tenantRow: { tenant_id: string } | null;
    approverId: string | null;
    approverErr: unknown;
    writeErr: unknown;
  } = {
    tenantRow: { tenant_id: "00000000-0000-0000-0000-000000000001" },
    approverId: "10000000-0000-0000-0000-000000000001",
    approverErr: null,
    writeErr: null,
  };

  const maybeSingle = vi.fn(async () => ({ data: state.tenantRow, error: null }));
  const eq2 = vi.fn(() => ({ maybeSingle }));
  const eq1 = vi.fn(() => ({ eq: eq2, maybeSingle }));
  const select = vi.fn(() => ({ eq: eq1 }));
  const from = vi.fn(() => ({ select }));
  const rpc = vi.fn(async (fn: string, _args?: Record<string, unknown>) => {
    if (fn === "resolve_slack_approver") {
      return { data: state.approverId, error: state.approverErr };
    }
    if (fn === "insert_oracle_correction") {
      return { data: [{ case_id: 1, inserted: true }], error: state.writeErr };
    }
    return { data: null, error: null };
  });
  const serviceClient = vi.fn(() => ({ from, rpc }));

  const decideOnDecision = vi.fn(async (_args: unknown) => ({ ok: true }));

  return { state, maybeSingle, eq1, eq2, select, from, rpc, serviceClient, decideOnDecision };
});

vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: m.decideOnDecision }));

import { slackInteractionsWebhook } from "../../routes/webhooks/slack-interactions";

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

function viewSubmissionBody(opts?: {
  callbackId?: string;
  runId?: string | null;
  agentSlug?: string | null;
  verdict?: string;
  correction?: string;
}): string {
  const pm: Record<string, unknown> = {};
  if (opts?.runId !== null) pm.run_id = opts?.runId ?? RUN;
  if (opts?.agentSlug !== null) pm.agent_slug = opts?.agentSlug ?? "engineer";
  const payload = {
    type: "view_submission",
    team: { id: TEAM },
    user: { id: SLACK_USER },
    view: {
      callback_id: opts?.callbackId ?? "oracle_did_it_work",
      private_metadata: JSON.stringify(pm),
      state: {
        values: {
          b1: { oracle_verdict: { selected_option: { value: opts?.verdict ?? "pass" } } },
          b2: { oracle_correction: { value: opts?.correction ?? "the right answer is X" } },
        },
      },
    },
  };
  return "payload=" + encodeURIComponent(JSON.stringify(payload));
}

function signedReq(rawBody: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return mkReq(rawBody, { "x-slack-request-timestamp": ts, "x-slack-signature": sign(rawBody, ts) });
}

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.SLACK_ORACLE_FORMS_ENABLED = "true";
  m.state.tenantRow = { tenant_id: TENANT };
  m.state.approverId = APPROVER;
  m.state.approverErr = null;
  m.state.writeErr = null;
  m.maybeSingle.mockClear();
  m.rpc.mockClear();
  m.serviceClient.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })) as unknown as typeof fetch);
});

function writeCalls(): number {
  return m.rpc.mock.calls.filter((c) => c[0] === "insert_oracle_correction").length;
}

describe("slack oracle view_submission — flag OFF is INERT (byte-identical to today)", () => {
  it("flag OFF → view_submission 200-ignored, NO write RPC", async () => {
    process.env.SLACK_ORACLE_FORMS_ENABLED = "false";
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(viewSubmissionBody()), res);
    expect(status()).toBe(200);
    expect((body() as { ignored?: string }).ignored).toBe("view_submission");
    expect(writeCalls()).toBe(0);
  });

  it("flag UNSET → same inert 200-ignore, NO write", async () => {
    delete process.env.SLACK_ORACLE_FORMS_ENABLED;
    const { res, status } = mkRes();
    await slackInteractionsWebhook(signedReq(viewSubmissionBody()), res);
    expect(status()).toBe(200);
    expect(writeCalls()).toBe(0);
  });
});

describe("slack oracle view_submission — happy path (flag ON)", () => {
  it("approver submits a golden → write RPC called once + modal cleared", async () => {
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(viewSubmissionBody({ verdict: "fail", correction: "wrong number" })), res);
    expect(status()).toBe(200);
    expect((body() as { response_action?: string }).response_action).toBe("clear");
    expect(writeCalls()).toBe(1);
    const call = m.rpc.mock.calls.find((c) => c[0] === "insert_oracle_correction")!;
    expect(call[1]).toMatchObject({
      p_tenant_id: TENANT,
      p_run_id: RUN,
      p_agent_slug: "engineer",
      p_verdict: "fail",
    });
  });
});

describe("slack oracle view_submission — SAFETY gates (no write on failure)", () => {
  it("bad signature → 403, NO write", async () => {
    const raw = viewSubmissionBody();
    const ts = String(Math.floor(Date.now() / 1000));
    const req = mkReq(raw, { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=deadbeef" });
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(req, res);
    expect(status()).toBe(403);
    expect((body() as { error: { code: string } }).error.code).toBe("bad_signature");
    expect(writeCalls()).toBe(0);
  });

  it("unknown team_id → 403, NO write", async () => {
    m.state.tenantRow = null;
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(viewSubmissionBody()), res);
    expect(status()).toBe(403);
    expect((body() as { error: { code: string } }).error.code).toBe("unknown_team");
    expect(writeCalls()).toBe(0);
  });

  it("non-approver submitter → 403 AND NO write RPC", async () => {
    m.state.approverId = null;
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(viewSubmissionBody()), res);
    expect(status()).toBe(403);
    expect((body() as { error: { code: string } }).error.code).toBe("not_authorized");
    expect(writeCalls()).toBe(0);
  });

  it("cross-tenant target run (RPC raises 42501) → 403, golden NOT persisted", async () => {
    m.state.writeErr = { code: "42501", message: "cross-tenant" };
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(viewSubmissionBody()), res);
    expect(status()).toBe(403);
    expect((body() as { error: { code: string } }).error.code).toBe("cross_tenant");
    expect(writeCalls()).toBe(1);
  });

  it("unknown callback_id → 200 ignore, NO write (can't reach the oracle RPC)", async () => {
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(viewSubmissionBody({ callbackId: "some_other_modal" })), res);
    expect(status()).toBe(200);
    expect((body() as { ignored?: string }).ignored).toContain("callback");
    expect(writeCalls()).toBe(0);
  });

  it("missing target run in private_metadata → modal error, NO write", async () => {
    const { res, status, body } = mkRes();
    await slackInteractionsWebhook(signedReq(viewSubmissionBody({ runId: null })), res);
    expect(status()).toBe(200);
    expect((body() as { response_action?: string }).response_action).toBe("errors");
    expect(writeCalls()).toBe(0);
  });
});

describe("slack oracle view_submission — replay / idempotency", () => {
  it("double submit → both 200, write RPC is replay-idempotent (no double-write error)", async () => {
    const first = mkRes();
    await slackInteractionsWebhook(signedReq(viewSubmissionBody()), first.res);
    expect(first.status()).toBe(200);
    expect((first.body() as { response_action?: string }).response_action).toBe("clear");

    m.rpc.mockImplementation(async (fn: string, _args?: Record<string, unknown>) => {
      if (fn === "resolve_slack_approver") return { data: APPROVER, error: null };
      if (fn === "insert_oracle_correction") return { data: [{ case_id: 1, inserted: false }], error: null };
      return { data: null, error: null };
    });
    const second = mkRes();
    await slackInteractionsWebhook(signedReq(viewSubmissionBody()), second.res);
    expect(second.status()).toBe(200);
    expect((second.body() as { response_action?: string }).response_action).toBe("clear");
  });
});
