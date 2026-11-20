
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "fixtures/public-datasets");
const LOCOMO_LOCAL_DIR = path.join(OUT_DIR, ".locomo-local");

const LME_URL = "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_oracle";
const LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const LME_PER_TYPE = Number(arg("--lme-per-type", "12"));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  return await res.text();
}

async function refreshLongMemEval() {
  console.log(`[refresh] LongMemEval (MIT) ← ${LME_URL}`);
  const raw = await fetchText(LME_URL);
  const all = JSON.parse(raw);
  const srcSha = sha256(raw);

  const perType = new Map();
  const chosenIds = new Set();
  for (const e of all) {
    if (typeof e.question_id === "string" && e.question_id.endsWith("_abs")) continue;
    const t = e.question_type;
    const n = perType.get(t) ?? 0;
    if (n < LME_PER_TYPE) {
      perType.set(t, n + 1);
      chosenIds.add(e.question_id);
    }
  }
  const entries = all.filter((e) => chosenIds.has(e.question_id));

  const sessions = entries.reduce((a, e) => a + (e.haystack_sessions?.length ?? 0), 0);
  const wrapper = {
    dataset: "longmemeval_oracle",
    license: "MIT",
    source_url: LME_URL,
    source_repo: "https://huggingface.co/datasets/xiaowu0162/longmemeval",
    source_sha256: srcSha,
    selection: `first ${LME_PER_TYPE} non-abstention questions per question_type, dataset order preserved`,
    generated_at: new Date().toISOString(),
    stats: {
      questions: entries.length,
      sessions,
      by_type: Object.fromEntries([...perType.entries()].sort()),
    },
    entries,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, "longmemeval-oracle-subset.json");
  writeFileSync(out, JSON.stringify(wrapper, null, 2));
  console.log(`[refresh]   wrote ${out}`);
  console.log(`[refresh]   ${entries.length} questions, ${sessions} sessions, by_type=${JSON.stringify(wrapper.stats.by_type)}`);
  console.log(`[refresh]   source_sha256=${srcSha}`);
  return wrapper.stats;
}

async function refreshLoCoMoLocal() {
  console.log(`[refresh] LoCoMo (CC BY-NC 4.0 — local-only, NOT committed) ← ${LOCOMO_URL}`);
  const raw = await fetchText(LOCOMO_URL);
  const srcSha = sha256(raw);
  mkdirSync(LOCOMO_LOCAL_DIR, { recursive: true });
  const out = path.join(LOCOMO_LOCAL_DIR, "locomo10.json");
  writeFileSync(out, raw);
  writeFileSync(path.join(LOCOMO_LOCAL_DIR, "PROVENANCE.txt"),
    `LoCoMo full dataset (locomo10.json)\nsource: ${LOCOMO_URL}\nsha256: ${srcSha}\nlicense: CC BY-NC 4.0 (NON-COMMERCIAL)\nfetched: ${new Date().toISOString()}\n` +
    `\nThis directory is .gitignored. Do NOT commit LoCoMo data or publish numbers\nderived from it for any commercial purpose without legal review.\n`);
  console.log(`[refresh]   wrote ${out} (gitignored)`);
  console.log(`[refresh]   source_sha256=${srcSha}`);
}

async function main() {
  const onlyLme = process.argv.includes("--lme-only");
  const onlyLoco = process.argv.includes("--locomo-only");
  if (!onlyLoco) await refreshLongMemEval();
  if (!onlyLme) {
    try {
      await refreshLoCoMoLocal();
    } catch (e) {
      console.warn(`[refresh] LoCoMo fetch skipped (${e?.message || e}). LongMemEval subset is unaffected.`);
    }
  }
  console.log("[refresh] done.");
}

main().catch((e) => {
  console.error("[refresh] FAILED:", e);
  process.exit(1);
});
