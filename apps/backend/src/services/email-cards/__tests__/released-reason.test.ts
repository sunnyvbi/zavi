import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

import { emailCardHandlers } from "@/routes/email-cards";
import { SEND_FAILED_FALLBACK, type CardDeps } from "../cards";
import { RELEASED_EXPIRED_REASON, RELEASED_PAUSED_REASON, RELEASED_SENDER_STOPPED_REASON } from "../recovery";

const T = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const MIGRATIONS = join(__dirname, "../../../../../../supabase/migrations");

function sweepSentences(): { paused: string; stopped: string; expired: string } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const latest = files.filter((f) => /function public\.email_redispatch_released_sweep\(/.test(readFileSync(join(MIGRATIONS, f), "utf8"))).pop();
  if (!latest) throw new Error("no migration defines email_redispatch_released_sweep");
  const sql = readFileSync(join(MIGRATIONS, latest), "utf8");
  const m = /dispatch_error = case when v_paused\s+then '((?:[^']|'')*)'\s+when v_stopped\s+then '((?:[^']|'')*)'\s+else '((?:[^']|'')*)' end/.exec(sql);
  if (!m) throw new Error(`${latest} no longer writes the paused/expired dispatch_error in the expected shape`);
  return { paused: m[1].replace(/''/g, "'"), stopped: m[2].replace(/''/g, "'"), expired: m[3].replace(/''/g, "'") };
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

async function cardFor(error: string, cls = "bulk_outbound.send") {
  const deps: Partial<CardDeps> = {
    rpc: (async (_t: string, name: string) => {
      if (name === "email_card_view_state") {
        return {
          ok: true,
          class: cls,
          body: { list_name: "Members", variants: [], chosen_variant: 1, renderer_version: "r1", template_snapshot: {} },
          open: false,
          status: "dispatch_failed",
          role: "owner",
          versions: 1,
          tests: [],
          retryable: false,
          failure_reason: null,
        };
      }
      if (name === "email_card_send_facts") return { card: { status: "dispatch_failed", approved: true, error }, bulk: null, results: null };
      if (name === "email_planned_for_card") return null;
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    liveCount: async () => 10,
    confirmedEmail: async () => "owner@cakely.test",
    enqueue: async () => {},
    groupName: async () => null,
  };
  mocks.requireAuth.mockResolvedValue({ tenant_id: T, user_id: "u-owner" });
  const r = res();
  await emailCardHandlers(deps, async () => new Set<string>(), (async () => null) as never).view({ params: { rail: "decisions", id: CARD }, body: {} } as never, r as never);
  expect(r.statusCode).toBe(200);
  return r.body.card as { status: string; failure_reason: string | null; retryable?: boolean; may_have_sent?: boolean };
}

describe("Flow 86: a send the released sweep expired shows the sweep's own sentence", () => {
  it("the sweep's stored sentences still start with the reasons recovery tells the founder", () => {
    const s = sweepSentences();
    expect(s.expired.startsWith(RELEASED_EXPIRED_REASON)).toBe(true);
    expect(s.paused.startsWith(RELEASED_PAUSED_REASON)).toBe(true);
    expect(s.stopped.startsWith(RELEASED_SENDER_STOPPED_REASON)).toBe(true);
    expect(s.expired).not.toBe(s.paused);
  });

  it.each([
    ["bulk_outbound.send", "expired"],
    ["bulk_outbound.send", "paused"],
    ["email_campaign.create_and_send", "expired"],
    ["email_campaign.create_and_send", "paused"],
  ] as const)("a %s card released as %s carries the exact stored sentence, not the fallback", async (cls, which) => {
    const stored = sweepSentences()[which];
    const c = await cardFor(stored, cls);
    expect(c.status).toBe("failed");
    expect(c.failure_reason).toBe(stored);
    expect(c.failure_reason).not.toBe(SEND_FAILED_FALLBACK);
    expect(c.failure_reason).toContain(which === "paused" ? RELEASED_PAUSED_REASON : RELEASED_EXPIRED_REASON);
    expect(c.may_have_sent).not.toBe(true);
    expect(c.retryable).toBe(false);
  });

  it("an unknown sentence that only looks like the released one still gets the fallback", async () => {
    const c = await cardFor(`${RELEASED_EXPIRED_REASON} Call 555-0100 for help.`);
    expect(c.failure_reason).toBe(SEND_FAILED_FALLBACK);
  });
});
