import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const create = vi.fn(async (_args: unknown) => ({ content: [{ type: "text", text: '{"targets":[2]}' }] }));
  const getAnthropic = vi.fn(() => ({ messages: { create } }));
  return { create, getAnthropic };
});
vi.mock("@/services/anthropic", () => ({
  getAnthropic: m.getAnthropic,
  heliconePropertyHeaders: () => ({}),
}));

import { looksLikeApprovalIntent, narrowApprovalTargets } from "../slack-approval-nl";

describe("looksLikeApprovalIntent", () => {
  it("matches action-on-approval phrasing", () => {
    for (const t of [
      "approve the budget one",
      "reject all",
      "unpause those two",
      "resume the campaign",
      "go ahead",
      "set the budget to 10",
      "spend $10/day",
      "do it",
    ]) {
      expect(looksLikeApprovalIntent(t)).toBe(true);
    }
  });
  it("does NOT match a normal follow-up question", () => {
    for (const t of ["what does this campaign do?", "why is ROAS 0", "can you explain the targeting", "thanks!"]) {
      expect(looksLikeApprovalIntent(t)).toBe(false);
    }
  });
});

const CANDS = [
  { index: 1, decision_class: "meta_ads.resume_campaign", summary: "resume Upcar host" },
  { index: 2, decision_class: "meta_ads.update_ad_set_budget", summary: "set daily budget to $10/day" },
  { index: 3, decision_class: "meta_ads.resume_campaign", summary: "resume Upcar host - Copy" },
];

beforeEach(() => {
  m.create.mockClear();
  m.create.mockResolvedValue({ content: [{ type: "text", text: '{"targets":[2]}' }] });
});

describe("narrowApprovalTargets", () => {
  it("returns the picked indices (bounded to the candidate set)", async () => {
    const r = await narrowApprovalTargets("approve the budget one", CANDS);
    expect(r).toEqual([2]);
  });
  it('returns null on "all"', async () => {
    m.create.mockResolvedValueOnce({ content: [{ type: "text", text: '{"targets":"all"}' }] });
    expect(await narrowApprovalTargets("approve everything", CANDS)).toBeNull();
  });
  it("filters out-of-range indices the model hallucinated", async () => {
    m.create.mockResolvedValueOnce({ content: [{ type: "text", text: '{"targets":[2,9]}' }] });
    expect(await narrowApprovalTargets("the budget one", CANDS)).toEqual([2]);
  });
  it("returns null (→ re-post all) when nothing valid is picked", async () => {
    m.create.mockResolvedValueOnce({ content: [{ type: "text", text: '{"targets":[42]}' }] });
    expect(await narrowApprovalTargets("huh", CANDS)).toBeNull();
  });
  it("skips the LLM when there is ≤1 candidate", async () => {
    const r = await narrowApprovalTargets("approve", [CANDS[0]]);
    expect(r).toBeNull();
    expect(m.create).not.toHaveBeenCalled();
  });
  it("THROWS on unparseable output (caller falls back to all)", async () => {
    m.create.mockResolvedValueOnce({ content: [{ type: "text", text: "not json" }] });
    await expect(narrowApprovalTargets("x", CANDS)).rejects.toBeTruthy();
  });
});
