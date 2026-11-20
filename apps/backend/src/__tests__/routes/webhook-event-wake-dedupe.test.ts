import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const SLACK_SECRET = "test-slack-signing-secret";
const TENANT = "00000000-0000-0000-0000-000000000abc";
const TEAM = "T0EVENTWAKE";

const m = vi.hoisted(() => {
  const state: {
    slackTenantRow: { tenant_id: string; bot_user_id?: string | null } | null;
    ingestId: string | null;
    ghTenantRow: { tenant_id: string } | null;
    ghSigValid: boolean;
    enqueueThrows: Error | null;
    _lastTable?: string;
  } = {
    slackTenantRow: { tenant_id: "00000000-0000-0000-0000-000000000abc" },
    ingestId: "ingested-1",
    ghTenantRow: { tenant_id: "00000000-0000-0000-0000-000000000abc" },
    ghSigValid: true,
    enqueueThrows: null,
  };

  const maybeSingle = vi.fn(async () => {
    return { data: state._lastTable === "slack_workspaces" ? state.slackTenantRow : state.ghTenantRow, error: null };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- self-referential mock chain; explicit any breaks the TS7022/TS7024 circular-inference cycle
  const eqChain: any = vi.fn(() => ({ eq: eqChain, maybeSingle }));
  const select = vi.fn(() => ({ eq: eqChain }));
  const upsert = vi.fn(async (..._a: unknown[]) => ({ error: null }));
  const from = vi.fn((table: string) => {
    state._lastTable = table;
    return { select, upsert };
  });
  const rpc = vi.fn(async (name: string, ..._rest: unknown[]) => {
    if (name === "ingest_event") return { data: state.ingestId, error: null };
    return { data: null, error: null };
  });
  const serviceClient = vi.fn((..._a: unknown[]) => ({ from, rpc }));

  const enqueueWorkItem = vi.fn(async (..._a: unknown[]) => {
    if (state.enqueueThrows) throw state.enqueueThrows;
    return { work_item_id: "wi-xyz" };
  });

  const inngestSend = vi.fn(async (..._a: unknown[]) => ({ ids: ["x"] }));

  const addReaction = vi.fn(async (..._a: unknown[]) => {});

  const verifyWebhookSignature = vi.fn((..._a: unknown[]) => state.ghSigValid);
  const listInstallationRepos = vi.fn(async (..._a: unknown[]) => []);

  return {
    state: state as typeof state & { _lastTable?: string },
    maybeSingle,
    from,
    upsert,
    rpc,
    serviceClient,
    enqueueWorkItem,
    inngestSend,
    addReaction,
    verifyWebhookSignature,
    listInstallationRepos,
  };
});

vi.mock("@/services/supabase", () => ({ serviceClient: (...a: unknown[]) => m.serviceClient(...a) }));
vi.mock("@/services/agents/work-queue", () => ({ enqueueWorkItem: (...a: unknown[]) => m.enqueueWorkItem(...a) }));
vi.mock("@/services/agents/fleet-halt", () => ({
  FleetHaltedError: class FleetHaltedError extends Error {
    code = "fleet_halted";
    constructor() {
      super("fleet halt active");
      this.name = "FleetHaltedError";
    }
  },
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: (...a: unknown[]) => m.inngestSend(...a) } }));
vi.mock("@/services/tools/slack/_reactions", () => ({
  ACK_EMOJI: "eyes",
  addReaction: (...a: unknown[]) => m.addReaction(...a),
}));
vi.mock("@/services/redactor/slack-payload-sanitizer", () => ({
  sanitizeSlackEventPayload: (b: unknown) => b,
}));
vi.mock("@/services/connectors/github/oauth", () => ({
  verifyWebhookSignature: (...a: unknown[]) => m.verifyWebhookSignature(...a),
  listInstallationRepos: (...a: unknown[]) => m.listInstallationRepos(...a),
}));

import { slackWebhook } from "../../routes/webhooks/slack";
import { githubWebhook } from "../../routes/webhooks/github";
import { FleetHaltedError } from "@/services/agents/fleet-halt";

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

function signSlack(rawBody: string, ts: string): string {
  return "v0=" + crypto.createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${rawBody}`).digest("hex");
}

function slackReq(body: Record<string, unknown>): Request {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": signSlack(raw, ts),
  };
  return {
    body: Buffer.from(raw, "utf8"),
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function slackEvent(eventId: string, event: Record<string, unknown>) {
  return { type: "event_callback", team_id: TEAM, event_id: eventId, event };
}

function githubReq(deliveryId: string, eventName: string, body: Record<string, unknown>): Request {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    "x-hub-signature-256": "sha256=stub",
    "x-github-event": eventName,
    "x-github-delivery": deliveryId,
  };
  return {
    body: Buffer.from(raw, "utf8"),
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = "ignored-mocked";
  m.state.slackTenantRow = { tenant_id: TENANT };
  m.state.ingestId = "ingested-1";
  m.state.ghTenantRow = { tenant_id: TENANT };
  m.state.ghSigValid = true;
  m.state.enqueueThrows = null;
  m.state._lastTable = undefined;
  m.enqueueWorkItem.mockClear();
  m.rpc.mockClear();
  m.maybeSingle.mockClear();
  m.upsert.mockClear();
  m.serviceClient.mockClear();
  m.inngestSend.mockClear();
  m.addReaction.mockClear();
  m.verifyWebhookSignature.mockClear();
});

describe("event-wake — Slack app_mention enqueues + dedupes", () => {
  it("first app_mention → enqueueWorkItem once, webhook_slack, connection-derived tenant, dedupe_key on event_id", async () => {
    const { res, status } = mkRes();
    await slackWebhook(slackReq(slackEvent("Ev100", { type: "app_mention", channel: "C1" })), res);
    expect(status()).toBe(200);
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    expect(m.enqueueWorkItem.mock.calls[0][0]).toMatchObject({
      tenant_id: TENANT,
      source: "webhook_slack",
      dedupe_key: "slack:Ev100",
    });
  });

  it("wake message → instant 👀 addReaction with eyes + team_id (synchronous ack)", async () => {
    const { res } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev510", { type: "message", channel_type: "im", channel: "D1", user: "U0HUMAN", text: "hi", ts: "1781.99" })),
      res,
    );
    expect(m.addReaction).toHaveBeenCalledWith(TENANT, "D1", "1781.99", "eyes", TEAM);
  });

  it("image file_share DM → also gets the instant 👀 (the path that was missing a reaction)", async () => {
    const { res } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev511", { type: "message", channel_type: "im", channel: "D1", subtype: "file_share", user: "U0HUMAN", text: "look", ts: "1782.01", files: [{ mimetype: "image/png", url_private_download: "https://files.slack.com/a.png", name: "a.png" }] })),
      res,
    );
    expect(m.addReaction).toHaveBeenCalledWith(TENANT, "D1", "1782.01", "eyes", TEAM);
  });

  it("self/bot message → NO instant reaction (not a wake-worthy message)", async () => {
    m.state.slackTenantRow = { tenant_id: TENANT, bot_user_id: "U0SELF" };
    const { res } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev512", { type: "message", channel_type: "im", channel: "D1", user: "U0SELF", text: "my own reply" })),
      res,
    );
    expect(m.addReaction).not.toHaveBeenCalled();
  });

  it("DM (message + channel_type im) → enqueues", async () => {
    const { res } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev101", { type: "message", channel_type: "im", channel: "D1" })),
      res,
    );
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    expect(m.enqueueWorkItem.mock.calls[0][0]).toMatchObject({ source: "webhook_slack" });
    const preClaim = m.upsert.mock.calls.find(
      (c) => (c[0] as { event_id?: string })?.event_id === "Ev101",
    );
    expect(preClaim).toBeTruthy();
    expect(preClaim?.[0]).toMatchObject({ status: "done", replied_at: null });
  });

  it("ordinary channel message (not a mention, not a DM) → does NOT enqueue OR pre-claim", async () => {
    const { res } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev102", { type: "message", channel_type: "channel", channel: "C1" })),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
    expect(
      m.upsert.mock.calls.some((c) => (c[0] as { event_id?: string })?.event_id === "Ev102"),
    ).toBe(false);
  });

  it("REDELIVERY (ingest_event returns null = duplicate) → does NOT double-enqueue", async () => {
    const r1 = mkRes();
    await slackWebhook(slackReq(slackEvent("Ev200", { type: "app_mention", channel: "C1" })), r1.res);
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);

    m.state.ingestId = null;
    const r2 = mkRes();
    await slackWebhook(slackReq(slackEvent("Ev200", { type: "app_mention", channel: "C1" })), r2.res);
    expect(r2.status()).toBe(200);
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
  });

  it("a fleet halt during enqueue is swallowed → still 200 (no NACK storm)", async () => {
    m.state.enqueueThrows = new FleetHaltedError();
    const { res, status } = mkRes();
    await slackWebhook(slackReq(slackEvent("Ev300", { type: "app_mention", channel: "C1" })), res);
    expect(status()).toBe(200);
  });
});

describe("event-wake — self/bot filter (mirror of slack-triage GUARD 1)", () => {
  it("DM message with bot_id set → does NOT enqueue", async () => {
    const { res, status } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev400", { type: "message", channel_type: "im", channel: "D1", bot_id: "B0BOT", user: "U0BOT" })),
      res,
    );
    expect(status()).toBe(200);
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("DM message with a subtype (e.g. message_changed) → does NOT enqueue", async () => {
    const { res } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev401", { type: "message", channel_type: "im", channel: "D1", subtype: "message_changed", user: "U0HUMAN" })),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("DM message with subtype=file_share from a human (screenshot + caption) → STILL enqueues", async () => {
    m.state.slackTenantRow = { tenant_id: TENANT, bot_user_id: "U0SELF" };
    const { res, status } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev405", { type: "message", channel_type: "im", channel: "D1", subtype: "file_share", user: "U0HUMAN", text: "Can you fix this issue" })),
      res,
    );
    expect(status()).toBe(200);
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    expect(m.enqueueWorkItem.mock.calls[0][0]).toMatchObject({ source: "webhook_slack", dedupe_key: "slack:Ev405" });
  });

  it("image file_share DM → payload.slack.images carries the image ref (mimetype-filtered, capped 4)", async () => {
    m.state.slackTenantRow = { tenant_id: TENANT, bot_user_id: "U0SELF" };
    const { res } = mkRes();
    await slackWebhook(
      slackReq(
        slackEvent("Ev407", {
          type: "message",
          channel_type: "im",
          channel: "D1",
          subtype: "file_share",
          user: "U0HUMAN",
          text: "Can you fix this issue",
          files: [
            { mimetype: "image/png", url_private_download: "https://files.slack.com/x/a.png", name: "shot.png", size: 1234 },
            { mimetype: "application/pdf", url_private_download: "https://files.slack.com/x/doc.pdf", name: "doc.pdf" },
            { mimetype: "image/jpeg", url_private: "https://files.slack.com/x/b.jpg", name: "b.jpg" },
          ],
        }),
      ),
      res,
    );
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    const payload = m.enqueueWorkItem.mock.calls[0][0] as { payload: { slack: { images?: Array<{ url: string; mimetype: string }> } } };
    const imgs = payload.payload.slack.images ?? [];
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toMatchObject({ url: "https://files.slack.com/x/a.png", mimetype: "image/png", name: "shot.png" });
    expect(imgs[1]).toMatchObject({ url: "https://files.slack.com/x/b.jpg", mimetype: "image/jpeg" });
  });

  it("plain-text DM (no files) → payload.slack carries NO images key", async () => {
    const { res } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev408", { type: "message", channel_type: "im", channel: "D1", user: "U0HUMAN", text: "hello" })),
      res,
    );
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    const payload = m.enqueueWorkItem.mock.calls[0][0] as { payload: { slack: Record<string, unknown> } };
    expect(payload.payload.slack).not.toHaveProperty("images");
  });

  it("DM message with subtype=file_share but bot_id set (bot's own upload) → does NOT enqueue", async () => {
    const { res } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev406", { type: "message", channel_type: "im", channel: "D1", subtype: "file_share", bot_id: "B0BOT", user: "U0BOT" })),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("DM message from our own bot_user_id (no bot_id field) → does NOT enqueue", async () => {
    m.state.slackTenantRow = { tenant_id: TENANT, bot_user_id: "U0SELF" };
    const { res } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev402", { type: "message", channel_type: "im", channel: "D1", user: "U0SELF" })),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("DM message from a human (bot_user_id known, different user) → still enqueues", async () => {
    m.state.slackTenantRow = { tenant_id: TENANT, bot_user_id: "U0SELF" };
    const { res } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev403", { type: "message", channel_type: "im", channel: "D1", user: "U0HUMAN" })),
      res,
    );
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
  });

  it("app_mention with bot_id set → does NOT enqueue", async () => {
    const { res } = mkRes();
    await slackWebhook(
      slackReq(slackEvent("Ev404", { type: "app_mention", channel: "C1", bot_id: "B0BOT" })),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });
});

describe("event-wake — GitHub PR/issue enqueues + dedupes", () => {
  it("pull_request.opened → ignored 200, NO enqueue (generic wake removed)", async () => {
    const { res, status, body } = mkRes();
    await githubWebhook(
      githubReq("D-aaa", "pull_request", {
        action: "opened",
        installation: { id: 42, account: { login: "acme", type: "Organization" } },
        pull_request: { html_url: "https://github.com/acme/x/pull/1" },
        repository: { full_name: "acme/svc-android" },
      }),
      res,
    );
    expect(status()).toBe(200);
    expect((body() as { ignored?: unknown }).ignored).toMatchObject({ event: "pull_request", action: "opened" });
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("issues.opened → ignored 200, NO enqueue (generic wake removed)", async () => {
    const { res, status } = mkRes();
    await githubWebhook(
      githubReq("D-bbb", "issues", {
        action: "opened",
        installation: { id: 42, account: { login: "acme" } },
        issue: { html_url: "https://github.com/acme/x/issues/9" },
      }),
      res,
    );
    expect(status()).toBe(200);
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("pull_request.closed (merged) → does NOT take the wake path (engineer-loop branch handles it)", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-ccc", "pull_request", {
        action: "closed",
        installation: { id: 42, account: { login: "acme" } },
        pull_request: { merged: true, html_url: "https://github.com/acme/x/pull/3", merged_at: "2026-05-31T00:00:00Z" },
      }),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("no resolved tenant → does NOT enqueue (cross-tenant defense)", async () => {
    m.state.ghTenantRow = null;
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-ddd", "issues", {
        action: "opened",
        installation: { id: 999, account: { login: "stranger" } },
        issue: { html_url: "https://github.com/stranger/x/issues/1" },
      }),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("bad GitHub signature → 401, never enqueues", async () => {
    m.state.ghSigValid = false;
    const { res, status } = mkRes();
    await githubWebhook(
      githubReq("D-eee", "pull_request", {
        action: "opened",
        installation: { id: 42, account: { login: "acme" } },
      }),
      res,
    );
    expect(status()).toBe(401);
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });
});

describe("engineer PR shepherd — check_run / review / issue_comment routing", () => {
  it("check_run conclusion=failure on engineer/* (check_suite.head_branch) → enqueues ci_failure", async () => {
    const { res, status, body } = mkRes();
    await githubWebhook(
      githubReq("D-cr1", "check_run", {
        action: "completed",
        installation: { id: 42, account: { login: "acme" } },
        check_run: {
          conclusion: "failure",
          check_suite: { head_branch: "engineer/fix-foo" },
        },
        repository: { full_name: "acme/svc-android" },
      }),
      res,
    );
    expect(status()).toBe(200);
    expect((body() as { action?: string }).action).toBe("shepherd_enqueued");
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    expect(m.enqueueWorkItem.mock.calls[0][0]).toMatchObject({
      tenant_id: TENANT,
      source: "webhook_github",
      agent_slug: "engineer",
      dedupe_key: "gh:D-cr1",
      payload: {
        kind: "engineer_pr_shepherd",
        signal: "ci_failure",
        head_branch: "engineer/fix-foo",
        repo_hint: "acme/svc-android",
      },
    });
  });

  it("check_run failure with engineer/* only in pull_requests[].head.ref → enqueues", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-cr2", "check_run", {
        action: "completed",
        installation: { id: 42, account: { login: "acme" } },
        check_run: {
          conclusion: "failure",
          check_suite: { head_branch: "main" },
          pull_requests: [{ head: { ref: "engineer/fix-bar" } }],
        },
      }),
      res,
    );
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    expect(m.enqueueWorkItem.mock.calls[0][0]).toMatchObject({
      payload: { signal: "ci_failure", head_branch: "engineer/fix-bar" },
    });
  });

  it("check_run conclusion=success on engineer/* → does NOT enqueue (green = no follow-up)", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-cr3", "check_run", {
        action: "completed",
        installation: { id: 42, account: { login: "acme" } },
        check_run: {
          conclusion: "success",
          check_suite: { head_branch: "engineer/fix-foo" },
        },
      }),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("check_run failure on a NON-engineer branch → does NOT enqueue", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-cr4", "check_run", {
        action: "completed",
        installation: { id: 42, account: { login: "acme" } },
        check_run: {
          conclusion: "failure",
          check_suite: { head_branch: "feature/human-pr" },
          pull_requests: [{ head: { ref: "feature/human-pr" } }],
        },
      }),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("check_run failure on product-builder/* (not engineer/) → does NOT enqueue", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-cr5", "check_run", {
        action: "completed",
        installation: { id: 42, account: { login: "acme" } },
        check_run: {
          conclusion: "failure",
          check_suite: { head_branch: "product-builder/app-123" },
        },
      }),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("pull_request_review changes_requested on engineer/* → enqueues changes_requested", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-rv1", "pull_request_review", {
        action: "submitted",
        installation: { id: 42, account: { login: "acme" } },
        review: { state: "changes_requested" },
        pull_request: { head: { ref: "engineer/fix-foo" } },
      }),
      res,
    );
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    expect(m.enqueueWorkItem.mock.calls[0][0]).toMatchObject({
      dedupe_key: "gh:D-rv1",
      payload: { signal: "changes_requested", head_branch: "engineer/fix-foo" },
    });
  });

  it("pull_request_review state=commented on engineer/* → enqueues review_commented", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-rv2", "pull_request_review", {
        action: "submitted",
        installation: { id: 42, account: { login: "acme" } },
        review: { state: "commented" },
        pull_request: { head: { ref: "engineer/fix-foo" } },
      }),
      res,
    );
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    expect(m.enqueueWorkItem.mock.calls[0][0]).toMatchObject({
      payload: { signal: "review_commented", head_branch: "engineer/fix-foo" },
    });
  });

  it("pull_request_review state=approved on engineer/* → does NOT enqueue", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-rv3", "pull_request_review", {
        action: "submitted",
        installation: { id: 42, account: { login: "acme" } },
        review: { state: "approved" },
        pull_request: { head: { ref: "engineer/fix-foo" } },
      }),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("pull_request_review changes_requested on a NON-engineer branch → does NOT enqueue", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-rv4", "pull_request_review", {
        action: "submitted",
        installation: { id: 42, account: { login: "acme" } },
        review: { state: "changes_requested" },
        pull_request: { head: { ref: "feature/human-pr" } },
      }),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("issue_comment.created on a PR by a human → enqueues pr_comment (branch null, resolved downstream)", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-ic1", "issue_comment", {
        action: "created",
        installation: { id: 42, account: { login: "acme" } },
        issue: { pull_request: { url: "https://api.github.com/repos/acme/x/pulls/7" } },
        comment: { user: { type: "User" } },
      }),
      res,
    );
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    expect(m.enqueueWorkItem.mock.calls[0][0]).toMatchObject({
      dedupe_key: "gh:D-ic1",
      payload: { signal: "pr_comment", head_branch: null },
    });
  });

  it("issue_comment on a plain issue (no pull_request field) → does NOT enqueue", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-ic2", "issue_comment", {
        action: "created",
        installation: { id: 42, account: { login: "acme" } },
        issue: {},
        comment: { user: { type: "User" } },
      }),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("issue_comment on a PR authored by a bot → does NOT enqueue (no self-storm)", async () => {
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-ic3", "issue_comment", {
        action: "created",
        installation: { id: 42, account: { login: "acme" } },
        issue: { pull_request: { url: "https://api.github.com/repos/acme/x/pulls/8" } },
        comment: { user: { type: "Bot" } },
      }),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("REDELIVERY (same x-github-delivery) → SAME dedupe_key both times (queue collapses)", async () => {
    const ev = () =>
      githubReq("D-cr-dupe", "check_run", {
        action: "completed",
        installation: { id: 42, account: { login: "acme" } },
        check_run: { conclusion: "failure", check_suite: { head_branch: "engineer/fix-foo" } },
      });
    const r1 = mkRes();
    await githubWebhook(ev(), r1.res);
    const r2 = mkRes();
    await githubWebhook(ev(), r2.res);
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(2);
    expect(m.enqueueWorkItem.mock.calls[0][0]).toMatchObject({ dedupe_key: "gh:D-cr-dupe" });
    expect(m.enqueueWorkItem.mock.calls[1][0]).toMatchObject({ dedupe_key: "gh:D-cr-dupe" });
  });

  it("no resolved tenant → does NOT enqueue (cross-tenant defense)", async () => {
    m.state.ghTenantRow = null;
    const { res } = mkRes();
    await githubWebhook(
      githubReq("D-cr-notenant", "check_run", {
        action: "completed",
        installation: { id: 999, account: { login: "stranger" } },
        check_run: { conclusion: "failure", check_suite: { head_branch: "engineer/fix-foo" } },
      }),
      res,
    );
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });

  it("a fleet halt during shepherd enqueue is swallowed → still 200, action shepherd_skipped", async () => {
    m.state.enqueueThrows = new FleetHaltedError();
    const { res, status, body } = mkRes();
    await githubWebhook(
      githubReq("D-cr-halt", "check_run", {
        action: "completed",
        installation: { id: 42, account: { login: "acme" } },
        check_run: { conclusion: "failure", check_suite: { head_branch: "engineer/fix-foo" } },
      }),
      res,
    );
    expect(status()).toBe(200);
    expect((body() as { action?: string }).action).toBe("shepherd_skipped");
  });

  it("bad GitHub signature on a check_run → 401, never enqueues", async () => {
    m.state.ghSigValid = false;
    const { res, status } = mkRes();
    await githubWebhook(
      githubReq("D-cr-sig", "check_run", {
        action: "completed",
        installation: { id: 42, account: { login: "acme" } },
        check_run: { conclusion: "failure", check_suite: { head_branch: "engineer/fix-foo" } },
      }),
      res,
    );
    expect(status()).toBe(401);
    expect(m.enqueueWorkItem).not.toHaveBeenCalled();
  });
});
