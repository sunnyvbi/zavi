import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

import { emailCardHandlers } from "@/routes/email-cards";
import type { CardDeps } from "../cards";
import { FANOUT_STALLED_REASON, runEmailSendRecovery } from "../recovery";

const T = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const MIGRATIONS = join(__dirname, "../../../../../../supabase/migrations");

function giveUpHoldReason(): string {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const latest = files.filter((f) => /function public\.email_bulk_stalled_sends\(/.test(readFileSync(join(MIGRATIONS, f), "utf8"))).pop();
  if (!latest) throw new Error("no migration defines email_bulk_stalled_sends");
  const m = /set status = 'held', hold_reason = '([a-z_]+)'/.exec(readFileSync(join(MIGRATIONS, latest), "utf8"));
  if (!m) throw new Error(`${latest} no longer holds a given-up send in the expected shape`);
  return m[1];
}

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
    setHeader() {},
  };
}

const bulk = (o: Record<string, unknown>) => ({
  status: "held",
  hold_reason: giveUpHoldReason(),
  total: 3,
  sent: 1,
  skipped: 0,
  failed: 0,
  unknown: 0,
  hard_bounces: 0,
  created_at: "2026-10-28T09:00:00Z",
  finished_at: null,
  next_run_at: null,
  ...o,
});

async function card(b: Record<string, unknown>) {
  const deps: Partial<CardDeps> = {
    rpc: (async (_t: string, name: string) => {
      if (name === "email_card_view_state") {
        return { ok: true, class: "bulk_outbound.send", body: { list_name: "Members", variants: [], chosen_variant: 1 }, open: false, status: "acted", role: "owner", versions: 1, tests: [], retryable: false, failure_reason: null };
      }
      if (name === "email_card_send_facts") return { card: { status: "acted", approved: true, dispatched_at: "2026-10-28T09:00:00Z" }, bulk: b, results: { sent_count: 1, finished_at: "2026-10-28T10:00:00Z", h1: {}, d7: {}, d7_published: false } };
      if (name === "email_planned_for_card") return null;
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    liveCount: async () => 3,
    confirmedEmail: async () => "owner@brightloop.test",
    enqueue: async () => {},
    groupName: async () => null,
    paused: async () => false,
  };
  mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-owner" });
  const r = res();
  await emailCardHandlers(deps, async () => new Set<string>(), (async () => null) as never).view({ params: { rail: "decisions", id: CARD }, body: {} } as never, r as never);
  expect(r.statusCode).toBe(200);
  return r.body.card as { status: string; failure_reason: string | null; sent_count: number | null; retryable: boolean; may_have_sent: boolean };
}

describe("Bug 81ac: a bulk send the recovery sweep gave up on", () => {
  it("the sweep tells the founder the stalled reason, and the card read for that still-acted decision shows the same reason with how many were not emailed", async () => {
    const told: Array<Record<string, unknown>> = [];
    await runEmailSendRecovery({
      rpc: async (name) => (name === "email_bulk_stalled_sends" ? [{ action: "give_up", send_id: "s-1", tenant_id: T, decision_id: CARD, sent: 1, total: 3 }] : []),
      send: async () => {},
      tell: async (o) => told.push(o as never),
      counts: async () => ({ status: "held", hold_reason: "fanout_stalled", next_run_at: null, total: 3, sent: 1, skipped: 0, failed: 0, unknown: 0, pending: 2, sending: 0, complaints: 0, hard_bounces: 0 }) as never,
    });
    expect(told).toEqual([expect.objectContaining({ card_id: CARD, outcome: "failed", sent: 1, total: 3, reason: FANOUT_STALLED_REASON })]);

    const c = await card(bulk({}));
    expect(c.status).toBe("partially_sent");
    expect(c.status).not.toBe("sent");
    expect(c.sent_count).toBe(1);
    expect(c.retryable).toBe(false);
    expect(c.failure_reason).toBe(`${FANOUT_STALLED_REASON} 2 of the 3 people on the list were not emailed, and Zavi will not send it to them on its own.`);
    expect(c.failure_reason).not.toMatch(/Zavi stopped this send: Zavi's sender/);
  });

  it("one left over reads in the singular, and a stall where some may have gone out still says so instead", async () => {
    expect((await card(bulk({ sent: 2, total: 3 }))).failure_reason).toBe(`${FANOUT_STALLED_REASON} 1 of the 3 people on the list was not emailed, and Zavi will not send it to them on its own.`);
    const unsure = await card(bulk({ sent: 1, total: 3, unknown: 1 }));
    expect(unsure).toMatchObject({ status: "outcome_unknown", may_have_sent: true });
    expect(unsure.failure_reason).toMatch(/1 more may have/);
  });
});
