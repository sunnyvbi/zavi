import { describe, expect, it } from "vitest";
import { filterNeedsYou, type NeedsYouDecision } from "./needsYouFilter";

function d(
  id: string,
  decision_class: string,
  emitted_at: string,
  handler: string | null = null,
  body: Record<string, unknown> = {},
): NeedsYouDecision {
  return { id, decision_class, handler, body, emitted_at };
}

describe("filterNeedsYou", () => {
  it("caps the list at 5 and reports the hidden remainder", () => {
    const many = Array.from({ length: 82 }, (_, i) =>
      d(`x${i}`, "pm.digest", `2026-07-0${(i % 9) + 1}T00:00:00Z`),
    );
    const res = filterNeedsYou(many);
    expect(res.shown).toHaveLength(5);
    expect(res.total).toBe(82);
    expect(res.hidden).toBe(77);
  });

  it("sorts money/security gates ahead of low-stakes rows", () => {
    const rows = [
      d("digest", "pm.digest", "2026-07-07T10:00:00Z"),
      d("refund", "dispute-response.triage", "2026-07-01T10:00:00Z", "stripe.refund"),
      d("ads", "meta_ads.update_ad_set_budget", "2026-07-02T10:00:00Z"),
    ];
    const res = filterNeedsYou(rows);
    expect(res.shown.map((r) => r.id)).toEqual(["ads", "refund", "digest"]);
  });

  it("orders same-stakes rows by recency (newest first)", () => {
    const rows = [
      d("old", "pm.digest", "2026-07-01T00:00:00Z"),
      d("new", "pm.digest", "2026-07-07T00:00:00Z"),
      d("mid", "pm.digest", "2026-07-04T00:00:00Z"),
    ];
    const res = filterNeedsYou(rows);
    expect(res.shown.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("treats a RED blast-radius envelope as high-stakes", () => {
    const rows = [
      d("calm", "pm.digest", "2026-07-07T00:00:00Z"),
      d("red", "engineer.ship-pr", "2026-07-01T00:00:00Z", null, {
        decision_evidence: { blast_radius: "RED" },
      }),
    ];
    const res = filterNeedsYou(rows);
    expect(res.shown[0].id).toBe("red");
  });

  it("empty queue → empty result, zero hidden", () => {
    const res = filterNeedsYou([]);
    expect(res.shown).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.hidden).toBe(0);
  });
});
