import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/email-send-tier", async (orig) => ({ ...(await orig<typeof import("@/services/agents/email-send-tier")>()), emailSendHttpRefusal: async () => null }));

import { emailCardHandlers } from "@/routes/email-cards";
import { emailPauseHandlers } from "@/routes/workspace/email-pause";
import type { CardDeps } from "../cards";

const T = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

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

type Facts = Record<string, unknown> | null;
function harness(o: { cls?: string; status?: string; facts?: Facts; count?: number | null; stop?: Record<string, unknown>; approve?: Record<string, unknown>; role?: string; paused?: boolean | null } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const enqueued: unknown[] = [];
  const deps: Partial<CardDeps> = {
    rpc: (async (_t: string, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "email_card_view_state") {
        return { ok: true, class: o.cls ?? "bulk_outbound.send", body: { list_name: "Members", variants: [], chosen_variant: 1 }, open: false, status: o.status ?? "acted", role: o.role ?? "owner", versions: 1, tests: [], retryable: false, failure_reason: null };
      }
      if (name === "email_card_send_facts") return o.facts ?? null;
      if (name === "email_planned_for_card") return null;
      if (name === "email_bulk_stop_send") return o.stop ?? { ok: true, stopped: 280, already_sent: 120 };
      if (name === "approve_email_card") return o.approve ?? { ok: true };
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    liveCount: async () => (o.count === undefined ? 10 : o.count),
    confirmedEmail: async () => "owner@brightloop.test",
    enqueue: async (e) => {
      enqueued.push(e);
    },
    groupName: async () => null,
    senderStop: async () => "stopped",
    ...(o.paused !== undefined
      ? {
          paused: async () => {
            if (typeof o.paused !== "boolean") throw new Error("email_send_paused failed");
            return o.paused;
          },
        }
      : {}),
  };
  const h = emailCardHandlers(deps, async () => new Set<string>(), (async () => null) as never);
  return { h, calls, enqueued };
}
const as = (user = "u-owner") => mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: user });
const req = (rail = "decisions", body: unknown = {}) => ({ params: { rail, id: CARD }, body }) as never;
const bulk = (over: Record<string, unknown> = {}) => ({ status: "sending", hold_reason: null, total: 400, sent: 120, skipped: 3, failed: 0, unknown: 0, hard_bounces: 2, created_at: ago(30), finished_at: null, next_run_at: null, ...over });

async function view(o: Parameters<typeof harness>[0], rail = "decisions") {
  as();
  const { h } = harness(o);
  const r = res();
  await h.view(req(rail), r as never);
  expect(r.statusCode).toBe(200);
  return r.body.card;
}

describe("GET /api/email-cards/:rail/:id: the send state the card shows", () => {
  it("a Zavi-list send going out: sending, the count so far, bounces, and the viewer's own address", async () => {
    const card = await view({ facts: { card: { status: "acted", approved: true }, bulk: bulk(), results: null } });
    expect(card).toMatchObject({ status: "sending", sent_count: 120, sent_at: null, retryable: false, results: { delivered: null, opens: null, clicks: null, bounces: 2 }, viewer_email: "owner@brightloop.test" });
  });

  it.each([
    [bulk({ status: "waiting_for_tomorrow", next_run_at: ago(-600) }), "waiting_for_tomorrow"],
    [bulk({ status: "held", hold_reason: "stopped" }), "stopped"],
    [bulk({ status: "held", hold_reason: "email_paused" }), "held"],
    [bulk({ status: "done", sent: 400, finished_at: ago(5) }), "sent"],
    [bulk({ status: "done", sent: 390, failed: 10, finished_at: ago(5) }), "partially_sent"],
    [bulk({ status: "done", sent: 0, unknown: 400, finished_at: ago(5) }), "outcome_unknown"],
    [bulk({ status: "done", sent: 0, skipped: 400, finished_at: ago(5) }), "not_sent"],
    [bulk({ status: "failed", sent: 0 }), "failed"],
  ])("bulk %o reads as %s", async (b, status) => {
    const card = await view({ facts: { card: { status: "acted", approved: true }, bulk: b, results: null } });
    expect(card.status).toBe(status);
  });

  it("a held send says why; a finished one says when", async () => {
    expect((await view({ facts: { card: { status: "acted", approved: true }, bulk: bulk({ status: "held", hold_reason: "email_paused" }), results: null } })).failure_reason).toMatch(/^Email is paused for this workspace/);
    const done = await view({ facts: { card: { status: "acted", approved: true }, bulk: bulk({ status: "done", sent: 400, finished_at: "2026-10-16T10:00:00.000Z" }), results: null } });
    expect(done).toMatchObject({ status: "sent", sent_at: "2026-10-16T10:00:00.000Z", sent_count: 400 });
  });

  it.each([
    ["bulk_sending_paused", "Zavi's own sender was stopped for every workspace"],
    ["sending_address_not_verified", "your sending address isn't verified with the email provider any more"],
  ])("a %s hold nobody can resume reads as final, with why and how many got it", async (hold, why) => {
    const card = await view({ facts: { card: { status: "acted", approved: true }, bulk: bulk({ status: "held", hold_reason: hold, sent: 120 }), results: null } });
    expect(card).toMatchObject({ status: "partially_sent", sent_count: 120, retryable: false, failure_reason: `Zavi stopped this send: ${why}. 120 people got it; the rest will not.` });
    const none = await view({ facts: { card: { status: "acted", approved: true }, bulk: bulk({ status: "held", hold_reason: hold, sent: 0 }), results: null } });
    expect(none).toMatchObject({ status: "not_sent", sent_count: 0, failure_reason: `Zavi stopped this send: ${why}. Nobody was emailed.` });
    const unsure = await view({ facts: { card: { status: "acted", approved: true }, bulk: bulk({ status: "held", hold_reason: hold, sent: 0, unknown: 4 }), results: null } });
    expect(unsure).toMatchObject({ status: "outcome_unknown", may_have_sent: true });
    const some = await view({ facts: { card: { status: "acted", approved: true }, bulk: bulk({ status: "held", hold_reason: hold, sent: 120, unknown: 3 }), results: null } });
    expect(some).toMatchObject({ status: "outcome_unknown", may_have_sent: true, sent_count: 120, retryable: false });
    expect(some.failure_reason).toBe(`Zavi stopped this send: ${why}. 120 people got it, and 3 more may have: the email provider did not confirm them. Zavi will not send this email again, so nobody gets it twice.`);
    expect(some.failure_reason).not.toContain("the rest will not");
  });

  it("a send the founder stopped: never 'stopped after 0 people', and unconfirmed emails are never hidden behind 'the rest were not sent'", async () => {
    const at = (over: Record<string, unknown>) => view({ facts: { card: { status: "acted", approved: true }, bulk: bulk({ status: "held", hold_reason: "stopped", skipped: 280, ...over }), results: null } });
    const before = await at({ sent: 0 });
    expect(before).toMatchObject({ status: "not_sent", sent_count: 0, may_have_sent: false, failure_reason: "You stopped this send before it reached anyone. Nobody was emailed." });
    const some = await at({ sent: 120, unknown: 3 });
    expect(some).toMatchObject({ status: "outcome_unknown", may_have_sent: true, sent_count: 120, retryable: false });
    expect(some.failure_reason).toBe("You stopped this send. 120 people got it, and 3 more may have: the email provider did not confirm them. Zavi will not send this email again, so nobody gets it twice.");
    const none = await at({ sent: 0, unknown: 1 });
    expect(none).toMatchObject({ status: "outcome_unknown", may_have_sent: true, sent_count: 0 });
    expect(none.failure_reason).toBe("You stopped this send. 1 person may have got it: the email provider did not confirm them. Zavi will not send this email again, so nobody gets it twice.");
    const clean = await at({ sent: 120 });
    expect(clean).toMatchObject({ status: "stopped", sent_count: 120, may_have_sent: false, failure_reason: null });
  });

  it.each([
    ["abuse_complaints", "too many people marked this email as spam"],
    ["abuse_bounces", "too many of these addresses bounced"],
    ["provider_refused", "the email provider refused to send from your domain"],
    ["bulk_check_failed", "we could not check that it was still safe to send"],
  ])("a %s hold stays on hold and says only staff can resume it", async (hold, why) => {
    const card = await view({ facts: { card: { status: "acted", approved: true }, bulk: bulk({ status: "held", hold_reason: hold, sent: 120 }), results: null } });
    expect(card).toMatchObject({ status: "held", sent_count: 120, failure_reason: `Zavi stopped this send: ${why}. The rest will not go out unless Zavi staff resumes it.` });
  });

  it("a staff hold with nobody left reads as final, not as waiting on staff", async () => {
    const card = await view({ facts: { card: { status: "acted", approved: true }, bulk: bulk({ status: "held", hold_reason: "provider_refused", total: 123, sent: 120 }), results: null } });
    expect(card.status).toBe("partially_sent");
    expect(card.failure_reason).not.toMatch(/staff/);
  });

  it("a founder's email pause stays on hold with no word of staff", async () => {
    const card = await view({ facts: { card: { status: "acted", approved: true }, bulk: bulk({ status: "held", hold_reason: "email_paused", sent: 1 }), results: null } });
    expect(card.status).toBe("held");
    expect(card.failure_reason).not.toMatch(/Zavi stopped this send|staff/);
  });

  it("every hold the card keeps as held is one the admin resume script accepts, or email_paused", async () => {
    const { RESUMABLE_HOLDS } = await import("@/services/admin-scripts/bulk-email");
    const { holdCanResume } = await import("../cards");
    for (const hold of RESUMABLE_HOLDS) expect(holdCanResume(hold)).toBe(true);
    for (const hold of ["bulk_sending_paused", "sending_address_not_verified", "fanout_stalled", "list_archived", null]) expect(holdCanResume(hold)).toBe(false);
  });

  it("a decisions-rail dispatch_failed reads as failed with its reason", async () => {
    const card = await view({ status: "dispatch_failed", facts: { card: { status: "dispatch_failed", approved: true, error: "Not sent: That contact list was archived. Nobody was emailed. (list_archived)" }, bulk: null, results: null } });
    expect(card).toMatchObject({ status: "failed", failure_reason: "Not sent: That contact list was archived. Nobody was emailed.", retryable: false });
  });

  it("a released claim reads as queued, and offers Try again only once it is genuinely stuck", async () => {
    const fresh = await view({ status: "proposed", facts: { card: { status: "proposed", approved: true, dispatched_at: ago(3) }, bulk: null, results: null } });
    expect(fresh).toMatchObject({ status: "queued", retryable: false });
    const stuck = await view({ status: "proposed", facts: { card: { status: "proposed", approved: true, dispatched_at: ago(40) }, bulk: null, results: null } });
    expect(stuck).toMatchObject({ status: "queued", retryable: true });
    const approved = await view({ status: "approved", facts: { card: { status: "approved", approved: true, approved_at: ago(2) }, bulk: null, results: null } });
    expect(approved).toMatchObject({ status: "approved", retryable: false });
  });

  it("a bulk card released because Zavi's sender was stopped reads as held, says nothing was sent, and offers Send now", async () => {
    const row = { status: "proposed", approved: true, approved_at: ago(1), dispatched_at: ago(1), error: "bulk_sending_paused" };
    for (const paused of [false, null]) {
      const card = await view({ status: "proposed", paused, facts: { card: row, bulk: null, results: null } });
      expect(card).toMatchObject({ status: "held", retryable: true, pause_hold: null, may_have_sent: false, sent_count: null });
      expect(card.failure_reason).toMatch(/^Zavi sender stopped: /);
      expect(card.failure_reason).toContain("nothing was sent");
      expect(card.status).not.toBe("queued");
    }
    const later = await view({ status: "proposed", paused: false, facts: { card: { ...row, approved_at: ago(40), dispatched_at: ago(40) }, bulk: null, results: null } });
    expect(later).toMatchObject({ status: "held", retryable: true });
  });

  it("a claim released by a workspace email pause keeps its paused and resumed reads", async () => {
    const row = { status: "proposed", approved: true, approved_at: ago(1), dispatched_at: ago(1), error: "email_paused" };
    expect(await view({ status: "proposed", paused: true, facts: { card: row, bulk: null, results: null } })).toMatchObject({ status: "queued", pause_hold: "paused", retryable: false, failure_reason: null });
    expect(await view({ status: "proposed", paused: false, facts: { card: row, bulk: null, results: null } })).toMatchObject({ status: "queued", pause_hold: "resumed", retryable: false, failure_reason: null });
  });

  it("a channel card that went out: sent, when, how many, and its hour-1 and day-7 results", async () => {
    const card = await view(
      {
        cls: "email_campaign.create_and_send",
        status: "executed",
        facts: {
          card: { status: "pending", exec_status: "executed", approved: true, executed_at: "2026-10-15T09:00:00.000Z", receipt: { line: "Sent to 1,204 people via SendGrid" } },
          bulk: null,
          results: { sent_count: 1204, finished_at: "2026-10-15T09:01:00.000Z", h1: { delivered: 1190, opens: 300, clicks: 20 }, d7: { delivered: 1195, opens: 610, clicks: 55, bounces: 9 }, d7_published: true },
        },
      },
      "channel_actions",
    );
    expect(card).toMatchObject({
      status: "sent",
      sent_at: "2026-10-15T09:00:00.000Z",
      sent_count: 1204,
      results: { delivered: 1195, opens: 610, clicks: 55, bounces: 9 },
      hour_1: { delivered: 1190, opens: 300, clicks: 20, bounces: null },
      day_7: { delivered: 1195, opens: 610, clicks: 55, bounces: 9 },
    });
  });

  it.each([
    [{ code: "exec_outcome_unknown" }, true],
    [{ code: "exec_partial" }, true],
    [{ code: "email_tool_refused", bucket: "partial_risk" }, true],
    [{ code: "exec_partial", not_sent: true }, false],
    [{ code: "email_tool_not_connected" }, false],
  ])("a failed channel card with %o: may_have_sent is %s, so the card never says it was not sent when it may have gone", async (result, may) => {
    const card = await view({ cls: "email_campaign.create_and_send", status: "failed", facts: { card: { status: "pending", exec_status: "failed", approved: true, ...result }, bulk: null, results: null } }, "channel_actions");
    expect(card.may_have_sent).toBe(may);
    expect(card.reconciliation_pending).toBe((result as { code?: string }).code === "exec_outcome_unknown");
  });

  it("a channel card that ended in exec_partial with people counted reads as may have gone out, with the count so far and never 'the rest will not'", async () => {
    const error = "Mailchimp refused to send this: the account is on hold. Zavi could not read the campaign back to confirm nothing went out. Check it in Mailchimp; Zavi will not send it again.";
    const card = await view(
      {
        cls: "email_campaign.create_and_send",
        status: "failed",
        facts: {
          card: { status: "pending", exec_status: "failed", approved: true, code: "exec_partial", error },
          bulk: null,
          results: { sent_count: 1204, finished_at: "2026-10-15T09:01:00.000Z", h1: {}, d7: {}, d7_published: false },
        },
      },
      "channel_actions",
    );
    expect(card).toMatchObject({
      status: "failed",
      sent_count: 1204,
      sent_at: "2026-10-15T09:01:00.000Z",
      retryable: false,
      may_have_sent: true,
      reconciliation_pending: false,
      failure_reason: `${error} The email tool reports 1,204 people got it so far.`,
    });
    const one = await view(
      { cls: "email_campaign.create_and_send", status: "failed", facts: { card: { status: "pending", exec_status: "failed", approved: true, code: "exec_partial" }, bulk: null, results: { sent_count: 1, finished_at: "2026-10-15T09:01:00.000Z", h1: {}, d7: {}, d7_published: false } } },
      "channel_actions",
    );
    expect(one).toMatchObject({ status: "failed", may_have_sent: true, failure_reason: "The email tool reports 1 person got it so far." });
    const none = await view(
      { cls: "email_campaign.create_and_send", status: "failed", facts: { card: { status: "pending", exec_status: "failed", approved: true, code: "exec_partial", not_sent: true, error }, bulk: null, results: { sent_count: 0, finished_at: "2026-10-15T09:01:00.000Z", h1: {}, d7: {}, d7_published: false } } },
      "channel_actions",
    );
    expect(none.status).toBe("not_sent");
  });

  it("a channel card closed as not sent reads as not_sent", async () => {
    const card = await view({ cls: "email_campaign.create_and_send", status: "failed", facts: { card: { status: "pending", exec_status: "failed", approved: true, code: "not_sent_confirmed", error: "You checked your email tool: it was not sent." }, bulk: null, results: null } }, "channel_actions");
    expect(card.status).toBe("not_sent");
  });
});

describe("GET /count", () => {
  it("returns {people}; an unreadable count is a 409 definite refusal, not a 5xx", async () => {
    as();
    let { h } = harness({ count: 238 });
    let r = res();
    await h.count(req(), r as never);
    expect(r.body).toEqual({ people: 238 });
    ({ h } = harness({ count: null }));
    r = res();
    await h.count(req(), r as never);
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toMatchObject({ code: "count_required", message: expect.any(String) });
  });
});

describe("POST /api/email-cards/:rail/:id/stop", () => {
  it("a Zavi-list send: 200 {stopped, already_sent}", async () => {
    as();
    const { h, calls } = harness({});
    const r = res();
    await h.stop(req(), r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ stopped: 280, already_sent: 120 });
    expect(calls.find((c) => c.name === "email_bulk_stop_send")!.args).toEqual({ p_actor_user_id: "u-owner", p_decision_id: CARD });
  });

  it("not stoppable (finished, a tool send, a channel card): 409 not_stoppable; a member: 403", async () => {
    as();
    for (const [o, rail, status, code] of [
      [{ stop: { ok: false, code: "not_stoppable" } }, "decisions", 409, "not_stoppable"],
      [{ cls: "email_campaign.create_and_send" }, "decisions", 409, "not_stoppable"],
      [{ cls: "email_campaign.create_and_send" }, "channel_actions", 409, "not_stoppable"],
      [{ stop: { ok: false, code: "not_authorized" } }, "decisions", 403, "not_authorized"],
    ] as const) {
      const { h, calls } = harness(o as never);
      const r = res();
      await h.stop(req(rail), r as never);
      expect(r.statusCode).toBe(status);
      expect(r.body.error).toMatchObject({ code, message: expect.any(String) });
      if (rail === "channel_actions" || (o as { cls?: string }).cls) expect(calls.some((c) => c.name === "email_bulk_stop_send")).toBe(false);
    }
  });
});

describe("Stop refused for a member", () => {
  it("answers with the stop sentence, 403 not_authorized, and never mentions approve or a test", async () => {
    as("u-member");
    const { h, calls } = harness({ role: "member", stop: { ok: false, code: "not_authorized" } });
    const r = res();
    await h.stop(req(), r as never);
    expect(calls.find((c) => c.name === "email_bulk_stop_send")!.args).toEqual({ p_actor_user_id: "u-member", p_decision_id: CARD });
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: { code: "not_authorized", message: "Only an owner or admin can stop a send. Ask one of them to stop it." } });
    expect(r.body.error.message).not.toMatch(/approve|test/i);
  });

  it("other stop refusals keep their own sentence", async () => {
    as();
    const { h } = harness({ stop: { ok: false, code: "not_stoppable" } });
    const r = res();
    await h.stop(req(), r as never);
    expect(r.statusCode).toBe(409);
    expect(r.body.error).toEqual({ code: "not_stoppable", message: "Only a Zavi-list send that is still going out can be stopped." });
  });
});

describe("Approve on a decisions-rail send whose claim was released", () => {
  it("fires the dispatch again with a fresh event id (the original one is spent)", async () => {
    as();
    const { h, enqueued } = harness({ status: "proposed", approve: { ok: true, changed: false, status: "approved", redispatch_key: "r1760000000000" } });
    const r = res();
    await h.approve(req("decisions", { variant: 1, request_id: "req-12345678" }), r as never);
    expect(r.statusCode).toBe(200);
    expect(enqueued).toEqual([{ id: `approve:${CARD}:r1760000000000`, name: "decision.approved", data: { decision_id: CARD, tenant_id: T, decision_class: "bulk_outbound.send" } }]);
  });
});

describe("/api/workspace/email-pause", () => {
  it("GET {paused}; POST {paused} by an owner resumes the held sends; a member is refused", async () => {
    as();
    const resumed: string[][] = [];
    const set = vi.fn(async (_t: string, user: string, paused: boolean) => (user === "u-member" ? { ok: false as const, code: "not_authorized" } : { ok: true as const, paused, resumed: paused ? [] : ["s1", "s2"] }));
    const h = emailPauseHandlers({ read: async () => true, held: async () => null, set, resume: async (ids) => void resumed.push(ids) });
    let r = res();
    await h.get({ body: {} } as never, r as never);
    expect(r.body).toEqual({ paused: true, held: null });
    r = res();
    await h.set({ body: { paused: false } } as never, r as never);
    expect(r.body).toEqual({ paused: false });
    expect(resumed).toEqual([["s1", "s2"]]);
    r = res();
    await h.set({ body: { paused: "yes" } } as never, r as never);
    expect(r.statusCode).toBe(400);
    as("u-member");
    r = res();
    await h.set({ body: { paused: true } } as never, r as never);
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe("not_authorized");
  });
});

describe("GET /api/workspace/email-pause says when Zavi itself stopped sending", () => {
  for (const held of ["abuse", "global", "disabled", "unknown"] as const) {
    it(`held ${held}: paused keeps its own value and held names who stopped it`, async () => {
      as();
      const heldFor = vi.fn(async () => held);
      const h = emailPauseHandlers({ read: async () => false, held: heldFor });
      const r = res();
      await h.get({ body: {} } as never, r as never);
      expect(r.statusCode).toBe(200);
      expect(r.body).toEqual({ paused: false, held });
      expect(heldFor).toHaveBeenCalledWith(T);
      expect(r.headers["Cache-Control"]).toBe("no-store");
    });
  }

  it("a held read that fails still answers paused, with held unknown (never 'no hold')", async () => {
    as();
    const h = emailPauseHandlers({ read: async () => true, held: async () => { throw new Error("db down"); } });
    const r = res();
    await h.get({ body: {} } as never, r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ paused: true, held: "unknown" });
  });

  it("a paused read that fails is still a 500, whatever held says", async () => {
    as();
    const h = emailPauseHandlers({ read: async () => { throw new Error("db down"); }, held: async () => "global" });
    const r = res();
    await h.get({ body: {} } as never, r as never);
    expect(r.statusCode).toBe(500);
    expect(r.body.paused).toBeUndefined();
  });
});
