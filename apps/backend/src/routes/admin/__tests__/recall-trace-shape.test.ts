
import { describe, it, expect } from "vitest";
import {
  extractRecalledNotes,
  shapeRecallTrace,
  RECALL_TRACE_LEGEND,
  type RecallTraceRunRow,
  type RecallTraceTraceRow,
  type RecallTraceDecisionRow,
} from "../recall-trace";

const run: RecallTraceRunRow = { id: "run-1", agent_slug: "support-lead", status: "success" };

function trace(rank_components: Record<string, unknown> | null): RecallTraceTraceRow {
  return {
    query_hash: "h",
    returned_count: 2,
    retrieval_mode: "rerank",
    rerank_status: "ok",
    status: "ok",
    latency_ms: 120,
    created_at: "2026-01-01T00:00:00Z",
    rank_components,
  };
}

describe("extractRecalledNotes", () => {
  it("parses the new returned_notes [{id,score}] shape", () => {
    const out = extractRecalledNotes([trace({ returned_notes: [{ id: "n1", score: 0.9 }, { id: "n2", score: 0.5 }] })]);
    expect(out).toEqual([{ note_id: "n1", score: 0.9 }, { note_id: "n2", score: 0.5 }]);
  });

  it("falls back to legacy returned_note_ids (string[]) with score=null", () => {
    const out = extractRecalledNotes([trace({ returned_note_ids: ["n1", "n2"] })]);
    expect(out).toEqual([{ note_id: "n1", score: null }, { note_id: "n2", score: null }]);
  });

  it("unions across traces, dedup-preserving first-seen (keeps first score)", () => {
    const out = extractRecalledNotes([
      trace({ returned_notes: [{ id: "n1", score: 0.9 }, { id: "n2", score: 0.5 }] }),
      trace({ returned_notes: [{ id: "n2", score: 0.1 }, { id: "n3", score: 0.3 }] }),
    ]);
    expect(out).toEqual([
      { note_id: "n1", score: 0.9 },
      { note_id: "n2", score: 0.5 },
      { note_id: "n3", score: 0.3 },
    ]);
  });

  it("tolerates null / missing / non-array rank_components", () => {
    expect(extractRecalledNotes([trace(null)])).toEqual([]);
    expect(extractRecalledNotes([trace({})])).toEqual([]);
    expect(extractRecalledNotes([trace({ returned_notes: "nope" })])).toEqual([]);
  });

  it("skips malformed pair entries + non-string ids; coexists with floor diag", () => {
    const out = extractRecalledNotes([
      trace({ floor_value: 0.35, floor_dropped: 1, returned_notes: [{ id: "n1", score: 0.4 }, { id: 7 }, null, "x", { score: 0.2 }] }),
    ]);
    expect(out).toEqual([{ note_id: "n1", score: 0.4 }]);
  });

  it("non-number score → null", () => {
    const out = extractRecalledNotes([trace({ returned_notes: [{ id: "n1", score: "high" }] })]);
    expect(out).toEqual([{ note_id: "n1", score: null }]);
  });
});

describe("shapeRecallTrace", () => {
  it("hydrates recalled_notes with titles + scores; keeps bare recalled_note_ids", () => {
    const titleById = new Map([["n1", "Payout policy"], ["n2", "Refund window"]]);
    const out = shapeRecallTrace(
      run,
      [trace({ returned_notes: [{ id: "n1", score: 0.9 }, { id: "n2", score: 0.5 }] })],
      [],
      titleById,
    );
    expect(out.recalled_notes).toEqual([
      { note_id: "n1", title: "Payout policy", score: 0.9 },
      { note_id: "n2", title: "Refund window", score: 0.5 },
    ]);
    expect(out.recalled_note_ids).toEqual(["n1", "n2"]);
  });

  it("missing title in the map → empty string (never undefined)", () => {
    const out = shapeRecallTrace(run, [trace({ returned_notes: [{ id: "n1", score: 0.9 }] })], [], new Map());
    expect(out.recalled_notes).toEqual([{ note_id: "n1", title: "", score: 0.9 }]);
  });

  it("legacy returned_note_ids rows still produce recalled_notes (score null)", () => {
    const out = shapeRecallTrace(run, [trace({ returned_note_ids: ["n1"] })], [], new Map([["n1", "Old note"]]));
    expect(out.recalled_notes).toEqual([{ note_id: "n1", title: "Old note", score: null }]);
    expect(out.recalled_note_ids).toEqual(["n1"]);
  });

  it("extracts {note_id,title} from decisions.body.brain_citations, deduped", () => {
    const decisions: RecallTraceDecisionRow[] = [
      { body: { brain_citations: [{ note_id: "c1", title: "Refund policy" }] } },
      { body: { brain_citations: [{ note_id: "c1", title: "dup" }, { note_id: "c2", title: "Payout" }] } },
    ];
    const out = shapeRecallTrace(run, [], decisions);
    expect(out.brain_citations).toEqual([
      { note_id: "c1", title: "Refund policy" },
      { note_id: "c2", title: "Payout" },
    ]);
  });

  it("tolerates null body / non-array brain_citations; defaults bad title to ''", () => {
    expect(shapeRecallTrace(run, [], [{ body: null }]).brain_citations).toEqual([]);
    expect(shapeRecallTrace(run, [], [{ body: { brain_citations: "nope" } }]).brain_citations).toEqual([]);
    expect(
      shapeRecallTrace(run, [], [{ body: { brain_citations: [{ note_id: "c1" }, { note_id: 7 }, null] } }]).brain_citations,
    ).toEqual([{ note_id: "c1", title: "" }]);
  });

  it("search_traces projection DROPS rank_components (no id/score leak in per-trace view)", () => {
    const out = shapeRecallTrace(run, [trace({ returned_notes: [{ id: "n1", score: 0.9 }] })], []);
    expect(out.search_traces).toHaveLength(1);
    expect(out.search_traces[0]).toEqual({
      query_hash: "h",
      returned_count: 2,
      retrieval_mode: "rerank",
      rerank_status: "ok",
      status: "ok",
      latency_ms: 120,
      created_at: "2026-01-01T00:00:00Z",
    });
    expect("rank_components" in out.search_traces[0]).toBe(false);
  });

  it("always includes the channel legend", () => {
    expect(shapeRecallTrace(run, [], []).legend).toBe(RECALL_TRACE_LEGEND);
  });

  it("empty inputs → empty arrays + run metadata + legend", () => {
    const out = shapeRecallTrace(run, [], []);
    expect(out).toEqual({
      run_id: "run-1",
      agent_slug: "support-lead",
      status: "success",
      recalled_notes: [],
      recalled_note_ids: [],
      brain_citations: [],
      search_traces: [],
      legend: RECALL_TRACE_LEGEND,
    });
  });
});
