import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/email-send-tier", async (orig) => ({ ...(await orig<typeof import("@/services/agents/email-send-tier")>()), emailSendHttpRefusal: async () => null }));

import { emailCardHandlers } from "@/routes/email-cards";
import { pauseHoldOf, SENDER_STOPPED_NOT_SENT, type CardDeps, type SendFacts } from "../cards";
import type { GlobalBulkStop } from "@/services/comms/bulk-outbound/config";

const T = "11111111-1111-4111-8111-111111111111";
const CARD = "33333333-3333-4333-8333-333333333333";

const v = (n: number) => ({ content: { subject: `Subject ${n}`, preview_text: "" }, html: `<p>${n}</p>`, text: `${n}`, render_sha: "x" });
const listBody = {
  list_id: "44444444-4444-4444-8444-444444444444",
  list_version_id: "55555555-5555-4555-8555-555555555555",
  list_name: "QA 1016",
  est_recipient_count: 2,
  from_address: "hi@brightloop.test",
  variants: [v(1), v(2)],
  chosen_variant: 1,
};
const toolBody = { tool: "mailchimp", audience_id: "L1", audience_name: "Members", audience_count: 200, from_email: "hi@brightloop.test", from_name: "B", variants: [v(1)] };

const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

function harness(o: { cls?: string; facts?: SendFacts; paused?: boolean | "down"; live?: number | null; approve?: Record<string, unknown>; senderStop?: () => Promise<GlobalBulkStop> }) {
  const live = vi.fn(async () => (o.live === undefined ? 1 : o.live));
  const pausedCalls: string[] = [];
  const enqueued: unknown[] = [];
  const cls = o.cls ?? "bulk_outbound.send";
  const deps: Partial<CardDeps> = {
    rpc: (async (_t: string, name: string) => {
      if (name === "email_card_view_state") {
        return { ok: true, class: cls, body: cls === "bulk_outbound.send" ? listBody : toolBody, open: false, status: "approved", role: "owner", versions: cls === "bulk_outbound.send" ? 2 : 1, retryable: false, tests: [] };
      }
      if (name === "email_card_send_facts") return o.facts ?? null;
      if (name === "email_planned_for_card") return null;
      if (name === "approve_email_card") return o.approve ?? { ok: true, changed: true, status: "approved" };
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    liveCount: live,
    confirmedEmail: async () => "owner@brightloop.test",
    enqueue: async (e) => {
      enqueued.push(e);
    },
    groupName: async () => null,
    paused: async (t: string) => {
      pausedCalls.push(t);
      if (o.paused === "down") throw new Error("down");
      return o.paused === true;
    },
    senderStop: o.senderStop ?? (async () => {
      throw new Error("sender stop read when the card is not held by it");
    }),
  };
  const h = emailCardHandlers(deps, async () => new Set<string>(), (async () => null) as never);
  return { h, live, pausedCalls, enqueued };
}

const heldFacts = (error: string | null, extra: Partial<NonNullable<SendFacts>["card"]> = {}): SendFacts => ({
  card: { status: "proposed", approved: true, approved_at: longAgo, dispatched_at: longAgo, error, ...extra },
  bulk: null,
  results: null,
});

const view = async (o: Parameters<typeof harness>[0], rail = "decisions") => {
  mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-owner" });
  const hh = harness(o);
  const r = res();
  await hh.h.view({ params: { rail, id: CARD }, body: {} } as never, r as never);
  expect(r.statusCode).toBe(200);
  return { card: r.body.card, ...hh };
};

describe("an email approved while email is paused", () => {
  it("says it is paused, not starting, and offers no resume that the pause would refuse", async () => {
    const { card, pausedCalls } = await view({ facts: heldFacts("email_paused"), paused: true });
    expect(card.status).toBe("queued");
    expect(card.pause_hold).toBe("paused");
    expect(card.retryable).toBe(false);
    expect(pausedCalls).toEqual([T]);
  });

  it("an approval that has not reached the worker yet is still shown as paused while email is paused", async () => {
    const { card } = await view({ facts: { card: { status: "approved", approved: true, approved_at: longAgo, error: null }, bulk: null, results: null }, paused: true });
    expect(card.status).toBe("approved");
    expect(card.pause_hold).toBe("paused");
    expect(card.retryable).toBe(false);
  });

  it("after resume the held send says email is back on and it starts shortly", async () => {
    const { card } = await view({ facts: heldFacts("email_paused"), paused: false });
    expect(card.pause_hold).toBe("resumed");
    expect(card.retryable).toBe(true);
  });

  it("a held send whose pause cannot be read right now still says it was held by the pause", async () => {
    const { card } = await view({ facts: heldFacts("email_paused"), paused: "down" });
    expect(card.pause_hold).toBe("paused");
  });

  it("a send released for another reason with email on says nothing about a pause", async () => {
    const { card } = await view({ facts: heldFacts("fleet_halted"), paused: false });
    expect(card.pause_hold).toBeNull();
  });

  it("a send already going out is not relabelled by a pause flipped later (the fan-out holds it with its own reason)", async () => {
    const facts: SendFacts = {
      card: { status: "dispatching", approved: true, dispatched_at: longAgo },
      bulk: { status: "sending", hold_reason: null, total: 5, sent: 2, skipped: 0, failed: 0, unknown: 0, hard_bounces: 0, created_at: longAgo, finished_at: null, next_run_at: null },
      results: null,
    };
    const { card } = await view({ facts, paused: true });
    expect(card.status).toBe("sending");
    expect(card.pause_hold).toBeNull();
  });

  it("approve answers paused: true, so the card can say nothing goes out yet", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-owner" });
    const { h, enqueued } = harness({ paused: true });
    const r = res();
    await h.approve({ params: { rail: "decisions", id: CARD }, body: { variant: 1, request_id: "req-12345678" } } as never, r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ok: true, queued: true, changed: true, paused: true });
    expect(enqueued).toHaveLength(1);
  });

  it("approve with email on answers without a paused flag", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-owner" });
    const { h } = harness({ paused: false });
    const r = res();
    await h.approve({ params: { rail: "decisions", id: CARD }, body: { variant: 1, request_id: "req-12345678" } } as never, r as never);
    expect(r.body).toEqual({ ok: true, queued: true, changed: true });
  });
});

describe("the card's list size", () => {
  it("a Zavi list shows the people a send would reach now (the /count number), not the drafted estimate with unsubscribed people", async () => {
    const { card, live } = await view({ facts: heldFacts(null), live: 1 });
    expect(card.list).toEqual({ name: "QA 1016", people: 1 });
    expect(live).toHaveBeenCalledWith(T, "bulk_outbound.send", listBody);
  });

  it("a Zavi list that cannot be read and can still be sent says it could not check, not the drafted estimate", async () => {
    const { card } = await view({ facts: heldFacts(null), live: null });
    expect(card.list).toEqual({ name: "QA 1016", people: null, unchecked: true });
  });

  it("an email-tool card in flight never calls the provider on each poll, and shows only the approved number", async () => {
    const { card, live } = await view({ cls: "email_campaign.create_and_send", facts: { card: { status: "dispatching", approved: true, dispatched_at: new Date().toISOString() }, bulk: null, results: null } });
    expect(card.list).toEqual({ name: "Members", people: null });
    expect(live).not.toHaveBeenCalled();
  });
});

describe("a send stuck dispatching", () => {
  it("past the bound it ends as outcome_unknown: may have gone out, no polling, no resend, and still carries when dispatching began", async () => {
    const { card } = await view({ facts: { card: { status: "dispatching", approved: true, dispatched_at: longAgo }, bulk: null, results: null }, paused: false });
    expect(card).toMatchObject({ status: "outcome_unknown", may_have_sent: true, reconciliation_pending: false, retryable: false });
    expect(card.dispatching_since).toBe(longAgo);
  });

  it("a channel card dispatching carries its claim time", async () => {
    const { card } = await view(
      { cls: "email_campaign.create_and_send", facts: { card: { status: "approved", exec_status: "dispatching", approved: true, claimed_at: longAgo }, bulk: null, results: null }, paused: false },
      "channel_actions",
    );
    expect(card.status).toBe("dispatching");
    expect(card.dispatching_since).toBe(longAgo);
  });
});

describe("pauseHoldOf", () => {
  const facts = (error: string | null) => ({ card: { error } }) as unknown as SendFacts;
  it("a tool send already dispatching when email is paused is never told it has not started", () => {
    expect(pauseHoldOf("channel_actions", "dispatching", facts(null), true)).toBeNull();
    expect(pauseHoldOf("decisions", "dispatching", facts(null), true)).toBeNull();
  });
  it("an approved or queued send waits for the pause, and a decision the pause held keeps saying so", () => {
    expect(pauseHoldOf("channel_actions", "queued", facts(null), true)).toBe("paused");
    expect(pauseHoldOf("decisions", "approved", facts(null), true)).toBe("paused");
    expect(pauseHoldOf("decisions", "dispatching", facts("email_paused"), true)).toBe("paused");
    expect(pauseHoldOf("decisions", "dispatching", facts("email_paused"), false)).toBe("resumed");
  });
});

describe("Flow 33: a card held because Zavi's sender was stopped says what is true when it is read", () => {
  const held = () => heldFacts("bulk_sending_paused");

  it("while the sender is still stopped it says so in the present tense", async () => {
    const { card } = await view({ facts: held(), senderStop: async () => "stopped" });
    expect(card.status).toBe("held");
    expect(card.retryable).toBe(true);
    expect(card.failure_reason).toBe(SENDER_STOPPED_NOT_SENT);
  });

  it("once the sender is back on, the same card no longer claims it is stopped right now", async () => {
    let stop: GlobalBulkStop = "stopped";
    const reads: GlobalBulkStop[] = [];
    const senderStop = async () => {
      reads.push(stop);
      return stop;
    };
    const before = (await view({ facts: held(), senderStop })).card;
    expect(before.failure_reason).toMatch(/is stopped for every workspace right now/);
    stop = "running";
    const after = (await view({ facts: held(), senderStop })).card;
    expect(reads).toEqual(["stopped", "running"]);
    expect(after.status).toBe("held");
    expect(after.retryable).toBe(true);
    expect(after.failure_reason).not.toMatch(/right now/);
    expect(after.failure_reason).not.toMatch(/\bis stopped\b/);
    expect(after.failure_reason).not.toMatch(/^Zavi sender stopped/);
    expect(after.failure_reason).toMatch(/was stopped for every workspace when Zavi went to send this approved email/);
    expect(after.failure_reason).toContain("nothing was sent");
    expect(after.failure_reason).toContain("The sender is running again");
    expect(after.failure_reason).toContain("Send now");
  });

  it.each([
    ["unreadable", async (): Promise<GlobalBulkStop> => "unreadable"],
    ["a failed read", async (): Promise<GlobalBulkStop> => {
      throw new Error("down");
    }],
  ])("with %s it says the sender was stopped, never that it is stopped now or running again", async (_label, senderStop) => {
    const { card } = await view({ facts: held(), senderStop });
    expect(card.status).toBe("held");
    expect(card.failure_reason).toMatch(/^Zavi sender stopped: Zavi's own sender was stopped for every workspace/);
    expect(card.failure_reason).not.toMatch(/right now|running again/);
    expect(card.failure_reason).toContain("nothing was sent");
  });

  it("a card not held by the sender stop never reads the sender state", async () => {
    const { card } = await view({ facts: heldFacts("email_paused"), paused: false });
    expect(card.status).toBe("queued");
  });
});
