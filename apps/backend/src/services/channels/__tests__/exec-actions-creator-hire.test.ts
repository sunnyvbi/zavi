import { describe, expect, it, vi } from "vitest";
import { recordChannelExecAction, type ExecActionInput } from "../exec-actions";
import { targetFromKey, type MatchPool, type PoolCard } from "../card-matcher";
import { buildCreatorHireCard } from "@/services/creators/hire-card";
import { CREATOR_HIRE_CLASS } from "@/services/creators/hire-approve";

vi.mock("@/services/growth/cgo-ads", () => ({ cgoApproveChannelAction: vi.fn(async () => false) }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const ORDER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORDER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const CAPS = "cccccccc-0000-4000-8000-00000000000c";

type Card = { id: string; status: string; title: string; target_key: string | null; exec_payload: Record<string, unknown> };

function hireInput(order_id: string, run: string): ExecActionInput {
  const { title, body } = buildCreatorHireCard({
    tenant_id: TENANT,
    run_id: run,
    order_id,
    creator_name: "Maya",
    package_title: "3 ad videos",
    business_total_cents: 5_500,
    price_cents: 5_000,
    fee_cents: 500,
  });
  return {
    tenantId: TENANT,
    runId: run,
    channelSlug: "ugc",
    execClass: CREATOR_HIRE_CLASS,
    execPayload: { order_id, caps_id: CAPS },
    actionType: "other",
    title,
    body,
  };
}

function world() {
  const cards: Card[] = [];
  const rpc = vi.fn(async (_tid: unknown, _name: string, args: { p_action: Record<string, unknown> }) => {
    const a = args.p_action;
    const target = (a.target_key as string | null) ?? null;
    const judged = a.judged_ids as string[] | null;
    if (judged && target && cards.some((c) => c.status === "pending" && c.target_key === target && !judged.includes(c.id))) {
      return { data: { ok: false, code: "rematch" }, error: null };
    }
    const payload = a.exec_payload as Record<string, unknown>;
    const same = cards.find((c) => c.status === "pending" && JSON.stringify(c.exec_payload) === JSON.stringify(payload));
    if (same) return { data: { ok: true, id: same.id, replayed: false, kept: true }, error: null };
    let replaced = 0;
    const want = a.repeat_of as string | null;
    const old = want ? cards.find((c) => c.id === want && c.status === "pending") : undefined;
    if (old) {
      old.status = "stale";
      replaced = 1;
    }
    const id = `card-${cards.length + 1}`;
    cards.push({ id, status: "pending", title: String(a.title), target_key: target, exec_payload: payload });
    return { data: { ok: true, id, replayed: false, replaced, repeat_of: old?.id ?? null }, error: null };
  });
  const pool = (statusOf: (c: Card) => PoolCard["status"] = () => "open"): MatchPool =>
    cards.map((c) => ({
      id: c.id,
      channel: "ugc",
      status: statusOf(c),
      title: c.title,
      summary: c.title,
      action_type: "other",
      target: targetFromKey(c.target_key),
    }));
  return { cards, rpc, pool };
}

describe("creator.hire cards: one card per order, never judged against another hire", () => {
  it("two hire cards for two different orders are both filed and stay pending; the matcher is never asked", async () => {
    const w = world();
    const match = vi.fn(async (_ch: string, _fresh: unknown, pool: readonly PoolCard[]) => ({
      verdicts: [{ ref: "n0", decision: "same_open" as const, match_id: pool[0]?.id ?? null, changed: true, reason: "same creator, same package" }],
      input_tokens: 1,
      output_tokens: 1,
    }));
    const deps = { enabled: () => true, loadPool: vi.fn(async () => w.pool()) as never, match: match as never, log: vi.fn(async () => {}) as never };

    const a = await recordChannelExecAction(hireInput(ORDER_A, "run-1"), w.rpc as never, deps);
    const b = await recordChannelExecAction(hireInput(ORDER_B, "run-2"), w.rpc as never, deps);

    expect(w.cards.map((c) => [c.id, c.status, c.exec_payload.order_id])).toEqual([
      ["card-1", "pending", ORDER_A],
      ["card-2", "pending", ORDER_B],
    ]);
    expect(a.id).not.toBe(b.id);
    expect(b.kept).toBeUndefined();
    expect(match).not.toHaveBeenCalled();
    const sent = w.rpc.mock.calls.map((c) => c[2].p_action);
    expect(sent.map((p) => p.repeat_of)).toEqual([null, null]);
    expect(sent.map((p) => p.target_key)).toEqual([`creator_order:${ORDER_A}`, `creator_order:${ORDER_B}`]);
  });

  it("a new order's hire card is filed even when an earlier hire card was turned down", async () => {
    const w = world();
    await recordChannelExecAction(hireInput(ORDER_A, "run-1"), w.rpc as never, { enabled: () => false });
    w.cards[0].status = "rejected";
    const match = vi.fn(async () => ({
      verdicts: [{ ref: "n0", decision: "already_rejected" as const, match_id: "card-1", changed: false, reason: "same hire" }],
      input_tokens: 1,
      output_tokens: 1,
    }));
    const out = await recordChannelExecAction(hireInput(ORDER_B, "run-2"), w.rpc as never, {
      enabled: () => true,
      loadPool: vi.fn(async () => w.pool((c) => (c.status === "rejected" ? "rejected" : "open"))) as never,
      match: match as never,
      log: vi.fn(async () => {}) as never,
    });
    expect(out.id).toBe("card-2");
    expect(w.cards[1]).toMatchObject({ status: "pending", exec_payload: { order_id: ORDER_B, caps_id: CAPS } });
    expect(match).not.toHaveBeenCalled();
  });
});
