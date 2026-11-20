import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

import { emailCardHandlers } from "@/routes/email-cards";
import { makeProposeCampaignTool, type ProposeCampaignDeps } from "@/services/tools/email/propose_campaign";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { sendgridKeyDigest } from "@/services/connectors/email-campaign/credential";
import { checkingLaterSentence, executeEmailCampaignSendAndTell, OUTCOME_UNKNOWN_SUFFIX, type EmailSendDeps } from "@/services/connectors/email-campaign/execute-send";
import { reconcileEmailSend } from "@/services/connectors/email-campaign/reconcile";
import { reconcileDecisionEmailSend, type DecisionSendRow, type DecisionSettle } from "@/services/connectors/email-campaign/reconcile-decision";
import { BRIGHTLOOP_KEY, fakeSendgrid, type FakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";
import { runDecisionEmailReconcilePass, runReconcileLoop } from "@/../workers/functions/reconcile-channel-action-exec";
import type { EmailTemplate, EmailContent } from "@/services/email-templates/render";
import type { CardDeps } from "../cards";
import { tellEmailSendOutcome, type EmailSendOutcomeKind, type SendOutcome } from "../outcome";
import { tellEmailSendOutcomeOrQueue } from "../outcome-tell";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";
const DIGEST = sendgridKeyDigest(BRIGHTLOOP_KEY);
const SG_LIST = "6a1f0c2e-0000-4000-8000-00000000b001";
const T = "11111111-1111-4111-8111-111111111111";
const DEC = "55555555-5555-4555-8555-555555555555";
const OWNER = "brightloop-owner@yopmail.com";
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

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

async function view(o: { status: string; card: Record<string, unknown>; results?: Record<string, unknown> | null }) {
  mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-owner" });
  const deps: Partial<CardDeps> = {
    rpc: (async (_t: string, name: string) => {
      if (name === "email_card_view_state") {
        return { ok: true, class: "email_campaign.create_and_send", body: { tool: "sendgrid", list_name: "Members", variants: [], chosen_variant: 1 }, open: false, status: o.status, role: "owner", versions: 1, tests: [], retryable: false, failure_reason: null };
      }
      if (name === "email_card_send_facts") return { card: o.card, bulk: null, results: o.results ?? null };
      if (name === "email_planned_for_card") return null;
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    liveCount: async () => 10,
    confirmedEmail: async () => OWNER,
    enqueue: async () => {},
    groupName: async () => null,
    ...({ paused: async () => false } as Partial<CardDeps>),
  };
  const h = emailCardHandlers(deps, async () => new Set<string>(), (async () => null) as never);
  const r = res();
  await h.view({ params: { rail: "decisions", id: DEC }, body: {} } as never, r as never);
  expect(r.statusCode).toBe(200);
  return r.body.card;
}

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

const aborted = () => new DOMException("The operation was aborted.", "AbortError");

type World = {
  sg: FakeSendgrid;
  row: DecisionSendRow;
  body: Record<string, unknown>;
  sendResult: Awaited<ReturnType<typeof executeEmailCampaignSendAndTell>>;
  queued: string[];
  toldAtSend: SendOutcome[];
};

async function sendThatTimesOut(landed: boolean): Promise<World> {
  const sg = fakeSendgrid();
  const emit = vi.fn(async (_cls: string, _body: unknown) => DEC);
  await makeProposeCampaignTool(sgDeps(sg)).execute({ tenant_id: T, log: () => {}, emit_decision: emit } as never, { route: "sendgrid", audience_id: SG_LIST, variants: [version] });
  const { rationale: _r, ...proposed } = emit.mock.calls[0][1] as Record<string, unknown>;
  const body = { ...proposed, chosen_variant: 1 };
  let down = false;
  const timingOut = (async (input: string | URL, init?: RequestInit) => {
    if (down) throw aborted();
    const isSchedule = (init?.method ?? "GET") === "PUT" && new URL(String(input)).pathname.endsWith("/schedule");
    if (isSchedule && !landed) {
      down = true;
      throw aborted();
    }
    const answer = await sg.fetch(input, init);
    if (isSchedule) {
      down = true;
      throw aborted();
    }
    return answer;
  }) as unknown as typeof fetch;
  const refs: string[] = [];
  const queued: string[] = [];
  const toldAtSend: SendOutcome[] = [];
  const deps: Partial<EmailSendDeps> = {
    resolveAccount: (async () => {
      throw new Error("composio must not be called for SendGrid");
    }) as unknown as EmailSendDeps["resolveAccount"],
    exec: (async () => {
      throw new Error("composio must not be called for SendGrid");
    }) as unknown as EmailSendDeps["exec"],
    resolveSendgrid: async () => ({ api_key: BRIGHTLOOP_KEY, key_digest: DIGEST }),
    sendgridFetch: timingOut,
    readProgress: async () => null,
    recordProgress: async () => true,
    scheduleReconcile: async () => {
      throw new Error("the decisions rail has no claim: the channel reconcile must not be queued");
    },
    scheduleDecisionReconcile: async (id: string) => {
      queued.push(id);
    },
    recordSendRef: async (_t: string, _id: string, _tool: string, ref: string) => {
      refs.push(ref);
      return true;
    },
    authorizeCgo: (async () => ({ verdict: "allow", reasons: [] })) as unknown as EmailSendDeps["authorizeCgo"],
    notifyAutopilotSend: (async () => true) as unknown as EmailSendDeps["notifyAutopilotSend"],
    testListKeys: async () => new Set<string>(),
    sleep: async () => {},
    paused: async () => false,
  };
  const sendResult = await executeEmailCampaignSendAndTell({ id: DEC, tenant_id: T, body, approved_by_source: null } as never, deps, async (o) => toldAtSend.push(o));
  const row: DecisionSendRow = {
    tenant_id: T,
    decision_class: "email_campaign.create_and_send",
    status: "dispatching",
    dispatch_error: `${sendResult.error}${OUTCOME_UNKNOWN_SUFFIX}`,
    body,
    ref: refs.at(-1) ?? null,
  };
  return { sg, row, body, sendResult, queued, toldAtSend };
}

function reconcileHarness(w: World) {
  const settles: DecisionSettle[] = [];
  const marked: Array<{ settlesBefore: number }> = [];
  const claims = new Set<string>();
  const lines: Array<{ outcome: EmailSendOutcomeKind; line: string }> = [];
  const started: SendOutcome[] = [];
  const mailed: Array<{ to: string; subject: string }> = [];
  const pass = (n: number) =>
    reconcileDecisionEmailSend(
      DEC,
      { finalPass: n >= 1, lastPass: n >= 4 },
      {
        readRow: async () => ({ ...w.row }),
        markNotSent: async () => {
          marked.push({ settlesBefore: settles.length });
          return true;
        },
        settle: async (tenantId, id, patch) => {
          expect(tenantId).toBe(T);
          expect(id).toBe(DEC);
          if (w.row.status !== "dispatching") return false;
          settles.push(patch);
          w.row = { ...w.row, status: patch.status, dispatch_error: patch.dispatch_error };
          return true;
        },
        reconcile: (id, t, opts, deps) =>
          reconcileEmailSend(id, t, opts, {
            ...deps,
            resolveAccount: (async () => {
              throw new Error("composio must not be called for SendGrid");
            }) as never,
            exec: (async () => {
              throw new Error("composio must not be called for SendGrid");
            }) as never,
            resolveSendgrid: async () => ({ api_key: BRIGHTLOOP_KEY, key_digest: DIGEST }),
            sendgridFetch: w.sg.fetch,
            notifyAutopilotSend: (async () => {
              throw new Error("a founder-approved card is not an Autopilot send");
            }) as never,
          }),
        tell: (o) =>
          tellEmailSendOutcomeOrQueue(o, {
            tell: (x) =>
              tellEmailSendOutcome(x, {
                readCard: async (_t, rail, id) => (rail === "decisions" && id === DEC ? { body: w.body, approved_by: "u-owner", approved_by_source: null } : null),
                claim: async (_t, rail, id, outcome, line, kind) => {
                  const k = `${rail}:${id}:${outcome}:${kind ?? ""}`;
                  if (claims.has(k)) return false;
                  claims.add(k);
                  lines.push({ outcome, line });
                  return true;
                },
                release: async () => {},
                emailOf: async () => OWNER,
                ownerEmail: async () => OWNER,
                send: async (to, subject) => {
                  mailed.push({ to, subject });
                },
                startResults: async (x) => {
                  started.push(x);
                },
              }),
            enqueue: async () => {
              throw new Error("the outcome was told inline: nothing to queue");
            },
          }),
      },
    );
  return { pass, settles, marked, lines, started, mailed };
}

describe("a chat-proposed tool send whose outcome is unknown is checked later, not closed", () => {
  it("queues the decisions reconcile, records the campaign it sent, and does not tell 'unknown' yet", async () => {
    const w = await sendThatTimesOut(true);

    expect(w.sg.count("PUT", /\/schedule$/)).toBe(1);
    expect(w.sendResult).toMatchObject({ ok: false, outcome_unknown: true, code: "exec_outcome_unknown", reconcile_queued: true });
    expect(w.sendResult.error).toBe(checkingLaterSentence("SendGrid"));
    expect(w.queued).toEqual([DEC]);
    expect(w.toldAtSend).toEqual([]);
    expect(w.row.ref).toBe(w.sg.sends[0].id);
  });

  it("the card reads 'checking' (reconciliation_pending) while the check is queued, and stops polling once the check window has passed", async () => {
    const w = await sendThatTimesOut(true);

    const fresh = await view({ status: "dispatching", card: { status: "dispatching", approved: true, dispatched_at: ago(1), error: w.row.dispatch_error } });
    expect(fresh.status).toBe("outcome_unknown");
    expect(fresh.reconciliation_pending).toBe(true);
    expect(fresh.may_have_sent).toBe(true);
    expect(fresh.retryable).toBe(false);
    expect(String(fresh.failure_reason)).toMatch(/checks SendGrid in a few minutes/);

    const late = await view({ status: "dispatching", card: { status: "dispatching", approved: true, dispatched_at: ago(90), error: w.row.dispatch_error } });
    expect(late.status).toBe("outcome_unknown");
    expect(late.reconciliation_pending).toBe(false);

    const plain = await view({ status: "dispatching", card: { status: "dispatching", approved: true, dispatched_at: ago(1) } });
    expect(plain.status).toBe("dispatching");
    expect(plain.reconciliation_pending).toBe(false);
  });

  it("a check that reads the send as gone out settles 'acted', starts results and tells 'sent' exactly once, and never sends again", async () => {
    const w = await sendThatTimesOut(true);
    const h = reconcileHarness(w);

    const first = await h.pass(0);
    const second = await h.pass(1);
    const third = await h.pass(4);

    expect(first).toEqual({ done: true, outcome: "sent" });
    expect(second).toEqual({ done: true, outcome: "nothing_to_do" });
    expect(third).toEqual({ done: true, outcome: "nothing_to_do" });
    expect(h.settles).toEqual([{ status: "acted", dispatch_error: null }]);
    expect(w.row.status).toBe("acted");
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ tenant_id: T, rail: "decisions", card_id: DEC, outcome: "sent" });
    expect(h.lines.map((l) => l.outcome)).toEqual(["sent"]);
    expect(h.mailed).toHaveLength(1);
    expect(h.mailed[0].to).toBe(OWNER);
    expect(w.sg.count("PUT", /\/schedule$/)).toBe(1);
    expect(w.sg.count("POST", /\/v3\/marketing\/singlesends$/)).toBe(1);

    const card = await view({ status: "acted", card: { status: "acted", approved: true, dispatched_at: ago(7), error: null } });
    expect(card.status).toBe("sent");
    expect(card.reconciliation_pending).toBe(false);
  });

  it("a check that reads the campaign still a draft waits one pass, then settles 'dispatch_failed' (not sent), tells 'failed' once and starts no results", async () => {
    const w = await sendThatTimesOut(false);
    expect(w.sg.sends.map((s) => s.status)).toEqual(["draft"]);
    expect(w.queued).toEqual([DEC]);
    const h = reconcileHarness(w);

    const early = await h.pass(0);
    expect(early).toEqual({ done: false, outcome: "too_early" });
    expect(h.settles).toEqual([]);

    const final = await h.pass(1);
    const again = await h.pass(2);

    expect(final).toEqual({ done: true, outcome: "not_sent" });
    expect(again).toEqual({ done: true, outcome: "nothing_to_do" });
    expect(h.settles).toHaveLength(1);
    expect(h.settles[0].status).toBe("dispatch_failed");
    expect(h.settles[0].dispatch_error).toMatch(/^This email was not sent\./);
    expect(h.marked).toEqual([{ settlesBefore: 0 }]);
    expect(h.settles[0].dispatch_error).not.toContain(OUTCOME_UNKNOWN_SUFFIX);
    expect(h.lines.map((l) => l.outcome)).toEqual(["failed"]);
    expect(h.started).toEqual([]);
    expect(h.mailed).toHaveLength(1);
    expect(w.sg.count("PUT", /\/schedule$/)).toBe(0);

    const card = await view({ status: "dispatch_failed", card: { status: "dispatch_failed", approved: true, dispatched_at: ago(13), error: w.row.dispatch_error } });
    expect(card.status).toBe("failed");
    expect(card.reconciliation_pending).toBe(false);
    expect(card.may_have_sent).toBe(false);
  });

  it("a row no longer waiting on the check (already settled, or another class) is left alone", async () => {
    const w = await sendThatTimesOut(true);
    w.row = { ...w.row, status: "dispatch_failed" };
    const h = reconcileHarness(w);
    expect(await h.pass(1)).toEqual({ done: true, outcome: "nothing_to_do" });
    w.row = { ...w.row, status: "dispatching", dispatch_error: "Something else." };
    expect(await h.pass(1)).toEqual({ done: false, outcome: "in_flight" });
    expect(await h.pass(4)).toEqual({ done: true, outcome: "nothing_to_do" });
    expect(h.settles).toEqual([]);
    expect(h.lines).toEqual([]);
  });

  it("a check that reads the row before the send marked it unknown waits for a later pass instead of dropping the card", async () => {
    const w = await sendThatTimesOut(true);
    const marked = w.row;
    w.row = { ...marked, dispatch_error: null };
    const h = reconcileHarness(w);
    expect(await h.pass(0)).toEqual({ done: false, outcome: "in_flight" });
    expect(await h.pass(1)).toEqual({ done: false, outcome: "in_flight" });
    expect(h.settles).toEqual([]);
    w.row = marked;
    const settled = await h.pass(2);
    expect(settled.done).toBe(true);
    expect(h.settles).toHaveLength(1);
    expect(h.settles[0].status).toBe("acted");
    expect(h.lines.map((l) => l.outcome)).toEqual(["sent"]);
  });

  it("the worker loop drives the decisions check with the channel loop's pass schedule and stops once it settles", async () => {
    const w = await sendThatTimesOut(false);
    const h = reconcileHarness(w);
    const slept: string[] = [];
    const seen: Array<{ finalPass: boolean; lastPass: boolean }> = [];
    const out = await runReconcileLoop(
      DEC,
      { sleep: async (id) => slept.push(id), run: (_id, fn) => fn() },
      (n) =>
        runDecisionEmailReconcilePass(DEC, n, async (id, opts) => {
          seen.push(opts);
          return h.pass(opts.finalPass ? 1 : 0);
        }),
    );
    expect(out).toEqual({ ok: true, outcome: "not_sent", passes: 2 });
    expect(slept).toEqual(["wait-0", "wait-1"]);
    expect(seen).toEqual([
      { finalPass: false, lastPass: false },
      { finalPass: true, lastPass: false },
    ]);
    expect(h.settles.map((s) => s.status)).toEqual(["dispatch_failed"]);
  });
});
