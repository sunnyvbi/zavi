import { describe, expect, it } from "vitest";
import { applyAdPlanYes, type AdPlanOnYes } from "@/services/growth/ad-plan-yes";
import { envelopeDoor } from "@/services/approvals/envelope-door";
import { verifyEnvelope, type ApprovalEnvelope } from "@/services/approvals/approval-envelope";
import { fundApprovedPlan } from "@/services/ads-wallet/plan-funding";
import { shapeChatgptBundle } from "@/services/tools/chatgpt-ads/propose";
import { growthBundle } from "@/services/connectors/chatgpt-ads/growth-actions";
import { shapeAdPlan } from "@/services/growth/ad-plan-shape";

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-15T12:00:00Z");

function world(roles: Record<string, string>) {
  const decisions = new Map<string, { id: string; body: Record<string, unknown>; status: string; approved_by: string | null; envelope: ApprovalEnvelope | null }>();
  const actions = new Map<string, { id: string; payload: Record<string, unknown>; envelope: ApprovalEnvelope | null; attempts: number; keys: Set<string>; exec_status: string | null }>();
  const claims = new Map<string, string>();
  const events = new Set<string>();
  const provider = { creates: 0 };
  const holds: number[] = [];
  const orders = new Set<string>();
  let wallet = 0;
  const loadRole = async (u: string, t: string) => (t === T ? roles[u] ?? null : null);
  return {
    decisions, actions, claims, events, provider, holds, orders,
    get wallet() { return wallet; },
    pay(cents: number) { wallet += cents; },
    loadRole,
    yesDeps: {
      enabled: async () => true,
      loadRole,
      emitDecision: async (_cls: string, body: unknown) => {
        const b = body as Record<string, unknown>;
        for (const d of decisions.values()) if (d.body.source_question_id === b.source_question_id) throw new Error("duplicate key value violates unique constraint");
        const id = `card-${decisions.size + 1}`;
        decisions.set(id, { id, body: b, status: "proposed", approved_by: null, envelope: null });
        return id;
      },
      existingCard: async (_t: string, q: string) => [...decisions.values()].find((d) => d.body.source_question_id === q)?.id ?? null,
      setEnvelope: async (_t: string, table: string, id: string, env: ApprovalEnvelope) => {
        const row = table === "decisions" ? decisions.get(id) : actions.get(id);
        if (!row) return { ok: false, code: "not_found" };
        if (row.envelope) return JSON.stringify(row.envelope) === JSON.stringify(env) ? { ok: true } : { ok: false, code: "already_set" };
        row.envelope = env;
        return { ok: true };
      },
      approve: async (_t: string, id: string, user: string) => {
        const d = decisions.get(id)!;
        if (d.status === "proposed") {
          d.status = "approved";
          d.approved_by = user;
        }
        return true;
      },
    },
    doorDeps: (decisionId: string) => ({
      enabled: async () => true,
      readFounderAsk: async () => null,
      readEnvelope: async (_t: string, _tb: string, id: string) => actions.get(id)?.envelope ?? null,
      setEnvelope: async (_t: string, _tb: string, id: string, env: ApprovalEnvelope) => {
        const a = actions.get(id)!;
        if (a.envelope && JSON.stringify(a.envelope) !== JSON.stringify(env)) return { ok: false, code: "already_set" };
        a.envelope = env;
        return { ok: true };
      },
      sourceDecisionEnvelope: async () => decisions.get(decisionId)?.envelope ?? null,
      verify: (t: string, e: ApprovalEnvelope, c: string, p: unknown) => verifyEnvelope(t, e, c, p, loadRole),
      claim: async (_t: string, envId: string, action: string) => {
        const h = claims.get(envId);
        if (h && h !== action) return { ok: false, code: "claimed" };
        claims.set(envId, action);
        return { ok: true };
      },
      approve: async (_t: string, args: { actionId: string; eventKey: string }) => approveAction(args.actionId, args.eventKey),
      send: async (ev: { id: string }) => void events.add(ev.id),
    }),
    approveAction,
    async execute(actionId: string): Promise<{ ok: boolean; code?: string; line?: string }> {
      const a = actions.get(actionId)!;
      const lifetime = (a.payload.bundle as { campaign: { lifetime_budget_micros: number } }).campaign.lifetime_budget_micros / 1e6;
      const required = Math.round(lifetime * 100);
      if (wallet < required) {
        const env = a.envelope!;
        const f = await fundApprovedPlan(T, { action_id: actionId, actor_user_id: env.actor_user_id, shortfall_cents: required - wallet, proposed_at_ms: NOW.getTime() }, NOW.getTime(), {
          fundingEnabled: () => true,
          claim: async () => ({ status: "no_consented_card" }),
          link: async (_t, _u, cents, order) => (orders.add(`${order}:${cents}`), `https://checkout.example/${order}`),
        });
        a.exec_status = "failed";
        return { ok: false, code: "chatgpt_ads_wallet_short", line: f.line };
      }
      holds.push(lifetime);
      provider.creates++;
      a.exec_status = "executed";
      return { ok: true };
    },
  };
  function approveAction(id: string, key: string) {
    const a = actions.get(id)!;
    if (a.keys.has(key)) return { ok: true, attempt: a.attempts, replayed: true, stillQueued: false };
    a.keys.add(key);
    a.attempts++;
    a.exec_status = "queued";
    return { ok: true, attempt: a.attempts, replayed: false };
  }
}

const shaped = shapeAdPlan({ want_usd: 58, left_usd: 58, days_left: 17, margin: 1, today: "2026-10-15", preferred: "chatgpt_ads", connected: ["chatgpt_ads"] });
if (shaped.kind !== "plan") throw new Error("no plan");
const onYes: AdPlanOnYes = { kind: "ad_plan", goal_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", goal_rev: "r1", plan: shaped.plan };
const agentBundle = growthBundle.parse({
  rationale: "The founder approved a ChatGPT test.", summary: "Approved test",
  campaign: { name: "Aethel test", bidding_type: "clicks", targeting: { locations: { countries: ["US"] } }, daily_budget_micros: 100_000_000, start_time: NOW.getTime() / 1000 + 3600, end_time: NOW.getTime() / 1000 + 20 * 86400 },
  group: { name: "group one", context_hints: [], strategy: "fixed_bid", max_bid_micros: 2_000_000 },
  ads: [{ name: "ad one", title: "Title", body: "Body text", target_url: "https://example.com", image_url: "https://example.com/a.png" }],
});

async function runAethel(answerer: string, roles: Record<string, string>) {
  const w = world(roles);
  const q = { id: "q1", ordinal: 1, on_yes: onYes };
  const first = await applyAdPlanYes({ tenant_id: T, question: q, approver_user_id: answerer, surface: "email", amount_usd: null, days_left: 17, now: NOW }, w.yesDeps);
  await applyAdPlanYes({ tenant_id: T, question: q, approver_user_id: answerer, surface: "email", amount_usd: null, days_left: 17, now: NOW }, w.yesDeps);
  if (w.decisions.size === 0) return { w, first };
  const card = [...w.decisions.values()][0];
  const bundle = shapeChatgptBundle(agentBundle, onYes.plan, NOW.getTime());
  w.actions.set("act-1", { id: "act-1", payload: { bundle, currency: "USD" }, envelope: null, attempts: 0, keys: new Set(), exec_status: null });
  const door = await envelopeDoor({ tenantId: T, runId: "run-1", execClass: "chatgpt_ads.create_and_launch", execPayload: { bundle, currency: "USD" } }, "act-1", w.doorDeps(card.id));
  w.actions.set("act-2", { id: "act-2", payload: { bundle, currency: "USD" }, envelope: null, attempts: 0, keys: new Set(), exec_status: null });
  const second = await envelopeDoor({ tenantId: T, runId: "run-1", execClass: "chatgpt_ads.create_and_launch", execPayload: { bundle, currency: "USD" } }, "act-2", w.doorDeps(card.id));
  const refusal = door.approved ? await w.execute("act-1") : null;
  w.pay(5800);
  for (let i = 0; i < 2; i++) {
    const r = w.approveAction("act-1", "resume:order-1:act-1");
    if (!r.replayed) w.events.add(`approve:act-1:${r.attempt}`);
  }
  const final = await w.execute("act-1");
  return { w, first, card, door, second, refusal, final };
}

describe("aethel, exactly once", () => {
  it("owner's yes twice -> one card, one envelope claim, one $58.00 link, webhook twice -> one create, one $58 hold; never more than $58", async () => {
    const r = await runAethel("owner-1", { "owner-1": "owner" });
    expect(r.first.refused).toBeNull();
    expect(r.w.decisions.size).toBe(1);
    expect(r.card!.approved_by).toBe("owner-1");
    expect(r.card!.envelope).toMatchObject({ actor_user_id: "owner-1", max_total_usd: 58, max_daily_usd: null });
    expect(r.door).toMatchObject({ approved: true, actor_user_id: "owner-1" });
    expect(r.second).toEqual({ approved: false, reason: "claim_claimed" });
    expect(r.refusal).toMatchObject({ ok: false, code: "chatgpt_ads_wallet_short", line: expect.stringMatching(/^Add \$58\.00 to start: /) });
    expect(r.w.orders.size).toBe(1);
    expect(r.w.actions.get("act-1")!.attempts).toBe(2);
    expect(r.w.events).toEqual(new Set(["approve:act-1:1", "approve:act-1:2"]));
    expect(r.final).toEqual({ ok: true });
    expect(r.w.provider.creates).toBe(1);
    expect(r.w.holds).toEqual([58]);
  });
  it("an admin answers: the actor is the admin, not the owner", async () => {
    const r = await runAethel("admin-1", { "owner-1": "owner", "admin-1": "admin" });
    expect(r.card!.approved_by).toBe("admin-1");
    expect(r.card!.envelope).toMatchObject({ actor_user_id: "admin-1", actor_role: "admin" });
    expect(r.door).toMatchObject({ approved: true, actor_user_id: "admin-1" });
  });
  it("a member answers: zero cards, nothing spent", async () => {
    const r = await runAethel("member-1", { "member-1": "member" });
    expect(r.first.refused).toMatch(/owner or admin/);
    expect(r.w.decisions.size).toBe(0);
    expect(r.w.provider.creates).toBe(0);
  });
  it("a cross-tenant envelope is refused at the door", async () => {
    const w = world({ "owner-1": "owner" });
    const env = { v: 1 as const, envelope_id: "q:x", tenant_id: "22222222-2222-4222-8222-222222222222", actor_user_id: "owner-1", actor_role: "owner" as const, surface: "cgo_yes" as const, channel: "chatgpt_ads", max_total_usd: 58, max_daily_usd: null, starts_on: "2026-10-15", ends_on: "2026-10-17" };
    w.decisions.set("card-x", { id: "card-x", body: {}, status: "approved", approved_by: "owner-1", envelope: env });
    const bundle = shapeChatgptBundle(agentBundle, onYes.plan, NOW.getTime());
    w.actions.set("act-x", { id: "act-x", payload: { bundle }, envelope: null, attempts: 0, keys: new Set(), exec_status: null });
    expect(await envelopeDoor({ tenantId: T, runId: "r", execClass: "chatgpt_ads.create_and_launch", execPayload: { bundle, currency: "USD" } }, "act-x", w.doorDeps("card-x"))).toEqual({ approved: false, reason: "wrong_tenant" });
  });
});
