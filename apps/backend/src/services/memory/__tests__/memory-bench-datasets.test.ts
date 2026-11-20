
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
// @ts-expect-error — .mjs sibling harness, no type decls (pure JS, intentional).
import { parseLongMemEval, parseLoCoMo, flattenCanonical } from "../../../../scripts/lib/public-dataset-loader.mjs";
// @ts-expect-error — .mjs sibling harness, no type decls (pure JS, intentional).
import { scoreRecall, makeLexicalCosineSearch } from "../../../../scripts/lib/memory-bench-public-score.mjs";
import { runMemoryRecallEval, type Golden } from "../recall-eval";

const TENANT = "00000000-0000-4000-8000-000000000human";
const SUBSET = path.resolve(
  __dirname,
  "../../../../scripts/fixtures/public-datasets/longmemeval-oracle-subset.json",
);

const LME_SAMPLE = [
  {
    question_id: "q_temporal_1",
    question_type: "temporal-reasoning",
    question: "What was the first issue with the car after its first service?",
    answer: "GPS not working",
    haystack_session_ids: ["s_a", "s_b"],
    haystack_sessions: [
      [
        { role: "user", content: "Took the car in for its first service today." },
        { role: "assistant", content: "How did it go?" },
      ],
      [
        { role: "user", content: "After the service the GPS system stopped working correctly." },
        { role: "assistant", content: "That's frustrating." },
      ],
    ],
    answer_session_ids: ["s_b"],
  },
  {
    question_id: "q_temporal_1_abs",
    question_type: "temporal-reasoning",
    question: "What color did they repaint the car?",
    answer: "no information available",
    haystack_session_ids: ["s_c"],
    haystack_sessions: [[{ role: "user", content: "The weather was nice this week." }]],
    answer_session_ids: ["answer_q_temporal_1_abs_1"],
  },
];

const LOCOMO_SAMPLE = [
  {
    sample_id: "conv-test",
    conversation: {
      speaker_a: "Caroline",
      speaker_b: "Melanie",
      session_1_date_time: "1 May 2023",
      session_1: [
        { speaker: "Caroline", dia_id: "D1:1", text: "Hi Mel, how are you?" },
        { speaker: "Melanie", dia_id: "D1:2", text: "I went to the LGBTQ support group on 7 May." },
      ],
      session_2_date_time: "9 May 2023",
      session_2: [{ speaker: "Caroline", dia_id: "D2:1", text: "I painted a sunrise last year." }],
    },
    qa: [
      { question: "When did Melanie attend the support group?", answer: "7 May", evidence: ["D1:2"], category: 2 },
      { question: "What did Caroline realize?", evidence: ["D2:1"], category: 5, adversarial_answer: "nothing" },
      { question: "Question with no resolvable evidence", evidence: ["D9:9"], category: 4 },
    ],
  },
];

describe("public-dataset loader — LongMemEval", () => {
  it("maps sessions→notes and answer_session_ids→expected; drops abstention by default", () => {
    const doc = parseLongMemEval(LME_SAMPLE);
    expect(doc.cases.length).toBe(1);
    const c = doc.cases[0];
    expect(c.notes.map((n: { id: string }) => n.id)).toEqual(["q_temporal_1::s_a", "q_temporal_1::s_b"]);
    expect(c.notes[1].body).toContain("user: After the service the GPS system stopped working correctly.");
    expect(c.questions[0].expected_note_ids).toEqual(["q_temporal_1::s_b"]);
    expect(c.questions[0].type).toBe("temporal-reasoning");
  });

  it("includeAbstention=true keeps the abstention entry as a negative golden (empty expected)", () => {
    const doc = parseLongMemEval(LME_SAMPLE, { includeAbstention: true });
    expect(doc.cases.length).toBe(2);
    const abs = doc.cases.find((x: { id: string }) => x.id.endsWith("_abs"));
    expect(abs.questions[0].expected_note_ids).toEqual([]);
  });
});

describe("public-dataset loader — LoCoMo", () => {
  it("maps turns→notes and evidence→expected; drops adversarial + unresolvable-evidence", () => {
    const doc = parseLoCoMo(LOCOMO_SAMPLE);
    expect(doc.cases.length).toBe(1);
    const c = doc.cases[0];
    expect(c.notes.map((n: { id: string }) => n.id)).toEqual(["conv-test::D1:1", "conv-test::D1:2", "conv-test::D2:1"]);
    expect(c.notes[1].body).toBe("Melanie: I went to the LGBTQ support group on 7 May.");
    expect(c.questions.length).toBe(1);
    expect(c.questions[0].expected_note_ids).toEqual(["conv-test::D1:2"]);
    expect(c.questions[0].type).toBe("temporal-reasoning");
  });

  it("includeAdversarial=true keeps category-5 as a negative golden", () => {
    const doc = parseLoCoMo(LOCOMO_SAMPLE, { includeAdversarial: true });
    const adv = doc.cases[0].questions.find((q: { type: string }) => q.type === "adversarial");
    expect(adv).toBeTruthy();
    expect(adv.expected_note_ids).toEqual([]);
  });
});

describe("public-dataset benchmark — scorer parity with canonical recall-eval", () => {
  it("scoreRecall (.mjs) == runMemoryRecallEval (.ts) on loaded LongMemEval goldens", async () => {
    const flat = flattenCanonical(parseLongMemEval(LME_SAMPLE));
    expect(flat.goldens.length).toBeGreaterThan(0);
    const lex = makeLexicalCosineSearch(flat.corpus);

    const pub = await scoreRecall({ goldens: flat.goldens, search: (q: string, k: number) => lex(q, k) });

    const canonGoldens: Golden[] = flat.goldens.map((g: { id: string; query: string; expected_note_ids: string[] }) => ({
      id: g.id,
      tenant_id: TENANT,
      query: g.query,
      expected_note_ids: g.expected_note_ids,
    }));
    const canon = await runMemoryRecallEval(
      { tenant_id: TENANT, mode: "eval", goldens: canonGoldens, threshold: 0 },
      {
        search: async (_t, q, k) => (await lex(q, k)).map((h: { note_id: string }) => ({ note_id: h.note_id })),
        verifyTenantNotes: async (_t, ids) => new Set(ids),
      },
    );
    expect(pub.top3_recall).toBe(canon.top3_recall);
    expect(pub.mrr).toBe(canon.mrr);
    expect(pub.queries_run).toBe(canon.queries_run);
    expect(canon.cross_tenant_hits).toBe(0);
  });
});

describe("public-dataset benchmark — committed LongMemEval subset is real + discriminates", () => {
  it("the committed MIT subset parses, has real scale, and the lexical baseline recall@3 is in (0,1)", async () => {
    expect(existsSync(SUBSET)).toBe(true);
    const wrapper = JSON.parse(readFileSync(SUBSET, "utf8"));
    expect(wrapper.license).toBe("MIT");
    expect(wrapper.dataset).toBe("longmemeval_oracle");
    expect(Array.isArray(wrapper.entries)).toBe(true);
    expect(wrapper.entries.length).toBeGreaterThanOrEqual(30);

    const flat = flattenCanonical(parseLongMemEval(wrapper.entries));
    expect(flat.goldens.length).toBe(wrapper.entries.length);
    expect(flat.corpus.length).toBeGreaterThan(flat.goldens.length);

    const lex = makeLexicalCosineSearch(flat.corpus);
    const r = await scoreRecall({ goldens: flat.goldens, search: (q: string, k: number) => lex(q, k) });
    expect(r.top3_recall).toBeGreaterThan(0);
    expect(r.top3_recall).toBeLessThan(1);
    expect(r.failures.length).toBeGreaterThan(0);
  });
});
