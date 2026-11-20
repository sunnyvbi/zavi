import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

import { emailCardHandlers } from "@/routes/email-cards";
import { makeProposeCampaignTool, type ProposeCampaignDeps } from "@/services/tools/email/propose_campaign";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { sendgridKeyDigest } from "@/services/connectors/email-campaign/credential";
import { executeEmailCampaignSend, executeEmailCampaignSendAndTell, OUTCOME_UNKNOWN_SUFFIX, type EmailSendDeps } from "@/services/connectors/email-campaign/execute-send";
import { BRIGHTLOOP_KEY, fakeSendgrid, type FakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";
import type { EmailTemplate, EmailContent } from "@/services/email-templates/render";
import { BULK_MAY_HAVE_GONE_OUT, TOOL_SEND_NO_ANSWER, ZAVI_SEND_NO_ANSWER, type CardDeps } from "../cards";
import { bulkSendOutcome, notifyEmailSendOutcome, type OutcomeDeps, type SendOutcome } from "../outcome";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";
const DIGEST = sendgridKeyDigest(BRIGHTLOOP_KEY);
const SG_LIST = "6a1f0c2e-0000-4000-8000-00000000b001";
const T = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const DEC = "55555555-5555-4555-8555-555555555555";
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const POLL_STATUSES = new Set(["approved", "queued", "dispatching", "sending", "waiting_for_tomorrow", "held"]);

const TEMPLATE: EmailTemplate = {
  logo_url: null,
  brand_color: "#1a73e8",
  button_color: "#0b8043",
  font_key: "system",
  sign_off: "Thanks,\nThe Brightloop team",
  postal_address: "12 Harbor Way, Portland OR 97201",
  show_cards: false,
};
const version: EmailContent = {
  subject: "Shared workspaces are here",
  preview_text: "One angle",
  title: "Shared workspaces",
  paragraphs: ["A paragraph."],
  button: { label: "See what changed", url: "https://brightloop.test/changelog" },
};

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  };
}

async function view(o: { cls: string; status: string; facts: Record<string, unknown> | null; failure?: string }) {
  mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-owner" });
  const deps: Partial<CardDeps> = {
    rpc: (async (_t: string, name: string) => {
      if (name === "email_card_view_state") {
        return { ok: true, class: o.cls, body: { list_name: "Members", variants: [], chosen_variant: 1 }, open: false, status: o.status, role: "owner", versions: 1, tests: [], retryable: false, failure_reason: o.failure ?? null };
      }
      if (name === "email_card_send_facts") return o.facts;
      if (name === "email_planned_for_card") return null;
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    liveCount: async () => 10,
    confirmedEmail: async () => "owner@brightloop.test",
    enqueue: async () => {},
    groupName: async () => null,
    ...({ paused: async () => false } as Partial<CardDeps>),
  };
  const h = emailCardHandlers(deps, async () => new Set<string>(), (async () => null) as never);
  const r = res();
  await h.view({ params: { rail: "decisions", id: CARD }, body: {} } as never, r as never);
  expect(r.statusCode).toBe(200);
  return r.body.card;
}

const bulk = (over: Record<string, unknown> = {}) => ({ status: "done", hold_reason: null, total: 3, sent: 0, skipped: 0, failed: 0, unknown: 3, hard_bounces: 0, created_at: ago(30), finished_at: ago(29), next_run_at: null, ...over });

function expectTerminalMayHaveGoneOut(card: Record<string, unknown>) {
  expect(card.status).toBe("outcome_unknown");
  expect(card.may_have_sent).toBe(true);
  expect(card.reconciliation_pending).toBe(false);
  expect(card.retryable).toBe(false);
  expect(POLL_STATUSES.has(String(card.status))).toBe(false);
  expect(String(card.failure_reason)).toMatch(/may have gone out/);
  expect(String(card.failure_reason)).toMatch(/will not send/);
  expect(String(card.failure_reason)).not.toMatch(/Nothing was sent|Not sent|nobody was emailed|Something stopped/i);
}

describe("a Zavi-list send of 100 or fewer that SendGrid never confirmed reads as 'may have gone out', never 'not sent'", () => {
  it("the decision settled dispatch_failed with every email unconfirmed: outcome_unknown, not failed", async () => {
    const card = await view({ cls: "bulk_outbound.send", status: "dispatch_failed", facts: { card: { status: "dispatch_failed", approved: true, error: "Not confirmed: these emails may have gone out. (bulk_outbound_unconfirmed)" }, bulk: bulk(), results: null } });
    expectTerminalMayHaveGoneOut(card);
    expect(card.failure_reason).toBe(BULK_MAY_HAVE_GONE_OUT);
    expect(card.sent_count).toBe(0);
  });

  it("a fanned-out send that ended unconfirmed says why in words, not 'Something stopped the send'", async () => {
    const card = await view({ cls: "bulk_outbound.send", status: "acted", facts: { card: { status: "acted", approved: true }, bulk: bulk({ total: 250, unknown: 250 }), results: null } });
    expectTerminalMayHaveGoneOut(card);
  });

  it("a send the provider refused outright is still failed, and a founder's 'not sent' is still not sent", async () => {
    const refused = await view({ cls: "bulk_outbound.send", status: "dispatch_failed", facts: { card: { status: "dispatch_failed", approved: true, error: "Not sent: the email provider refused every email." }, bulk: bulk({ unknown: 0, failed: 3 }), results: null } });
    expect(refused.status).toBe("failed");
    const confirmed = await view({ cls: "bulk_outbound.send", status: "dispatch_failed", facts: { card: { status: "dispatch_failed", approved: true, error: "not_sent_confirmed" }, bulk: bulk(), results: null } });
    expect(confirmed.status).toBe("not_sent");
  });

  it("the outcome for both the dispatch path and the fanout is unknown; a staff hold is told as unknown too", () => {
    expect(bulkSendOutcome(T, DEC, "done", { sent: 0, total: 3, unknown: 3 }, "x")).toMatchObject({ outcome: "unknown", sent: 0, total: 3 });
    expect(bulkSendOutcome(T, DEC, "held", { sent: 0, total: 3, unknown: 1, hold_reason: "list_archived" }, "x")).toMatchObject({ outcome: "unknown" });
    expect(bulkSendOutcome(T, DEC, "held", { sent: 0, total: 3, unknown: 1, hold_reason: "provider_refused" }, "x")).toMatchObject({ outcome: "unknown", sent: 0, total: 3 });
    expect(bulkSendOutcome(T, DEC, "done", { sent: 0, total: 3, unknown: 0 }, "x")).toMatchObject({ outcome: "failed" });
    expect(bulkSendOutcome(T, DEC, "done", { sent: 1, total: 3, unknown: 2 }, "x")).toMatchObject({ outcome: "sent", sent: 1 });
  });
});

function tellDeps(card: { approved_by: string | null; approved_by_source: string | null }) {
  const sent: Array<{ to: string; subject: string; html: string; text: string }> = [];
  const claims: string[] = [];
  const deps: Partial<OutcomeDeps> = {
    readCard: async () => ({ body: { variants: [{ content: { subject: "Shared workspaces are here" } }], chosen_variant: 1, list_name: "Members" }, ...card }),
    claim: async (_t, _r, _id, outcome) => {
      if (claims.includes(outcome)) return false;
      claims.push(outcome);
      return true;
    },
    emailOf: async () => "approver@brightloop.test",
    ownerEmail: async () => "owner@brightloop.test",
    send: async (to, subject, html, text) => {
      sent.push({ to, subject, html, text });
    },
    startResults: async () => undefined,
  };
  return { deps, sent, claims };
}

describe("the outcome email for an unclear send", () => {
  it("says it may have gone out, never 'not sent', and is sent once", async () => {
    const { deps, sent, claims } = tellDeps({ approved_by: "u-1", approved_by_source: null });
    const o: SendOutcome = { tenant_id: T, rail: "decisions", card_id: DEC, outcome: "unknown", sent: 0, total: 3, reason: "Not confirmed: these emails may have gone out." };
    expect(await notifyEmailSendOutcome(o, deps)).toBe(true);
    expect(await notifyEmailSendOutcome(o, deps)).toBe(false);
    expect(claims).toEqual(["unknown"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("May have gone out: Shared workspaces are here");
    expect(sent[0].html).toMatch(/may have gone out/);
    for (const part of [sent[0].subject, sent[0].html, sent[0].text]) expect(part).not.toMatch(/not sent|was not sent/i);
  });
});

describe("the outcome email after an unattended send names Autopilot, never 'You approved'", () => {
  it.each(["plan_autopilot", "cgo"])("approved_by_source %s: goes to the owner and says Autopilot sent it within its limits", async (source) => {
    const { deps, sent } = tellDeps({ approved_by: "u-owner", approved_by_source: source });
    await notifyEmailSendOutcome({ tenant_id: T, rail: "decisions", card_id: DEC, outcome: "sent", sent: 40, total: 40 }, deps);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@brightloop.test");
    expect(sent[0].text).toMatch(/Autopilot sent this email on its own, within the limits of your Auto send setting/);
    expect(sent[0].text).not.toMatch(/You approved/);
    expect(sent[0].html).not.toMatch(/an email you approved/);
  });

  it("a person's tap still says they approved it", async () => {
    const { deps, sent } = tellDeps({ approved_by: "u-1", approved_by_source: null });
    await notifyEmailSendOutcome({ tenant_id: T, rail: "decisions", card_id: DEC, outcome: "sent", sent: 40, total: 40 }, deps);
    expect(sent[0].to).toBe("approver@brightloop.test");
    expect(sent[0].text).toMatch(/You approved this email in Zavi/);
  });
});

function sgDeps(sg: FakeSendgrid): Partial<ProposeCampaignDeps> {
  return {
    resolveTool: (async () => ({ tool: "sendgrid", sendgrid: { api_key: BRIGHTLOOP_KEY, key_digest: DIGEST } })) as unknown as ProposeCampaignDeps["resolveTool"],
    callFor: () => sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch),
    template: async () => TEMPLATE,
    company: async () => ({ name: "Brightloop", website: "https://www.brightloop.test" }),
    testLists: async () => new Set<string>(),
    setting: async () => null,
    railOf: async () => "decisions",
    replaceCard: async () => true,
    now: () => new Date("2026-10-11T12:00:00Z"),
    reserveCard: async () => ({ ok: true as const, id: "res-1" }),
    releaseCard: async () => {},
    settleCard: async () => {},
  };
}

function execDeps(f: typeof fetch, over: Partial<EmailSendDeps> = {}): Partial<EmailSendDeps> {
  return {
    resolveAccount: (async () => {
      throw new Error("composio must not be called for SendGrid");
    }) as unknown as EmailSendDeps["resolveAccount"],
    exec: (async () => {
      throw new Error("composio must not be called for SendGrid");
    }) as unknown as EmailSendDeps["exec"],
    resolveSendgrid: async () => ({ api_key: BRIGHTLOOP_KEY, key_digest: DIGEST }),
    sendgridFetch: f,
    readProgress: async () => null,
    recordProgress: async () => true,
    scheduleReconcile: async () => {},
    scheduleDecisionReconcile: async () => {
      throw new Error("queue down");
    },
    recordSendRef: async () => true,
    authorizeCgo: (async () => ({ verdict: "allow", reasons: [] })) as unknown as EmailSendDeps["authorizeCgo"],
    notifyAutopilotSend: (async () => true) as unknown as EmailSendDeps["notifyAutopilotSend"],
    testListKeys: async () => new Set<string>(),
    sleep: async () => {},
    paused: async () => false,
    ...over,
  };
}

const aborted = () => new DOMException("The operation was aborted.", "AbortError");

describe("a chat-tool send whose SendGrid send call timed out after it landed", () => {
  it("is unknown, told once as 'may have gone out', reads terminal on the card, and a raced retry never sends again", async () => {
    const sg = fakeSendgrid();
    const emit = vi.fn(async (_cls: string, _body: unknown) => DEC);
    await makeProposeCampaignTool(sgDeps(sg)).execute({ tenant_id: T, log: () => {}, emit_decision: emit } as never, { route: "sendgrid", audience_id: SG_LIST, variants: [version] });
    const { rationale: _r, ...body } = emit.mock.calls[0][1] as Record<string, unknown>;
    const row = { id: DEC, tenant_id: T, body: { ...body, chosen_variant: 1 }, approved_by_source: null };

    let down = false;
    const timingOut = (async (input: string | URL, init?: RequestInit) => {
      if (down) throw aborted();
      const answer = await sg.fetch(input, init);
      if ((init?.method ?? "GET") === "PUT" && new URL(String(input)).pathname.endsWith("/schedule")) {
        down = true;
        throw aborted();
      }
      return answer;
    }) as unknown as typeof fetch;

    const told: SendOutcome[] = [];
    const r = await executeEmailCampaignSendAndTell(row, execDeps(timingOut), async (o) => told.push(o));

    expect(sg.count("PUT", /\/schedule$/)).toBe(1);
    expect(sg.sends.map((s) => s.status)).toEqual(["scheduled"]);
    expect(r).toMatchObject({ ok: false, outcome_unknown: true, code: "exec_outcome_unknown" });
    expect(String(r.error)).not.toMatch(/Nothing was sent/);
    expect(told).toEqual([{ tenant_id: T, rail: "decisions", card_id: DEC, outcome: "unknown", sent: null, reason: r.error }]);

    const card = await view({
      cls: "email_campaign.create_and_send",
      status: "dispatch_failed",
      facts: { card: { status: "dispatch_failed", approved: true, dispatched_at: ago(1), error: `${r.error}${OUTCOME_UNKNOWN_SUFFIX}` }, bulk: null, results: null },
    });
    expect(card.status).toBe("outcome_unknown");
    expect(card.failure_reason).toBe(r.error);
    expect(card.may_have_sent).toBe(true);
    expect(card.reconciliation_pending).toBe(false);
    expect(POLL_STATUSES.has(card.status)).toBe(false);

    down = false;
    const again = await Promise.all([executeEmailCampaignSend(row, execDeps(sg.fetch)), executeEmailCampaignSend(row, execDeps(sg.fetch))]);
    expect(sg.count("PUT", /\/schedule$/)).toBe(1);
    expect(sg.count("POST", /\/v3\/marketing\/singlesends$/)).toBe(1);
    for (const a of again) expect(a.ok).toBe(true);
  });

  it("a chat-tool card left 'dispatching' past the bound (worker died mid-call) reads terminal unknown and stops polling; a recent one still polls", async () => {
    const stale = await view({ cls: "email_campaign.create_and_send", status: "dispatching", facts: { card: { status: "dispatching", approved: true, dispatched_at: ago(31) }, bulk: null, results: null } });
    expectTerminalMayHaveGoneOut(stale);
    expect(stale.failure_reason).toBe(TOOL_SEND_NO_ANSWER);
    const fresh = await view({ cls: "email_campaign.create_and_send", status: "dispatching", facts: { card: { status: "dispatching", approved: true, dispatched_at: ago(20) }, bulk: null, results: null } });
    expect(fresh.status).toBe("dispatching");
  });

  it("a Zavi-list send left 'dispatching' past the bound before its bulk job exists never sends the founder to an email tool", async () => {
    const stale = await view({ cls: "bulk_outbound.send", status: "dispatching", facts: { card: { status: "dispatching", approved: true, dispatched_at: ago(31) }, bulk: null, results: null } });
    expectTerminalMayHaveGoneOut(stale);
    expect(stale.failure_reason).toBe(ZAVI_SEND_NO_ANSWER);
    expect(stale.failure_reason).not.toMatch(/email tool/i);
    expect(stale.failure_reason).toMatch(/will not send it again/);
  });
});

describe("a stored raw error on a send that may have gone out names the sender that was used", () => {
  const RAW = "Error: connect ECONNREFUSED 10.0.12.4:443";
  const DROPPED = "Mailchimp did not accept this: HTTP 500. Nothing was sent.";

  it.each([
    ["outcome_unknown", RAW],
    ["partially_sent", RAW],
    ["outcome_unknown", DROPPED],
    ["partially_sent", DROPPED],
  ])("a Zavi-list card in %s with %j points at Zavi's sending service, never the email tool", async (status, failure) => {
    const c = await view({ cls: "bulk_outbound.send", status, facts: null, failure });
    expect(c.failure_reason).toBe(ZAVI_SEND_NO_ANSWER);
    expect(c.failure_reason).not.toMatch(/email tool/i);
    expect(JSON.stringify(c)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(c)).not.toContain("HTTP 500");
  });

  it.each(["outcome_unknown", "partially_sent"])("a chat-tool card in %s still sends the founder to the email tool", async (status) => {
    const c = await view({ cls: "email_campaign.create_and_send", status, facts: null, failure: RAW });
    expect(c.failure_reason).toBe(TOOL_SEND_NO_ANSWER);
    expect(c.failure_reason).toMatch(/Check the email tool/);
  });
});
