import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  deps: null as unknown,
  inngestSend: vi.fn(async () => ({})),
  sendOutbound: vi.fn(),
  emailSend: vi.fn(),
  sendFundraisingEmail: vi.fn(),
  callMcpTool: vi.fn(),
  door: vi.fn(async () => null as { code: string; sentence: string } | null),
  paused: vi.fn(async () => false),
  rebuild: vi.fn(async () => ({ pending: true }) as unknown),
  keep: vi.fn(async () => true),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}), send: mocks.inngestSend } }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: mocks.callMcpTool }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), markDispatched: vi.fn(), releaseClaim: vi.fn() }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn() }));
vi.mock("@/services/tools/email/_client", () => ({ emailSend: mocks.emailSend }));
vi.mock("@/services/comms/outbound-send", () => ({ sendOutbound: mocks.sendOutbound }));
vi.mock("@/services/fundraising/send-provider", () => ({ sendFundraisingEmail: mocks.sendFundraisingEmail }));
vi.mock("@/services/email-cards/pause", () => ({ emailSendPaused: (...a: unknown[]) => mocks.paused(...(a as [])) }));
vi.mock("@/services/email-plan/list-door", () => ({ plannedListSendRefusal: (...a: unknown[]) => mocks.door(...(a as [])) }));
vi.mock("@/services/comms/bulk-outbound/fanout", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  defaultFanoutDeps: async () => mocks.deps,
}));

vi.mock("@/services/email-cards/variants", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readTestListKeys: async () => new Set<string>(),
}));
vi.mock("@/services/email-cards/outcome", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tellEmailSendOutcome: vi.fn(async () => "skipped" as const),
  keepEmailSendOutcomeLine: (...a: unknown[]) => mocks.keep(...(a as [])),
}));
vi.mock("@/services/email-cards/outcome-rebuild", () => ({ rebuildSendOutcome: (...a: unknown[]) => mocks.rebuild(...(a as [])) }));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";
import { sealVariants } from "@/services/email-cards/variants";
import { BULK_OUTBOUND_INTERRUPTED_LINE, BULK_OUTBOUND_NOT_SENT_LINE, HANDLER_LABELS, buildDispatchNotice } from "../dispatch-notice";
import { DECISION, TENANT, harness, sentTo } from "@/services/comms/bulk-outbound/__tests__/harness";
import { sendBulkEmail } from "@/services/comms/bulk-outbound/wire";
import { tellEmailSendOutcome } from "@/services/email-cards/outcome";

let h: ReturnType<typeof harness>;

const SEALED = sealVariants(
  { logo_url: null, brand_color: "#2e7d32", button_color: "#2e7d32", font_key: "system", sign_off: "", postal_address: "400 Elm St", show_cards: false },
  [{ subject: "We saved your cart", preview_text: "", title: "Your cart", paragraphs: ["Come back and finish your order."], button: { label: "Open cart", url: "https://shop.example/cart" } }],
  { route: "zavi_list", companyName: null, ownHost: null },
);
const vbody = (over: Record<string, unknown> = {}) => h.body({ template: undefined, ...SEALED, chosen_variant: 1, ...over });

function decision(over: { body?: Record<string, unknown>; approved_by?: string | null; approved_by_source?: string | null } = {}) {
  return {
    id: DECISION,
    tenant_id: TENANT,
    agent_run_id: "run-bulk-1",
    decision_class: "bulk_outbound.send",
    handler: "bulk_outbound.send",
    status: "dispatching",
    approved_by: "approved_by" in over ? over.approved_by : "user-a",
    approved_by_source: over.approved_by_source ?? null,
    body: over.body ?? vbody(),
  } as never;
}

function expectNoOtherSender() {
  expect(mocks.sendOutbound).not.toHaveBeenCalled();
  expect(mocks.emailSend).not.toHaveBeenCalled();
  expect(mocks.sendFundraisingEmail).not.toHaveBeenCalled();
  expect(mocks.callMcpTool).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rebuild.mockImplementation(async () => ({ pending: true }));
  mocks.keep.mockImplementation(async () => true);
  h = harness();
  mocks.deps = h.deps;
});

describe('HANDLERS["bulk_outbound.send"] — an approved bulk email is sent through the ledger', () => {
  it("emails each person on the approved list once and reports real counts", async () => {
    const res = await HANDLERS["bulk_outbound.send"](decision());

    expect(res).toMatchObject({ ok: true, notice: "Sent to 3." });
    expect(res.agent_outcome).toBe(res.notice);
    expect(sentTo(h.wire)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(res.notice).not.toMatch(/@/);
    expectNoOtherSender();
  });

  it("starts the worker with the send id and nothing else", async () => {
    await HANDLERS["bulk_outbound.send"](decision());
    const sendId = [...h.ledger.sends.keys()][0];
    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);
    expect(mocks.inngestSend).toHaveBeenCalledWith({
      id: `bulk-email-fanout:${sendId}`,
      name: "bulk-email/fanout.requested",
      data: { send_id: sendId },
    });
  });

  it("never sends to a recipient list smuggled into the approved body", async () => {
    const res = await HANDLERS["bulk_outbound.send"](
      decision({ body: vbody({ recipients: ["victim@elsewhere.com"], to: "victim2@elsewhere.com" }) }),
    );
    expect(res.ok).toBe(true);
    expect(sentTo(h.wire)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(JSON.stringify(res)).not.toContain("elsewhere.com");
  });

  it("has a plain label for a failure", () => {
    expect(HANDLER_LABELS["bulk_outbound.send"]).toBe("send the bulk email");
  });
});

describe('HANDLERS["bulk_outbound.send"] — the send cannot be started', () => {
  it("a freeze that fails with no send row is not started, and nothing says anyone was emailed", async () => {
    vi.spyOn(h.deps.store, "freeze").mockRejectedValueOnce(new Error("email_bulk_freeze_send failed"));
    const res = await HANDLERS["bulk_outbound.send"](decision());
    expect(res).toEqual({ ok: false, code: "bulk_send_not_started", error: "bulk_send_not_started" });
    expect(res.outcome_unknown).toBeUndefined();
    expect(sentTo(h.wire)).toEqual([]);
  });

  it("the retry after a failed freeze emails each person once", async () => {
    vi.spyOn(h.deps.store, "freeze").mockRejectedValueOnce(new Error("email_bulk_freeze_send failed"));
    await HANDLERS["bulk_outbound.send"](decision());
    const res = await HANDLERS["bulk_outbound.send"](decision());
    expect(res.ok).toBe(true);
    expect(sentTo(h.wire)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("a failure once the send row exists stays unknown, so it is never retried", async () => {
    vi.spyOn(h.deps.store, "settleSend").mockRejectedValueOnce(new Error("boom"));
    mocks.inngestSend.mockRejectedValueOnce(new Error("inngest down"));
    const res = await HANDLERS["bulk_outbound.send"](decision());
    expect(res).toMatchObject({ ok: false, outcome_unknown: true });
  });

  it("when the send row cannot be read it stays unknown", async () => {
    vi.spyOn(h.deps.store, "freeze").mockRejectedValueOnce(new Error("email_bulk_freeze_send failed"));
    vi.spyOn(h.deps.store, "sendIdForDecision").mockRejectedValueOnce(new Error("read failed"));
    const res = await HANDLERS["bulk_outbound.send"](decision());
    expect(res).toMatchObject({ ok: false, outcome_unknown: true });
  });
});

describe('HANDLERS["bulk_outbound.send"] — an end whose notice did not go out is retried on its own', () => {
  it("a released claim queues one retry of the notice, and the list is emailed once", async () => {
    vi.mocked(tellEmailSendOutcome).mockResolvedValueOnce("retry");
    const res = await HANDLERS["bulk_outbound.send"](decision());
    expect(res).toMatchObject({ ok: true, notice: "Sent to 3." });
    expect(sentTo(h.wire)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    const tells = mocks.inngestSend.mock.calls.map((c) => (c as unknown[])[0] as { id: string; name: string; data: Record<string, unknown> }).filter((e) => e.name === "email-send-outcome/tell.requested");
    expect(tells).toEqual([
      {
        id: `email-send-outcome-tell:decisions:${DECISION}:sent:`,
        name: "email-send-outcome/tell.requested",
        data: { tenant_id: TENANT, rail: "decisions", card_id: DECISION, outcome: "sent" },
      },
    ]);
    expect(mocks.rebuild).toHaveBeenCalledWith(TENANT, { rail: "decisions", card_id: DECISION, outcome: "sent" });
    expect(mocks.keep).not.toHaveBeenCalled();
    expect(mocks.inngestSend.mock.calls.filter((c) => ((c as unknown[])[0] as { name: string }).name === "bulk-email/fanout.requested")).toHaveLength(1);
    expectNoOtherSender();
  });

  it("a retry that cannot be queued never turns a sent email into a failed card", async () => {
    vi.mocked(tellEmailSendOutcome).mockResolvedValueOnce("retry");
    mocks.inngestSend.mockImplementation((async (e: { name: string }) => {
      if (e.name === "email-send-outcome/tell.requested") throw new Error("inngest down");
      return {};
    }) as never);
    const res = await HANDLERS["bulk_outbound.send"](decision());
    expect(res).toMatchObject({ ok: true });
    expect(sentTo(h.wire)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(mocks.keep).toHaveBeenCalledTimes(1);
    expect(mocks.keep).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, rail: "decisions", card_id: DECISION, outcome: "sent", sent: 3 }));
    mocks.inngestSend.mockImplementation(async () => ({}));
  });

  it("a card row owned by another tenant is never queued: the line is kept from the outcome in hand", async () => {
    vi.mocked(tellEmailSendOutcome).mockResolvedValueOnce("retry");
    mocks.rebuild.mockImplementation(async () => ({ o: { tenant_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", rail: "decisions", card_id: DECISION, outcome: "sent", sent: 3, total: 3 } }));
    await HANDLERS["bulk_outbound.send"](decision());
    expect(mocks.inngestSend.mock.calls.map((c) => ((c as unknown[])[0] as { name: string }).name)).toEqual(["bulk-email/fanout.requested"]);
    expect(mocks.keep).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, outcome: "sent" }));
  });

  it("a told or skipped end queues nothing", async () => {
    vi.mocked(tellEmailSendOutcome).mockResolvedValueOnce("told");
    await HANDLERS["bulk_outbound.send"](decision());
    expect(mocks.inngestSend.mock.calls.map((c) => ((c as unknown[])[0] as { name: string }).name)).toEqual(["bulk-email/fanout.requested"]);
    expect(mocks.rebuild).not.toHaveBeenCalled();
    expect(mocks.keep).not.toHaveBeenCalled();
  });
});

describe('HANDLERS["bulk_outbound.send"] — paths that send nothing', () => {
  it("a row nobody approved sends nothing", async () => {
    const res = await HANDLERS["bulk_outbound.send"](decision({ approved_by: null }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Not sent: This bulk email was not approved by a person. Nobody was emailed. (not_approved)");
    expect(h.wire).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
    expect(h.ledger.sends.size).toBe(0);
  });

  it("an approval stamped by Autopilot does not count: every bulk email needs a person's tap", async () => {
    const res = await HANDLERS["bulk_outbound.send"](decision({ approved_by: "owner-user", approved_by_source: "cgo" }));
    expect(res).toMatchObject({ ok: false, code: "not_approved" });
    expect(h.wire).not.toHaveBeenCalled();
  });

  it("must catch R9: a planned Auto send goes only when its own door says so; refused, nobody is emailed", async () => {
    mocks.door.mockResolvedValueOnce({ code: "planned_list_version_changed", sentence: "Autopilot did not send this planned email: the list was imported again." });
    const refused = await HANDLERS["bulk_outbound.send"](decision({ approved_by: "owner-user", approved_by_source: "plan_autopilot" }));
    expect(refused).toMatchObject({ ok: false, code: "planned_list_version_changed" });
    expect(h.wire).not.toHaveBeenCalled();
    expect(mocks.door).toHaveBeenCalledWith(TENANT, DECISION);
    mocks.door.mockResolvedValueOnce(null);
    const sent = await HANDLERS["bulk_outbound.send"](decision({ approved_by: "owner-user", approved_by_source: "plan_autopilot" }));
    expect(sent.ok).toBe(true);
    mocks.door.mockClear();
    await HANDLERS["bulk_outbound.send"](decision());
    expect(mocks.door).not.toHaveBeenCalled();
  });

  it("non-regression guard: a planned Auto send past its own door, with bulk email switched off since, emails nobody and leaves no send row", async () => {
    h.state.refusal = "bulk_outbound_disabled";
    const res = await HANDLERS["bulk_outbound.send"](decision({ approved_by_source: "plan_autopilot" }));
    expect(res).toMatchObject({ ok: false, code: "bulk_outbound_disabled" });
    expect(res.error).toContain("switched off");
    expect(h.wire).not.toHaveBeenCalled();
    expect(h.ledger.sends.size).toBe(0);
  });

  it("non-regression guard: a planned Auto send under an abuse hold emails nobody", async () => {
    h.state.refusal = "bulk_abuse_hold";
    const res = await HANDLERS["bulk_outbound.send"](decision({ approved_by_source: "plan_autopilot" }));
    expect(res).toMatchObject({ ok: false, code: "bulk_abuse_hold" });
    expect(h.wire).not.toHaveBeenCalled();
    expect(h.ledger.sends.size).toBe(0);
  });

  it("a refused send says why in the founder's words and does not invite a retry", async () => {
    h.state.refusal = "sending_domain_not_verified";
    const res = await HANDLERS["bulk_outbound.send"](decision());
    const notice = buildDispatchNotice({ handler: "bulk_outbound.send", ok: false, error: res.error });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("sending_domain_not_verified");
    expect(notice).toBe(
      "Not sent: Your sending domain is not verified yet, so bulk email cannot go out. In Email campaigns settings, add it if it is not there, then publish the DNS records shown for it and check it again. Nobody was emailed.",
    );
    expect(notice).not.toMatch(/couldn't|tell me to retry|sending_domain_not_verified/i);
    expect(h.wire).not.toHaveBeenCalled();
    expectNoOtherSender();
  });

  it("an old-shape draft (no contact list) still sends nothing, with the not-sent wording", async () => {
    const res = await HANDLERS["bulk_outbound.send"](
      decision({
        body: {
          selector: { segment: "lapsed_buyers" },
          template: { subject: "We saved your cart", body_text: "Come back and finish your order." },
          est_recipient_count: 3,
          sample_recipients: ["ada@customer.com"],
          basis: "opt_in",
        },
      }),
    );
    const notice = buildDispatchNotice({ handler: "bulk_outbound.send", ok: false, error: res.error });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("Not sent: bulk email is not switched on yet, so nobody was emailed. (bulk_outbound_send_gated)");
    expect(notice.startsWith(BULK_OUTBOUND_NOT_SENT_LINE)).toBe(true);
    expect(notice).toContain("retrying won't change that");
    expect(notice).not.toMatch(/couldn't|tell me to retry|bulk_outbound_send_gated/i);
    expect(h.wire).not.toHaveBeenCalled();
    expectNoOtherSender();
  });

  it("an incomplete bulk draft says the draft was incomplete", async () => {
    const res = await HANDLERS["bulk_outbound.send"](decision({ body: h.body({ template: { subject: "", body_text: "" } }) }));
    const notice = buildDispatchNotice({ handler: "bulk_outbound.send", ok: false, error: res.error });

    expect(res.error).toBe("Not sent: this bulk email draft was incomplete, so nobody was emailed. (bulk_outbound_invalid_body)");
    expect(notice).toBe("Not sent: this bulk email draft was incomplete, so nobody was emailed. Ask the agent to draft it again.");
    expect(h.wire).not.toHaveBeenCalled();
  });

  it("a text-only draft (no sealed versions) is refused on the send path, whoever approved it", async () => {
    const res = await HANDLERS["bulk_outbound.send"](decision({ body: h.body() }));
    expect(res).toMatchObject({ ok: false, code: "bulk_outbound_redraft_required" });
    expect(String(res.error)).toMatch(/Ask Zavi to draft it again/);
    expect(h.wire).not.toHaveBeenCalled();
  });

  it("a crash part-way never claims nobody was emailed, and never shows the raw error", async () => {
    vi.spyOn(h.deps.store, "settleSend").mockRejectedValueOnce(new Error("connection terminated unexpectedly for a@x.com"));
    mocks.inngestSend.mockRejectedValueOnce(new Error("inngest down"));
    const res = await HANDLERS["bulk_outbound.send"](decision());
    const notice = buildDispatchNotice({ handler: "bulk_outbound.send", ok: false, error: res.error });

    expect(res).toMatchObject({ ok: false, outcome_unknown: true });
    expect(res.error).not.toContain("connection terminated");
    expect(res.error).not.toContain("a@x.com");
    expect(notice).toBe(BULK_OUTBOUND_INTERRUPTED_LINE);
  });
});

describe('HANDLERS["bulk_outbound.send"] — the provider fails every email, so nothing is reported as sent', () => {
  const realKey = process.env.BULK_SENDGRID_API_KEY;
  beforeEach(() => {
    process.env.BULK_SENDGRID_API_KEY = "bulk-key";
  });
  afterEach(() => {
    if (realKey === undefined) delete process.env.BULK_SENDGRID_API_KEY;
    else process.env.BULK_SENDGRID_API_KEY = realKey;
  });

  const throughSendgrid = (answer: () => Promise<{ status: number }>) => {
    const fetch = vi.fn(answer);
    h.deps.wire = vi.fn((msg) => sendBulkEmail(msg, { fetch: fetch as never }));
    return fetch;
  };

  it.each([
    ["SendGrid answers 503 for every email", () => Promise.resolve({ status: 503 })],
    ["the SendGrid call fails on the network for every email", () => Promise.reject(new Error("The operation was aborted"))],
  ])("%s: the handler fails, the agent is not told it was sent, the approver is told it may have gone out", async (_label, answer) => {
    const fetch = throughSendgrid(answer);

    const res = await HANDLERS["bulk_outbound.send"](decision());
    const notice = buildDispatchNotice({ handler: "bulk_outbound.send", ok: res.ok, error: res.error, notice: res.notice });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(res.ok).toBe(false);
    expect(res.agent_outcome).toBeUndefined();
    expect(res.code).toBe("bulk_outbound_unconfirmed");
    expect(notice).not.toMatch(/^Sent\b|Sent to|✅|Done/);
    expect(notice).toMatch(/^Not confirmed:/);
    expect(notice).toMatch(/may have gone out/);
    expect(notice).toMatch(/will not send this email again/);
    expect(notice).toMatch(/3 could not be confirmed/);
    expect(notice).not.toMatch(/nobody was emailed|Not sent/i);
    expect(notice).not.toMatch(/@/);
    const told = vi.mocked(tellEmailSendOutcome).mock.calls.map((c) => c[0]);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ outcome: "unknown", sent: 0, total: 3 });
    const sendId = [...h.ledger.sends.keys()][0];
    expect(h.ledger.statuses(sendId)).toEqual({ unknown: 3 });
  });

  it("a retry of the same card after SendGrid timed out on every email sends nobody again, and is never told 'not sent'", async () => {
    const fetch = throughSendgrid(() => Promise.reject(new Error("The operation was aborted")));
    const first = await HANDLERS["bulk_outbound.send"](decision());
    expect(first.code).toBe("bulk_outbound_unconfirmed");
    expect(fetch).toHaveBeenCalledTimes(3);

    fetch.mockImplementation(() => Promise.resolve({ status: 202 }));
    const [again, raced] = await Promise.all([HANDLERS["bulk_outbound.send"](decision()), HANDLERS["bulk_outbound.send"](decision())]);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect([...h.ledger.sends.keys()]).toHaveLength(1);
    const sendId = [...h.ledger.sends.keys()][0];
    expect(h.ledger.statuses(sendId)).toEqual({ unknown: 3 });
    for (const r of [again, raced]) {
      expect(r.ok).toBe(false);
      expect(String(r.error)).not.toMatch(/Not sent|nobody was emailed/i);
    }
    const told = vi.mocked(tellEmailSendOutcome).mock.calls.map((c) => c[0]);
    expect(told.every((o) => o.outcome === "unknown")).toBe(true);
  });

  it("one email confirmed and two unconfirmed is still a send: the counts say which", async () => {
    let n = 0;
    throughSendgrid(() => Promise.resolve({ status: n++ === 0 ? 202 : 503 }));

    const res = await HANDLERS["bulk_outbound.send"](decision());

    expect(res.ok).toBe(true);
    expect(res.notice).toBe("Sent to 1. 2 could not be confirmed, so they were not sent again.");
    expect(vi.mocked(tellEmailSendOutcome).mock.calls[0][0]).toMatchObject({ outcome: "sent", sent: 1 });
  });

  it("everyone on the list was skipped: nobody was emailed, and it is not reported as sent", async () => {
    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) h.ledger.block(TENANT, e);

    const res = await HANDLERS["bulk_outbound.send"](decision());
    const notice = buildDispatchNotice({ handler: "bulk_outbound.send", ok: res.ok, error: res.error, notice: res.notice });

    expect(h.wire).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.agent_outcome).toBeUndefined();
    expect(notice).toMatch(/^Not sent:/);
    expect(notice).toMatch(/nobody was emailed/i);
    expect(notice).not.toMatch(/Sent to/);
    expect(vi.mocked(tellEmailSendOutcome).mock.calls[0][0]).toMatchObject({ outcome: "failed", sent: 0 });
  });
});
