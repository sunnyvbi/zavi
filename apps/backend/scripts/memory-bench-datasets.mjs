
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scoreRecall, makeLexicalCosineSearch } from "./lib/memory-bench-public-score.mjs";
import { parseLongMemEval, parseLoCoMo, flattenCanonical } from "./lib/public-dataset-loader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "fixtures/public-datasets");
const LME_SUBSET = path.join(DATA_DIR, "longmemeval-oracle-subset.json");
const LOCOMO_LOCAL = path.join(DATA_DIR, ".locomo-local/locomo10.json");

const LIVE = /^(1|true|yes|on)$/i.test(process.env.MEMORY_PUBLIC_BENCH_LIVE ?? "");
const WANT_JSON = process.argv.includes("--json");
const WRITE_SCORECARD = process.argv.includes("--write-scorecard");
const WITH_LOCOMO = process.argv.includes("--locomo");
const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
};
const LIVE_CASES = Number(arg("--live-cases") ?? (LIVE ? "15" : "0")) || 0;

const sliceCases = (doc, n) => (n > 0 ? { ...doc, cases: (doc.cases ?? []).slice(0, n) } : doc);

export function loadDatasets({ withLoCoMo = false, caseLimit = 0 } = {}) {
  if (!existsSync(LME_SUBSET)) {
    throw new Error(`missing ${LME_SUBSET} — run \`node scripts/refresh-public-datasets.mjs\` first.`);
  }
  const lmeWrapper = JSON.parse(readFileSync(LME_SUBSET, "utf8"));
  const lme = flattenCanonical(sliceCases(parseLongMemEval(lmeWrapper.entries), caseLimit));
  const datasets = [{ name: "longmemeval-oracle", license: "MIT", flat: lme, provenance: lmeWrapper }];

  if (withLoCoMo) {
    if (!existsSync(LOCOMO_LOCAL)) {
      throw new Error(
        `--locomo requested but ${LOCOMO_LOCAL} not present. ` +
          `Run \`node scripts/refresh-public-datasets.mjs --locomo-only\` (CC BY-NC, local-only).`,
      );
    }
    const raw = JSON.parse(readFileSync(LOCOMO_LOCAL, "utf8"));
    const loco = flattenCanonical(sliceCases(parseLoCoMo(raw.slice(0, 2)), caseLimit));
    datasets.push({ name: "locomo", license: "CC BY-NC 4.0", flat: loco, provenance: { note: "local-only, non-commercial" } });
  }
  return datasets;
}

const hermeticSearch = (corpus) => {
  const search = makeLexicalCosineSearch(corpus);
  return async (query, k) => search(query, k);
};

const BENCH_BOOSTS = { backlink: true, recency: true, salience: true, outcome: true, reranker: true };

async function liveRun(corpus, goldens) {
  const distDir = path.resolve(__dirname, "../dist");
  let memory;
  try {
    memory = await import(path.join(distDir, "src/services/memory/index.js"));
  } catch (e) {
    throw new Error(
      `LIVE mode needs the compiled pipeline. Run \`npm run build\` in apps/backend first.\n  underlying: ${e?.message || e}`,
    );
  }
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const tenant_id = `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;
  const slug = `zz-bench-${tenant_id.slice(-8)}`;
  const { error: tErr } = await sb.from("tenants").insert({ id: tenant_id, slug, display_name: slug, kind: "test" });
  if (tErr) throw new Error(`LIVE mode: could not create throwaway tenant ${tenant_id}: ${tErr.message}`);

  const cleanup = async () => {
    const childTables = [
      "memory_chunk",
      "memory_note_entity",
      "memory_entity",
      "memory_search_trace",
      "eval_candidates",
      "memory_note",
    ];
    try {
      for (const tbl of childTables) {
        const { error } = await sb.from(tbl).delete().eq("tenant_id", tenant_id);
        if (error) console.warn(`[bench] LIVE cleanup: ${tbl} delete error: ${error.message ?? error}`);
      }
      await sb.from("tenants").update({ kind: "test" }).eq("id", tenant_id);
      const { error } = await sb.from("tenants").delete().eq("id", tenant_id);
      if (error) console.warn(`[bench] LIVE cleanup failed for ${tenant_id}: ${error.message ?? error} — manual cleanup may be needed`);
    } catch (e) {
      console.warn(`[bench] LIVE cleanup failed for ${tenant_id}: ${e?.message || e} — manual cleanup may be needed`);
    }
  };

  const writeWithRetry = async (n) => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await memory.writeNote(tenant_id, { title: n.title, body_markdown: n.body, source: "human" });
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw lastErr;
  };

  try {
    const idMap = new Map();
    for (const n of corpus) {
      const res = await writeWithRetry(n);
      idMap.set(n.note_id, res.note_id);
    }
    const liveGoldens = goldens.map((g) => ({
      ...g,
      expected_note_ids: (g.expected_note_ids ?? []).map((id) => idMap.get(id) ?? id),
      expected_order: g.expected_order ? g.expected_order.map((id) => idMap.get(id) ?? id) : undefined,
    }));
    const search = async (query, k) => {
      const hits = await memory.searchMemory(tenant_id, query, k, {
        agent_slug: "memory-bench-datasets",
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

function byType(goldens, outcomes) {
  const map = new Map();
  for (let i = 0; i < goldens.length; i++) {
    const t = goldens[i].type ?? "fact";
    const o = outcomes[i];
    const rec = map.get(t) ?? { total: 0, hit: 0 };
    rec.total += 1;
    if (o?.hit) rec.hit += 1;
    map.set(t, rec);
  }
  return Object.fromEntries(
    [...map.entries()].sort().map(([t, r]) => [t, { n: r.total, recall: Number((r.hit / r.total).toFixed(4)) }]),
  );
}

function printTable(name, license, mode, flat, scored) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n=== ${name} (${license}) — mode: ${mode} ===`);
  console.log(`corpus:    ${flat.corpus.length} notes (${flat.case_count} conversations)`);
  console.log(`questions: ${scored.queries_run}`);
  console.log(`  ${pad("metric", 12)} value`);
  console.log(`  ${pad("recall@3", 12)} ${scored.top3_recall.toFixed(4)}`);
  console.log(`  ${pad("MRR", 12)} ${scored.mrr.toFixed(4)}`);
  console.log(`  by type: ${JSON.stringify(byType(flat.goldens, scored.outcomes))}`);
  if (scored.failures.length) {
    console.log(`  misses: ${scored.failures.length}/${scored.queries_run}`);
  }
}

async function main() {
  if (LIVE && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    console.error("[memory-bench-datasets] LIVE mode requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.");
    process.exit(1);
  }
  const mode = LIVE ? "live" : "hermetic";
  const datasets = loadDatasets({ withLoCoMo: WITH_LOCOMO, caseLimit: LIVE ? LIVE_CASES : 0 });
  if (LIVE && LIVE_CASES > 0) {
    console.log(`[memory-bench-datasets] LIVE bounded to first ${LIVE_CASES} conversations/dataset (heavy prod writes; use --live-cases 0 for full).`);
  }
  const results = [];

  for (const ds of datasets) {
    const { flat } = ds;
    if (flat.goldens.length === 0) {
      console.warn(`[memory-bench-datasets] ${ds.name}: no goldens, skipping.`);
      continue;
    }
    let scored;
    if (LIVE) {
      ({ scored } = await liveRun(flat.corpus, flat.goldens));
    } else {
      scored = await scoreRecall({ goldens: flat.goldens, search: hermeticSearch(flat.corpus) });
    }
    printTable(ds.name, ds.license, mode, flat, scored);
    results.push({
      dataset: ds.name,
      license: ds.license,
      committed: ds.license === "MIT",
      corpus_notes: flat.corpus.length,
      conversations: flat.case_count,
      questions: scored.queries_run,
      recall_at_3: scored.top3_recall,
      mrr: scored.mrr,
      by_type: byType(flat.goldens, scored.outcomes),
      source_sha256: ds.provenance?.source_sha256,
    });
  }

  const scorecard = {
    ts: new Date().toISOString(),
    mode,
    live_case_limit: LIVE && LIVE_CASES > 0 ? LIVE_CASES : null,
    k_searched: 8,
    recall_at: 3,
    results,
  };
  if (WANT_JSON) console.log("\n" + JSON.stringify(scorecard, null, 2));
  if (WRITE_SCORECARD) {
    writeFileSync(path.join(DATA_DIR, "SCORECARD.json"), JSON.stringify(scorecard, null, 2) + "\n");
    console.log(`\n[memory-bench-datasets] wrote ${path.join(DATA_DIR, "SCORECARD.json")}`);
  }
  return scorecard;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[memory-bench-datasets] FAILED:", e);
    process.exit(1);
  });
}
