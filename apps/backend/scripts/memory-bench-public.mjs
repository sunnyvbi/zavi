
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scoreRecall, makeLexicalCosineSearch } from "./lib/memory-bench-public-score.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "fixtures/memory-public-bench/cases.json");

const LIVE = /^(1|true|yes|on)$/i.test(process.env.MEMORY_PUBLIC_BENCH_LIVE ?? "");
const WANT_JSON = process.argv.includes("--json");

export function loadFixtures(file = FIXTURES) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const corpus = [];
  const goldens = [];
  for (const c of raw.cases ?? []) {
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
    suite: raw.suite ?? "public-memory-bench",
    case_count: (raw.cases ?? []).length,
    corpus,
    goldens,
  };
}

function hermeticSearch(corpus) {
  const search = makeLexicalCosineSearch(corpus);
  return async (query, k) => search(query, k);
}

const BENCH_BOOSTS = { backlink: true, recency: true, salience: true, outcome: true, reranker: true };

async function liveRun(corpus, goldens) {
  const distDir = path.resolve(__dirname, "../dist");
  let memory;
  try {
    memory = await import(path.join(distDir, "src/services/memory/index.js"));
  } catch (e) {
    throw new Error(
      `LIVE mode needs the compiled pipeline. Run \`npm run build\` in apps/backend first.\n` +
        `  (tried: ${path.join(distDir, "src/services/memory/index.js")})\n` +
        `  underlying: ${e?.message || e}`,
    );
  }
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const tenant_id = `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;
  const slug = `zz-bench-${tenant_id.slice(-8)}`;

  const { error: tErr } = await sb
    .from("tenants")
    .insert({ id: tenant_id, slug, display_name: slug, kind: "test" });
  if (tErr) {
    throw new Error(`LIVE mode: could not create throwaway tenant ${tenant_id}: ${tErr.message}`);
  }

  const cleanup = async () => {
    try {
      await sb.from("tenants").update({ kind: "test" }).eq("id", tenant_id);
      const { error } = await sb.from("tenants").delete().eq("id", tenant_id);
      if (error) {
        console.warn(`[bench] LIVE cleanup failed for throwaway tenant ${tenant_id}: ${error.message ?? error} — manual cleanup may be needed`);
      }
    } catch (e) {
      console.warn(`[bench] LIVE cleanup failed for throwaway tenant ${tenant_id}: ${e?.message || e} — manual cleanup may be needed`);
    }
  };

  try {
    const idMap = new Map();
    for (const n of corpus) {
      const res = await memory.writeNote(tenant_id, {
        title: n.title,
        body_markdown: n.body,
        source: "human",
      });
      idMap.set(n.note_id, res.note_id);
    }

    const liveGoldens = goldens.map((g) => ({
      ...g,
      expected_note_ids: (g.expected_note_ids ?? []).map((id) => idMap.get(id) ?? id),
      expected_order: g.expected_order
        ? g.expected_order.map((id) => idMap.get(id) ?? id)
        : undefined,
    }));

    const search = async (query, k) => {
      const hits = await memory.searchMemory(tenant_id, query, k, {
        agent_slug: "memory-bench-public",
        boostOverride: BENCH_BOOSTS,
      });
      return hits.map((h) => ({ note_id: h.note_id, body: h.body }));
    };

    const scored = await scoreRecall({ goldens: liveGoldens, search });
    return { tenant_id, scored };
  } finally {
    await cleanup();
  }
}

function printTable(suite, caseCount, mode, corpusSize, result) {
  const pad = (s, n) => String(s).padEnd(n);
  const misses = result.failures;
  console.log(`\n=== Zavi public memory benchmark — ${suite} ===`);
  console.log(`NOTE: SAMPLE harness (${caseCount} conversations, ${result.queries_run} questions, hand-authored in the`);
  console.log(`      LongMemEval/LoCoMo STYLE). This is NOT the full published LongMemEval/LoCoMo`);
  console.log(`      score — drop the full datasets into cases.json (same shape) to publish a number.`);
  console.log(`mode:        ${mode}${mode === "hermetic" ? " (flag MEMORY_PUBLIC_BENCH_LIVE OFF — offline lexical baseline)" : " (live production pipeline)"}`);
  console.log(`corpus:      ${corpusSize} notes`);
  console.log(`questions:   ${result.queries_run}`);
  console.log("");
  console.log(`  ${pad("metric", 14)} value`);
  console.log(`  ${pad("recall@3", 14)} ${result.top3_recall.toFixed(4)}`);
  console.log(`  ${pad("MRR", 14)} ${result.mrr.toFixed(4)}`);
  console.log("");
  if (misses.length) {
    console.log(`  misses (${misses.length}/${result.queries_run}) — these prove the set discriminates:`);
    for (const f of misses) {
      console.log(`    - [${f.golden_id}/${f.type}] "${f.query}"  expected=${JSON.stringify(f.expected)} got_top3=${JSON.stringify(f.returned_note_ids_top3)}`);
    }
  } else {
    console.log(`  misses: none — all ${result.queries_run} questions answered from the top-3.`);
  }
  if (mode === "hermetic") {
    console.log("");
    console.log(`  (Baseline = lexical cosine; the misses above are paraphrase/multi-hop questions`);
    console.log(`   a semantic retriever should win. Run with MEMORY_PUBLIC_BENCH_LIVE=1 after`);
    console.log(`   \`npm run build\` to score the real production pipeline.)`);
  }
  console.log("");
}

async function main() {
  const { suite, case_count, corpus, goldens } = loadFixtures();
  if (goldens.length === 0) {
    console.error("[memory-bench-public] no questions in fixtures — nothing to measure.");
    process.exit(1);
  }

  let mode, scored;
  if (!LIVE) {
    mode = "hermetic";
    scored = await scoreRecall({ goldens, search: hermeticSearch(corpus) });
  } else {
    mode = "live";
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error("[memory-bench-public] LIVE mode requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.");
      process.exit(1);
    }
    ({ scored } = await liveRun(corpus, goldens));
  }

  printTable(suite, case_count, mode, corpus.length, scored);

  if (WANT_JSON) {
    console.log(JSON.stringify(
      { ts: new Date().toISOString(), suite, case_count, mode, corpus_size: corpus.length, queries_run: scored.queries_run, top3_recall: scored.top3_recall, mrr: scored.mrr, failures: scored.failures },
      null,
      2,
    ));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[memory-bench-public] FAILED:", e);
    process.exit(1);
  });
}
