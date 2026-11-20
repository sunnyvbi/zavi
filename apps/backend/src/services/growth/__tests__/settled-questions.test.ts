
import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "73db45ff-0000-4000-8000-000000000001";
type Row = { id: string; tenant_id: string; topic_key: string; ask: string; on_yes: unknown; status: string };
let rows: Row[] = [];
let readError: { message: string } | null = null;

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({
      select: () => {
        const f: Array<(r: Row) => boolean> = [];
        const q = {
          eq: (c: keyof Row, v: unknown) => (f.push((r) => r[c] === v), q),
          in: (c: keyof Row, v: unknown[]) => (f.push((r) => v.includes(r[c])), q),
          limit: async () => ({ data: readError ? null : rows.filter((r) => f.every((x) => x(r))), error: readError }),
        };
        return q;
      },
      update: (patch: Partial<Row>) => {
        const f: Array<(r: Row) => boolean> = [];
        const q = {
          eq: (c: keyof Row, v: unknown) => (f.push((r) => r[c] === v), q),
          in: (c: keyof Row, v: unknown[]) => (f.push((r) => v.includes(r[c])), q),
          select: async () => {
            const hit = rows.filter((r) => f.every((x) => x(r)));
            for (const r of hit) Object.assign(r, patch);
            return { data: hit.map((r) => ({ id: r.id })), error: null };
          },
        };
        return q;
      },
    }),
  }),
}));

const promoteQueuedQuietly = vi.fn(async () => 0);
vi.mock("../cgo-questions", () => ({ promoteQueuedQuietly: (...a: unknown[]) => promoteQueuedQuietly(...(a as [])) }));

import { withdrawSettledAdQuestions, withdrawHeldObjectQuestion, type CardWaiting, type LiveBudget } from "../settled-questions";

const NOW = new Date("2026-10-23T15:00:00Z");
const row = (id: string, topic_key: string, ask = "Should I?", on_yes: unknown = null, status = "open"): Row => ({ id, tenant_id: T, topic_key, ask, on_yes, status });
const heldOrder = (from_usd: number, to_usd: number) => ({ kind: "held_ad_order", exec_class: "meta_ads.update_ad_set_budget", payload: {}, object_id: "120260590327570059", from_usd, to_usd });

let cards: Record<string, CardWaiting> = {};
let live: LiveBudget = { usd: 140 };
const deps = {
  readCard: async (_t: string, id: string): Promise<CardWaiting> => cards[id] ?? { state: "missing" },
  readLiveBudget: async (): Promise<LiveBudget> => live,
};
const status = (id: string) => rows.find((r) => r.id === id)?.status;

describe("withdrawSettledAdQuestions", () => {
  beforeEach(() => {
    rows = [];
    cards = {};
    live = { usd: 140 };
    readError = null;
    promoteQueuedQuietly.mockClear();
  });

  it("#2/#6/#8: every open-card question is withdrawn (the card is the ask), open or queued", async () => {
    rows = [row("q2", "open-advice:google-ads:24109304360"), row("q6", "open-advice:tiktok-ads:1879278332941697", "x", null, "queued")];
    expect(await withdrawSettledAdQuestions(T, NOW, deps)).toBe(2);
    expect([status("q2"), status("q6")]).toEqual(["withdrawn", "withdrawn"]);
    expect(promoteQueuedQuietly).toHaveBeenCalledWith(T, NOW);
  });

  it("#3: a legacy held question that pointed at a card is withdrawn", async () => {
    rows = [row("q3", "held:google-ads:24362130658", "I did not apply \"update campaign budget\" on my own: x. The card is waiting for you.")];
    expect(await withdrawSettledAdQuestions(T, NOW, deps)).toBe(1);
  });

  it("R2: a card question closes when its card is decided or gone, or waits with the hold on it; kept while it waits without one", async () => {
    cards = { done: { state: "done" }, held: { state: "waiting", hold: true }, bare: { state: "waiting", hold: false } };
    rows = [row("a", "held:card:done"), row("b", "held:card:gone"), row("c", "held:card:held"), row("d", "held:card:bare")];
    await withdrawSettledAdQuestions(T, NOW, deps);
    expect(["a", "b", "c", "d"].map(status)).toEqual(["withdrawn", "withdrawn", "withdrawn", "open"]);
  });

  it("R3: a held raise closes when the live budget is at the new amount or has moved off the old one; kept while it still sits at the old one", async () => {
    rows = [row("q9", "held:meta-ads:120260590327570059", "Should I apply it?", heldOrder(140, 168))];
    live = { usd: 140 };
    expect(await withdrawSettledAdQuestions(T, NOW, deps)).toBe(0);
    live = { usd: 168 };
    expect(await withdrawSettledAdQuestions(T, NOW, deps)).toBe(1);
    rows = [row("q9b", "held:meta-ads:1", "Should I apply it?", heldOrder(140, 168))];
    live = { usd: 155 };
    expect(await withdrawSettledAdQuestions(T, NOW, deps)).toBe(1);
  });

  it("must-not: any failed read keeps the question", async () => {
    cards = { x: { state: "error" } };
    live = null;
    rows = [row("a", "held:card:x"), row("b", "held:meta-ads:1", "Should I apply it?", heldOrder(140, 168))];
    expect(await withdrawSettledAdQuestions(T, NOW, deps)).toBe(0);
    expect(promoteQueuedQuietly).not.toHaveBeenCalled();
  });

  it("must-not: goal, hypothesis and plain held questions without a card are left alone", async () => {
    rows = [
      row("g", "goal:a25a5ff4:target"),
      row("h", "hyp:ceee80fd-d4be-439a-ac6f-2f66732a92e7"),
      row("p", "held:meta-ads:9", "I did not raise “X” from $80 to $96 a day on my own: you paused it yourself. Should I apply it?"),
    ];
    expect(await withdrawSettledAdQuestions(T, NOW, deps)).toBe(0);
  });

  it("a failed question read throws (the caller logs it)", async () => {
    readError = { message: "boom" };
    await expect(withdrawSettledAdQuestions(T, NOW, deps)).rejects.toThrow(/boom/);
  });
});

describe("withdrawHeldObjectQuestion", () => {
  beforeEach(() => {
    rows = [];
    promoteQueuedQuietly.mockClear();
  });

  it("withdraws only that object's open question and opens a queued one", async () => {
    rows = [row("q4", "held:meta-ads:120260836219200059"), row("other", "held:meta-ads:1")];
    expect(await withdrawHeldObjectQuestion(T, "held:meta-ads:120260836219200059", NOW)).toBe(true);
    expect([status("q4"), status("other")]).toEqual(["withdrawn", "open"]);
    expect(promoteQueuedQuietly).toHaveBeenCalledTimes(1);
  });
});
