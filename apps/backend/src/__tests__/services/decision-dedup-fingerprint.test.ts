import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

const VOLATILE_KEYS = [
  "source_run_id",
  "source_signals",
  "emitted_at",
  "confidence",
  "brain_citations",
  "decision_evidence",
] as const;

function fingerprint(body: Record<string, unknown> | null): string {
  const obj: Record<string, unknown> = { ...(body ?? {}) };
  for (const k of VOLATILE_KEYS) delete obj[k];
  const sortedKeys = Object.keys(obj).sort();
  const canonical = JSON.stringify(obj, sortedKeys);
  return createHash("md5").update(canonical).digest("hex");
}

describe("decision content fingerprint (dedup semantic)", () => {
  it("two IDENTICAL recommendation bodies → same fingerprint (would dedup → one proposed row)", () => {
    const a = { action: "pause_campaign", target: "promo-q3", rationale: "ROAS below floor" };
    const b = { action: "pause_campaign", target: "promo-q3", rationale: "ROAS below floor" };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("key ORDER does not matter (canonical serialization)", () => {
    const a = { action: "open_pr", repo: "x/y", title: "fix" };
    const b = { title: "fix", repo: "x/y", action: "open_pr" };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("differences in VOLATILE keys still dedup (same recommendation, fresh run/provenance)", () => {
    const base = { action: "file_ticket", project: "ENG", summary: "flaky test" };
    const reEmit1 = {
      ...base,
      source_run_id: "run-aaaa",
      source_signals: ["sig1"],
      emitted_at: "2026-06-01T00:00:00Z",
      confidence: 0.7,
      brain_citations: [{ note_id: "n1", title: "t1" }],
      decision_evidence: { reason_text: "because" },
    };
    const reEmit2 = {
      ...base,
      source_run_id: "run-bbbb",
      source_signals: ["sig2", "sig3"],
      emitted_at: "2026-06-05T12:00:00Z",
      confidence: 0.91,
      brain_citations: [{ note_id: "n2", title: "t2" }],
      decision_evidence: { reason_text: "because (v2)" },
    };
    expect(fingerprint(reEmit1)).toBe(fingerprint(reEmit2));
    expect(fingerprint(reEmit1)).toBe(fingerprint(base));
  });

  it("a GENUINE recommendation change → DIFFERENT fingerprint (NOT deduped)", () => {
    const a = { action: "pause_campaign", target: "promo-q3" };
    const b = { action: "pause_campaign", target: "promo-q4" };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("null / empty body is stable", () => {
    expect(fingerprint(null)).toBe(fingerprint({}));
  });
});

type Routing = { autonomy: string; handler: string | null };
type Row = {
  id: string;
  tenant_id: string;
  decision_class: string;
  body: Record<string, unknown>;
  status: string;
  autonomy: string;
  handler: string | null;
};

function makeEmit() {
  const rows: Row[] = [];
  let seq = 0;
  function emit(
    tenant_id: string,
    decision_class: string,
    body: Record<string, unknown>,
    routing: Routing = { autonomy: "approval", handler: null },
  ): string {
    const isMetaAds = decision_class.startsWith("meta_ads.");
    if (!isMetaAds) {
      const fp = fingerprint(body);
      const existing = rows.find(
        (r) =>
          r.tenant_id === tenant_id &&
          r.decision_class === decision_class &&
          r.status === "proposed" &&
          r.autonomy === routing.autonomy &&
          r.handler === routing.handler &&
          fingerprint(r.body) === fp,
      );
      if (existing) return existing.id;
    }
    const id = `dec-${++seq}`;
    rows.push({
      id,
      tenant_id,
      decision_class,
      body,
      status: "proposed",
      autonomy: routing.autonomy,
      handler: routing.handler,
    });
    return id;
  }
  return { rows, emit };
}

describe("emit_decision keep-existing dedup (non-meta_ads)", () => {
  const T = "tenant-1";

  it("two identical emits → ONE proposed row, the SECOND returns the FIRST's id (no re-insert)", () => {
    const { rows, emit } = makeEmit();
    const id1 = emit(T, "chief-of-staff.daily-digest", { action: "x", body: "same" });
    const id2 = emit(T, "chief-of-staff.daily-digest", { action: "x", body: "same" });
    expect(id2).toBe(id1);
    expect(rows.filter((r) => r.status === "proposed").length).toBe(1);
    expect(rows[0].status).toBe("proposed");
  });

  it("re-emit differing only in volatile keys → still returns the existing id (one row)", () => {
    const { rows, emit } = makeEmit();
    const id1 = emit(T, "engineer.ship-pr", { repo: "x/y", title: "fix", source_run_id: "run-a" });
    const id2 = emit(T, "engineer.ship-pr", { repo: "x/y", title: "fix", source_run_id: "run-b", emitted_at: "later" });
    expect(id2).toBe(id1);
    expect(rows.length).toBe(1);
  });

  it("a genuinely-different recommendation → NEW row (not deduped)", () => {
    const { rows, emit } = makeEmit();
    emit(T, "engineer.ship-pr", { repo: "x/y", title: "fix A" });
    emit(T, "engineer.ship-pr", { repo: "x/y", title: "fix B" });
    expect(rows.length).toBe(2);
  });

  it("same fingerprint but DIFFERENT autonomy (approval→auto flip) → NOT deduped, NEW row", () => {
    const { rows, emit } = makeEmit();
    const id1 = emit(T, "engineer.ship-pr", { repo: "x/y", title: "fix" }, { autonomy: "approval", handler: "github.open_pr" });
    const id2 = emit(T, "engineer.ship-pr", { repo: "x/y", title: "fix" }, { autonomy: "auto", handler: "github.open_pr" });
    expect(id2).not.toBe(id1);
    expect(rows.length).toBe(2);
  });

  it("same fingerprint but DIFFERENT handler → NOT deduped, NEW row", () => {
    const { rows, emit } = makeEmit();
    const id1 = emit(T, "some.class", { x: 1 }, { autonomy: "approval", handler: "handler.a" });
    const id2 = emit(T, "some.class", { x: 1 }, { autonomy: "approval", handler: "handler.b" });
    expect(id2).not.toBe(id1);
    expect(rows.length).toBe(2);
  });

  it("same fingerprint AND same autonomy + handler → deduped (existing id, one row)", () => {
    const { rows, emit } = makeEmit();
    const r: Routing = { autonomy: "approval", handler: "github.open_pr" };
    const id1 = emit(T, "engineer.ship-pr", { repo: "x/y", title: "fix" }, r);
    const id2 = emit(T, "engineer.ship-pr", { repo: "x/y", title: "fix" }, r);
    expect(id2).toBe(id1);
    expect(rows.length).toBe(1);
  });

  it("meta_ads.* path is NOT keep-existing — newest always inserts (its own supersede runs in SQL)", () => {
    const { rows, emit } = makeEmit();
    const id1 = emit(T, "meta_ads.set_status", { object_id: "ad-1", status: "PAUSED" });
    const id2 = emit(T, "meta_ads.set_status", { object_id: "ad-1", status: "PAUSED" });
    expect(id2).not.toBe(id1);
    expect(rows.length).toBe(2);
  });
});
