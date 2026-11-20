import { describe, it, expect } from "vitest";
import {
  recKey,
  coerceDecisions,
  applyDecision,
  MAX_REC_DECISIONS,
} from "../rec-decisions";

describe("recKey", () => {
  it("normalizes case + whitespace so the same title maps across weeks", () => {
    expect(recKey("Undercut Turo's  fee anxiety")).toBe("undercut turo's fee anxiety");
    expect(recKey("  Undercut Turo's fee anxiety  ")).toBe(recKey("Undercut Turo's fee anxiety"));
  });
  it("caps at 200 chars", () => {
    expect(recKey("a".repeat(500)).length).toBe(200);
  });
});

describe("coerceDecisions", () => {
  it("drops malformed entries and keeps valid ones", () => {
    const out = coerceDecisions({
      good: { status: "act", title: "X", updated_at: "2026-06-21T00:00:00Z" },
      badStatus: { status: "nope", title: "Y" },
      notObj: 5,
    });
    expect(Object.keys(out)).toEqual(["good"]);
    expect(out.good.status).toBe("act");
  });
  it("returns {} for non-object input", () => {
    expect(coerceDecisions(null)).toEqual({});
    expect(coerceDecisions([1, 2])).toEqual({});
    expect(coerceDecisions("x")).toEqual({});
  });
});

describe("applyDecision", () => {
  const now = "2026-06-21T12:00:00Z";

  it("upserts a valid decision", () => {
    const r = applyDecision({}, { rec_key: "k1", title: "Move 1", status: "act" }, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decisions.k1).toEqual({ status: "act", title: "Move 1", updated_at: now });
    }
  });

  it("clear removes a decision", () => {
    const stored = { k1: { status: "snooze", title: "M", updated_at: "x" } };
    const r = applyDecision(stored, { rec_key: "k1", status: "clear" }, now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decisions.k1).toBeUndefined();
  });

  it("rejects a bad status", () => {
    const r = applyDecision({}, { rec_key: "k1", status: "explode" }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_status");
  });

  it("rejects an empty rec_key", () => {
    const r = applyDecision({}, { rec_key: "   ", status: "act" }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_key");
  });

  it("rejects a NEW key over the cap but still allows updating an existing one", () => {
    const full: Record<string, unknown> = {};
    for (let i = 0; i < MAX_REC_DECISIONS; i++) {
      full[`k${i}`] = { status: "act", title: "t", updated_at: now };
    }
    const over = applyDecision(full, { rec_key: "new", status: "act" }, now);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("over_cap");
    const upd = applyDecision(full, { rec_key: "k0", status: "snooze" }, now);
    expect(upd.ok).toBe(true);
  });
});
