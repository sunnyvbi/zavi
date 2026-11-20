
const LOCOMO_CATEGORY = {
  1: "multi-hop",
  2: "temporal-reasoning",
  3: "open-domain-knowledge",
  4: "single-hop",
  5: "adversarial",
};

export function parseLongMemEval(records, opts = {}) {
  const includeAbstention = opts.includeAbstention ?? false;
  if (!Array.isArray(records)) throw new Error("parseLongMemEval: expected an array of entries");
  const cases = [];
  for (const e of records) {
    const qid = e.question_id;
    const isAbs = typeof qid === "string" && qid.endsWith("_abs");
    if (isAbs && !includeAbstention) continue;

    const sessionIds = e.haystack_session_ids ?? [];
    const sessions = e.haystack_sessions ?? [];
    if (sessionIds.length !== sessions.length) {
      throw new Error(`parseLongMemEval: ${qid} session id/array length mismatch`);
    }
    const nsId = (sid) => `${qid}::${sid}`;
    const notes = [];
    const localIds = new Set();
    for (let i = 0; i < sessions.length; i++) {
      const sid = sessionIds[i];
      localIds.add(sid);
      const body = (sessions[i] ?? [])
        .map((t) => `${t.role}: ${t.content}`)
        .join("\n");
      notes.push({ id: nsId(sid), title: `Session ${i + 1}`, body });
    }
    const expected = (e.answer_session_ids ?? [])
      .filter((sid) => localIds.has(sid))
      .map(nsId);

    cases.push({
      id: qid,
      title: e.question_type ?? "question",
      notes,
      questions: [
        {
          id: qid,
          type: e.question_type ?? "fact",
          query: e.question,
          expected_note_ids: isAbs ? [] : expected,
        },
      ],
    });
  }
  return { suite: "longmemeval", source: "longmemeval", cases };
}

export function parseLoCoMo(records, opts = {}) {
  const includeAdversarial = opts.includeAdversarial ?? false;
  if (!Array.isArray(records)) throw new Error("parseLoCoMo: expected an array of conversations");
  const cases = [];
  for (const rec of records) {
    const sampleId = rec.sample_id ?? `conv-${cases.length}`;
    const conv = rec.conversation ?? {};
    const nsId = (dia) => `${sampleId}::${dia}`;
    const notes = [];
    const turnIds = new Set();
    const sessionKeys = Object.keys(conv)
      .filter((k) => /^session_\d+$/.test(k))
      .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));
    for (const sk of sessionKeys) {
      for (const turn of conv[sk] ?? []) {
        if (!turn || !turn.dia_id) continue;
        turnIds.add(turn.dia_id);
        notes.push({
          id: nsId(turn.dia_id),
          title: sk,
          body: `${turn.speaker}: ${turn.text}`,
        });
      }
    }
    const questions = [];
    const qa = rec.qa ?? [];
    for (let i = 0; i < qa.length; i++) {
      const q = qa[i];
      const cat = q.category;
      if (cat === 5 && !includeAdversarial) continue;
      const evidence = Array.isArray(q.evidence) ? q.evidence : [];
      const expected = evidence.filter((d) => turnIds.has(d)).map(nsId);
      if (cat !== 5 && expected.length === 0) continue;
      questions.push({
        id: `${sampleId}::q${i}`,
        type: LOCOMO_CATEGORY[cat] ?? "fact",
        query: q.question,
        expected_note_ids: cat === 5 ? [] : expected,
      });
    }
    if (questions.length === 0) continue;
    cases.push({ id: sampleId, title: `LoCoMo ${sampleId}`, notes, questions });
  }
  return { suite: "locomo", source: "locomo", cases };
}

export function flattenCanonical(doc) {
  const corpus = [];
  const goldens = [];
  for (const c of doc.cases ?? []) {
    for (const n of c.notes ?? []) {
      corpus.push({ note_id: n.id, title: n.title ?? "", body: n.body ?? "" });
    }
    for (const q of c.questions ?? []) {
      goldens.push({
        id: q.id,
        case_id: c.id,
        type: q.type ?? "fact",
        query: q.query,
        expected_note_ids: q.expected_note_ids ?? [],
        expected_order: q.expected_order ?? undefined,
      });
    }
  }
  return {
    suite: doc.suite ?? "public-dataset",
    source: doc.source,
    case_count: (doc.cases ?? []).length,
    corpus,
    goldens,
  };
}
