
import { describe, it, expect } from "vitest";
import {
  buildClarifyEnvelope,
  isQuestionSensitive,
  clarifyTextLooksSensitive,
  type ClarifyQuestion,
} from "../clarify-envelope";

function rawWithOption(opt: Record<string, unknown>, qextra: Record<string, unknown> = {}) {
  return {
    questions: [
      {
        id: "q1",
        text: "Which channel?",
        header: "Channel",
        type: "single",
        allow_other: false,
        options: [{ id: "o1", label: "Search", ...opt }],
        ...qextra,
      },
    ],
  };
}

const memProv = { source_id: "note-1", source_type: "memory", source_label: "your note" };

describe("P2 — prefill guard (buildClarifyEnvelope)", () => {
  it("keeps prefill+recommended when provenance.source_id matches a real hit", () => {
    const r = buildClarifyEnvelope({
      agentSlug: "listing-quality",
      rawInput: rawWithOption({ prefill: true, recommended: true, provenance: memProv }),
      realHitIds: new Set(["note-1"]),
    });
    const o = r.envelope.questions[0].options[0];
    expect(o.prefill).toBe(true);
    expect(o.recommended).toBe(true);
    expect(r.stripped).toEqual({ no_prov: 0, bad_source: 0, sensitive: 0 });
  });

  it("strips BOTH flags when there is no provenance (no_prov)", () => {
    const r = buildClarifyEnvelope({
      agentSlug: "listing-quality",
      rawInput: rawWithOption({ prefill: true, recommended: true }),
      realHitIds: new Set(["note-1"]),
    });
    const o = r.envelope.questions[0].options[0];
    expect(o.prefill).toBe(false);
    expect(o.recommended).toBe(false);
    expect(r.stripped.no_prov).toBe(1);
  });

  it("strips when source_id does NOT match a real hit (bad_source)", () => {
    const r = buildClarifyEnvelope({
      agentSlug: "listing-quality",
      rawInput: rawWithOption({ prefill: true, recommended: true, provenance: { ...memProv, source_id: "fabricated" } }),
      realHitIds: new Set(["note-1"]),
    });
    expect(r.envelope.questions[0].options[0].prefill).toBe(false);
    expect(r.stripped.bad_source).toBe(1);
  });

  it("strips connector-sourced prefill in P2.1 (bad_source)", () => {
    const r = buildClarifyEnvelope({
      agentSlug: "performance-marketer",
      rawInput: rawWithOption({ prefill: true, provenance: { source_id: "x", source_type: "connector", source_label: "Meta" } }),
      realHitIds: new Set(["x"]),
    });
    expect(r.envelope.questions[0].options[0].prefill).toBe(false);
    expect(r.stripped.bad_source).toBe(1);
  });

  it("strips prefill (keeps recommended) on a sensitive FLAG question", () => {
    const r = buildClarifyEnvelope({
      agentSlug: "listing-quality",
      rawInput: rawWithOption(
        { prefill: true, recommended: true, provenance: memProv },
        { sensitive: true, text: "Pick an option" },
      ),
      realHitIds: new Set(["note-1"]),
    });
    const o = r.envelope.questions[0].options[0];
    expect(o.prefill).toBe(false);
    expect(o.recommended).toBe(true);
    expect(r.stripped.sensitive).toBe(1);
  });

  it("strips prefill on a sensitive-SLUG agent (dispute-response)", () => {
    const r = buildClarifyEnvelope({
      agentSlug: "dispute-response",
      rawInput: rawWithOption({ prefill: true, provenance: memProv }, { text: "Pick an option" }),
      realHitIds: new Set(["note-1"]),
    });
    expect(r.envelope.questions[0].options[0].prefill).toBe(false);
    expect(r.stripped.sensitive).toBe(1);
  });

  it("strips prefill when the KEYWORD classifier fires (refund text)", () => {
    const r = buildClarifyEnvelope({
      agentSlug: "support-lead",
      rawInput: rawWithOption({ prefill: true, provenance: memProv }, { text: "Approve the refund amount?" }),
      realHitIds: new Set(["note-1"]),
    });
    expect(r.envelope.questions[0].options[0].prefill).toBe(false);
    expect(r.stripped.sensitive).toBe(1);
  });

  it("fail-closed: omitted realHitIds strips any prefill", () => {
    const r = buildClarifyEnvelope({
      agentSlug: "qa",
      rawInput: rawWithOption({ prefill: true, provenance: memProv }),
    });
    expect(r.envelope.questions[0].options[0].prefill).toBe(false);
    expect(r.stripped.bad_source).toBe(1);
  });

  it("partial/legacy provenance PRESERVES the card (strips prefill, no degrade) — codex-P2", () => {
    const r = buildClarifyEnvelope({
      agentSlug: "qa",
      rawInput: rawWithOption({ prefill: true, recommended: true, provenance: { source_id: "note-1", source: "legacy" } }),
      realHitIds: new Set(["note-1"]),
    });
    expect(r.degraded).toBe(false);
    expect(r.envelope.questions[0].type).toBe("single");
    expect(r.envelope.questions[0].options).toHaveLength(1);
    expect(r.envelope.questions[0].options[0].prefill).toBe(false);
    expect(r.envelope.questions[0].options[0].recommended).toBe(false);
    expect(r.stripped.bad_source).toBe(1);
  });

  it("classifier + helpers", () => {
    expect(clarifyTextLooksSensitive("what is the payout")).toBe(true);
    expect(clarifyTextLooksSensitive("which color theme")).toBe(false);
    const q = { id: "q", text: "pick", header: "P", type: "single", options: [], allow_other: false } as unknown as ClarifyQuestion;
    expect(isQuestionSensitive(q, "dispute-response")).toBe(true);
    expect(isQuestionSensitive(q, "qa")).toBe(false);
  });
});
