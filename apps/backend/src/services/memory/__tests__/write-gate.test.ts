import { describe, it, expect } from "vitest";
import {
  detectValueKind,
  finalTrustTier,
  jaccard,
  normalizeKey,
  parseGateFields,
  renderSavedMemoryBlock,
  resolveGateDecision,
  valueTokens,
  writeGateRules,
  type ExistingFact,
  type GateCandidate,
} from "../write-gate";

function fact(over: Partial<ExistingFact> & { ref: string }): ExistingFact {
  return {
    note_id: `note-${over.ref}`,
    title: "Launch month",
    body: "The India launch is planned for June.",
    note_type: "tenant_project",
    subject: "india launch",
    attribute: "month",
    value_kind: "other",
    source_class: "user_stated",
    trust_tier: 2,
    recalled: false,
    ...over,
  };
}

function cand(over: Partial<GateCandidate>): GateCandidate {
  return {
    action: "add",
    target: null,
    title: "Launch month",
    body: "The India launch moved to July.",
    subject: "india launch",
    attribute: "month",
    value_kind: "other",
    source_class: "user_stated",
    reason: null,
    ...over,
  };
}

const byRef = (...fs: ExistingFact[]) => new Map(fs.map((f) => [f.ref, f]));

describe("resolveGateDecision", () => {
  it("junk is rejected whatever the model said", () => {
    const d = resolveGateDecision(
      cand({ action: "add", title: "Moves", body: '<goal_moves> {"move":"x"}' }),
      byRef(),
      2,
    );
    expect(d).toEqual({ kind: "reject", reason: "junk:tagged_envelope", junk: true });
  });

  it("a model reject is logged with its reason", () => {
    const d = resolveGateDecision(cand({ action: "reject", reason: "one-off status" }), byRef(), 2);
    expect(d).toMatchObject({ kind: "reject", reason: "one-off status", junk: false });
  });

  it("update on an exact key match replaces the note", () => {
    const e = fact({ ref: "E1" });
    const d = resolveGateDecision(cand({ action: "update", target: "E1" }), byRef(e), 2);
    expect(d).toEqual({ kind: "update", target: e });
  });

  it("update without a key match keeps both (adds)", () => {
    const e = fact({ ref: "E1", attribute: "owner" });
    const d = resolveGateDecision(cand({ action: "update", target: "E1" }), byRef(e), 2);
    expect(d).toEqual({ kind: "add", reason: "update_key_mismatch" });
  });

  it("update against a legacy note with no keys keeps both", () => {
    const e = fact({ ref: "E1", subject: null, attribute: null });
    const d = resolveGateDecision(cand({ action: "update", target: "E1" }), byRef(e), 2);
    expect(d.kind).toBe("add");
  });

  it("an id / money / rate fact is never replaced: it opens a conflict", () => {
    const e = fact({
      ref: "E1",
      title: "Take rate",
      body: "Current take rate is 15%.",
      subject: "take rate",
      attribute: "current value",
      value_kind: null,
    });
    const d = resolveGateDecision(
      cand({
        action: "update",
        target: "E1",
        title: "Take rate",
        body: "Current take rate is 18%.",
        subject: "take rate",
        attribute: "current value",
        value_kind: "other",
      }),
      byRef(e),
      0,
    );
    expect(d).toEqual({ kind: "conflict", target: e, reason: "protected_value" });
  });

  it("a lower-trust source cannot replace a higher-trust note: conflict", () => {
    const e = fact({ ref: "E1", trust_tier: 0 });
    const d = resolveGateDecision(cand({ action: "update", target: "E1" }), byRef(e), 2);
    expect(d).toEqual({ kind: "conflict", target: e, reason: "lower_trust" });
  });

  it("a duplicate is skipped and names the note it matched", () => {
    const e = fact({ ref: "E1" });
    const d = resolveGateDecision(
      cand({ action: "duplicate", target: "E1", body: "India launch is in June." }),
      byRef(e),
      2,
    );
    expect(d).toMatchObject({ kind: "duplicate", matched: e });
  });

  it("a 'duplicate' carrying a new number is treated as an update request", () => {
    const e = fact({
      ref: "E1",
      title: "Pixel",
      body: "The Meta pixel ID is 1234567890.",
      subject: "meta pixel",
      attribute: "id",
      value_kind: "id",
    });
    const d = resolveGateDecision(
      cand({
        action: "duplicate",
        target: "E1",
        title: "Pixel",
        body: "The Meta pixel ID is 9876543210.",
        subject: "meta pixel",
        attribute: "id",
        value_kind: "id",
      }),
      byRef(e),
      0,
    );
    expect(d).toEqual({ kind: "conflict", target: e, reason: "protected_value" });
  });

  it("an 'add' that restates a recalled note is a duplicate (the re-extraction loop)", () => {
    const r = fact({ ref: "R1", recalled: true, body: "The India launch is planned for June." });
    const d = resolveGateDecision(
      cand({ action: "add", body: "The India launch is planned for June.", title: "Launch month" }),
      byRef(r),
      2,
    );
    expect(d).toEqual({ kind: "duplicate", matched: r, reason: "restates_recalled_note" });
  });

  it("an 'add' with a changed number is not swallowed by the near-verbatim backstop", () => {
    const e = fact({ ref: "E1", title: "Hosts", body: "We have 612 active hosts." });
    const d = resolveGateDecision(
      cand({ action: "add", title: "Hosts", body: "We have 700 active hosts." }),
      byRef(e),
      2,
    );
    expect(d.kind).toBe("add");
  });

  it("an unresolved target falls back to add and says why", () => {
    const d = resolveGateDecision(cand({ action: "update", target: "E9" }), byRef(), 2);
    expect(d).toEqual({ kind: "add", reason: "update_target_unresolved" });
  });

  it("same key and same value is a duplicate, not an update", () => {
    const e = fact({ ref: "E1", body: "The India launch is planned for June." });
    const d = resolveGateDecision(
      cand({ action: "update", target: "E1", body: "The India launch is planned for June." }),
      byRef(e),
      2,
    );
    expect(d.kind).toBe("duplicate");
  });
});

describe("value kinds, keys, trust", () => {
  it("detects ids, money and rates", () => {
    expect(detectValueKind("The Meta pixel ID is 1234567890.")).toBe("id");
    expect(detectValueKind("Ad account act_99812345 is the main one.")).toBe("id");
    expect(detectValueKind("Starter costs $20 a month.")).toBe("money");
    expect(detectValueKind("Take rate is 15%.")).toBe("rate");
    expect(detectValueKind("We launch in June.")).toBe("other");
    expect(detectValueKind("We have 612 hosts.")).toBe("other");
  });

  it("normalizes keys", () => {
    expect(normalizeKey("  Meta Pixel!! ")).toBe("meta pixel");
    expect(normalizeKey("")).toBeNull();
    expect(normalizeKey(42)).toBeNull();
  });

  it("final trust tier never beats the caller ceiling or the source class", () => {
    expect(finalTrustTier(0, "user_stated")).toBe(0);
    expect(finalTrustTier(2, "user_stated")).toBe(2);
    expect(finalTrustTier(0, "fetched_web")).toBe(3);
    expect(finalTrustTier(0, "connector")).toBe(3);
    expect(finalTrustTier(0, "agent_inferred")).toBe(2);
  });

  it("similarity helpers", () => {
    expect(jaccard("the take rate is 15%", "take rate is 15%")).toBe(1);
    expect(valueTokens("$1,200 and 15%")).toEqual(new Set(["1200", "15%"]));
  });
});

describe("parseGateFields", () => {
  it("reads valid fields and upgrades an under-labelled protected value", () => {
    const f = parseGateFields(
      { action: "update", target: "E2", subject: "Meta Pixel", attribute: "ID", value_kind: "other", source: "user_stated" },
      "The pixel ID is 1234567890",
    );
    expect(f).toMatchObject({
      action: "update",
      target: "E2",
      subject: "meta pixel",
      attribute: "id",
      value_kind: "id",
      source_class: "user_stated",
    });
  });

  it("falls back safely on garbage", () => {
    const f = parseGateFields({ action: "delete", target: "../x", source: "admin" }, "hello");
    expect(f).toMatchObject({ action: "add", target: null, value_kind: "other", source_class: "agent_inferred" });
  });

  it("the model can make a fact more protected, never less", () => {
    expect(parseGateFields({ value_kind: "money" }, "we launch in June").value_kind).toBe("money");
  });
});

describe("prompt pieces", () => {
  it("renders saved memory inside an untrusted block with refs and keys", () => {
    const out = renderSavedMemoryBlock([fact({ ref: "E1" }), fact({ ref: "R1", recalled: true })]);
    expect(out).toContain("[E1]");
    expect(out).toContain("[R1] (recalled into this turn)");
    expect(out).toContain('subject="india launch"');
    expect(out).toMatch(/untrusted_saved_memory/);
  });

  it("says so when nothing is close", () => {
    expect(renderSavedMemoryBlock([])).toMatch(/none/);
  });

  it("only the chat rules allow agent_procedural", () => {
    expect(writeGateRules({ agentProcedural: true })).toContain('"agent_procedural"');
    expect(writeGateRules({ agentProcedural: false })).not.toContain("agent_procedural");
  });
});
