import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const rows: Row[] = [];
const inserted: unknown[] = [];
vi.mock("@/services/tenant-client", async (orig) => {
  const from = (table: string) => {
    const f: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.order = () => q;
    q.limit = () => q;
    q.eq = (c: string, v: unknown) => (f.push((r) => r[c] === v), q);
    q.in = (c: string, vs: unknown[]) => (f.push((r) => vs.includes(r[c])), q);
    q.update = (p: Row) => ((patch = p), q);
    q.insert = () => q;
    q.maybeSingle = async () => ({ data: table === "cgo_notes" ? { id: "note-1", next_review_at: "2026-10-30T00:00:00Z" } : null, error: null });
    q.then = (ok: (v: unknown) => unknown) => {
      const hit = table === "cgo_questions" ? rows.filter((r) => f.every((x) => x(r))) : [];
      if (patch) for (const r of hit) Object.assign(r, patch);
      return Promise.resolve({ data: hit, error: null }).then(ok);
    };
    return q;
  };
  return { ...(await orig<object>()), asTenantId: (t: string) => t, tenantClient: () => ({ from }) };
});
vi.mock("../cgo-questions", () => ({
  REASK_AFTER_DAYS: 14,
  normalizeTopic: (t: string) => t.toLowerCase().replace(/[^a-z0-9:]+/g, "-"),
  readQuestions: async () => rows.filter((r) => r.status === "open" || r.status === "queued").map((r) => ({ ...r })),
  insertQuestions: async (_t: string, _r: unknown, qs: unknown[]) => (inserted.push(...qs), qs),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));

import { askFounderOutsideReview } from "../open-advice";
import { heldOrderOnYes } from "../held-order-yes";

const T = "tenant-a";
const topic = "held:meta-ads:120258729006520059";
const order = (to: number) => heldOrderOnYes("meta_ads.update_ad_set_budget", { ad_set_id: "120258729006520059", daily_budget_usd: to, expected_current_daily_budget_usd: 149 })!;
const ask = "I did not apply the raise on my own. Should I apply it?";

beforeEach(() => {
  rows.length = 0;
  inserted.length = 0;
});

describe("a held order's question follows the controller's latest change", () => {
  it("the same change already asked: nothing new", async () => {
    rows.push({ id: "q1", tenant_id: T, topic_key: topic, status: "open", asked_at: "2026-10-22T15:00:00Z", on_yes: order(178.8) });
    expect(await askFounderOutsideReview({ tenant_id: T, topic, ask, on_yes: order(178.8) })).toBe(false);
    expect(rows[0].status).toBe("open");
    expect(inserted).toHaveLength(0);
  });

  it("Gig Atlanta 2026-10-29: $86.40 -> $103.68 asked, then $86.40 -> $93.12 an hour later: no new question, the old one and its yes stay", async () => {
    const gigTopic = "held:meta-ads:120261012970200059";
    const gig = (to: number) => heldOrderOnYes("meta_ads.update_ad_set_budget", { ad_set_id: "120261012970200059", daily_budget_usd: to, expected_current_daily_budget_usd: 86.4 })!;
    rows.push({ id: "q1", tenant_id: T, topic_key: gigTopic, status: "open", asked_at: "2026-10-29T12:42:22Z", on_yes: gig(103.68) });
    expect(await askFounderOutsideReview({ tenant_id: T, topic: gigTopic, ask, on_yes: gig(93.12) })).toBe(false);
    expect(rows[0]).toMatchObject({ status: "open", on_yes: gig(103.68) });
    expect(inserted).toHaveLength(0);
  });

  it("must-not: a different starting budget withdraws the old question and asks the new change", async () => {
    rows.push({ id: "q1", tenant_id: T, topic_key: topic, status: "open", asked_at: "2026-10-22T15:00:00Z", on_yes: order(178.8) });
    const moved = heldOrderOnYes("meta_ads.update_ad_set_budget", { ad_set_id: "120258729006520059", daily_budget_usd: 214.56, expected_current_daily_budget_usd: 178.8 })!;
    expect(await askFounderOutsideReview({ tenant_id: T, topic, ask, on_yes: moved })).toBe(true);
    expect(rows[0].status).toBe("withdrawn");
    expect(inserted).toEqual([expect.objectContaining({ topic_key: topic, on_yes: moved })]);
  });

  it("must-not: the opposite direction on the same starting budget is a new ask", async () => {
    rows.push({ id: "q1", tenant_id: T, topic_key: topic, status: "open", asked_at: "2026-10-22T15:00:00Z", on_yes: order(178.8) });
    expect(await askFounderOutsideReview({ tenant_id: T, topic, ask, on_yes: order(120) })).toBe(true);
    expect(rows[0].status).toBe("withdrawn");
    expect(inserted).toEqual([expect.objectContaining({ topic_key: topic, on_yes: order(120) })]);
  });
});
