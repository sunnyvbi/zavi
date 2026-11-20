
import "tsconfig-paths/register";
import { serviceClient } from "@/services/supabase";
import {
  labelQuery,
  getAvailableJudges,
  extractQuestionText,
  JUDGE_LABELER_ALLOWED_TENANTS,
  type Candidate,
} from "@/services/memory/judge-labeler";

const JUDGE_CONCURRENCY = Math.max(1, Number(process.env.PRAXIS_JUDGE_CONCURRENCY) || 4);

const DEFAULT_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const DEFAULT_MAX = 50;
const CANDIDATE_FETCH_LIMIT = 12;
const QUERY_SCAN_LIMIT = 12000;

async function main() {
  const tenant_id = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : DEFAULT_TENANT;
  const maxQueries = Number(process.argv[3]) || DEFAULT_MAX;
  const dryRun = process.argv.includes("--dry-run");
  const sb = serviceClient();

  if (!JUDGE_LABELER_ALLOWED_TENANTS.has(tenant_id)) {
    console.error(
      `[judge-label] REFUSED tenant ${tenant_id}: cross-family judge sends note bodies to OpenAI; ` +
        `only accepted for upcar-ai dogfood. Add a consent flow before labeling customer tenants.`,
    );
    process.exit(1);
  }

  const judges = getAvailableJudges();
  if (judges.length < 2) {
    console.error(
      `[judge-label] need ≥2 judge FAMILIES for a cross-family label; only ${judges.length} available ` +
        `(${judges.map((j) => j.family).join(",") || "none"}). Need Anthropic auth (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) + the codex CLI on PATH (OpenAI family via ChatGPT auth).`,
    );
    process.exit(1);
  }
  const regime = `llm_judge_${judges.map((j) => j.family).sort().join("_")}_v1`;
  console.log(`[judge-label] tenant=${tenant_id} families=[${judges.map((j) => j.family).join(",")}] regime=${regime} max=${maxQueries} dryRun=${dryRun}`);

  const { data: caps, error: capErr } = await sb
    .from("eval_candidates")
    .select("query, retrieved_note_ids, created_at")
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: false })
    .limit(QUERY_SCAN_LIMIT);
  if (capErr) throw new Error(`eval_candidates read failed: ${capErr.message}`);

  const { data: existing } = await sb
    .from("memory_recall_golden")
    .select("query")
    .eq("tenant_id", tenant_id);
  const alreadyLabeled = new Set<string>();
  for (const r of existing ?? []) {
    if (!r.query) continue;
    alreadyLabeled.add(r.query);
    const norm = extractQuestionText(r.query);
    if (norm) alreadyLabeled.add(norm);
  }

  const seen = new Set<string>();
  const queries: Array<{ query: string; note_ids: string[] }> = [];
  let unwrapSkipped = 0;
  for (const row of caps ?? []) {
    const ids = (row.retrieved_note_ids ?? []) as string[];
    if (ids.length < 2) continue;
    const q = extractQuestionText(row.query ?? "");
    if (!q) {
      unwrapSkipped++;
      continue;
    }
    if (q.length < 4 || seen.has(q)) continue;
    seen.add(q);
    if (alreadyLabeled.has(q)) continue;
    queries.push({ query: q, note_ids: ids.slice(0, CANDIDATE_FETCH_LIMIT) });
    if (queries.length >= maxQueries) break;
  }
  console.log(
    `[judge-label] ${queries.length} fresh natural-language queries to label (${unwrapSkipped} structured-only captures skipped); concurrency=${JUDGE_CONCURRENCY}`,
  );

  let labeled = 0;
  let lowConf = 0;
  let skipped = 0;

  async function labelOne({ query, note_ids }: { query: string; note_ids: string[] }): Promise<void> {
    const { data: notes } = await sb
      .from("memory_note")
      .select("id, title, body_markdown")
      .eq("tenant_id", tenant_id)
      .in("id", note_ids);
    const candidates: Candidate[] = (notes ?? []).map((n) => ({
      note_id: n.id,
      title: n.title ?? "",
      body: n.body_markdown ?? "",
    }));
    if (candidates.length < 2) {
      skipped++;
      return;
    }

    const result = await labelQuery(query, candidates, judges);
    if (result.families_voted < 2) {
      skipped++;
      return;
    }
    if (result.expected_note_ids.length === 0) {
      skipped++;
      return;
    }
    if (result.low_confidence) lowConf++;

    if (!dryRun) {
      const { error: insErr } = await sb.from("memory_recall_golden").insert({
        tenant_id,
        query,
        expected_note_ids: result.expected_note_ids,
        category: "llm_judge",
        labeling_regime: regime,
        labeled_at: new Date().toISOString(),
        judge_agreement: result.agreement,
        active: true,
      });
      if (insErr) {
        console.warn(`[judge-label] insert failed for "${query.slice(0, 50)}": ${insErr.message}`);
        return;
      }
    }
    labeled++;
    if (labeled % 10 === 0) console.log(`[judge-label] ${labeled} labeled (${lowConf} low-conf)…`);
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= queries.length) return;
      try {
        await labelOne(queries[i]);
      } catch (e) {
        skipped++;
        console.warn(`[judge-label] query errored, skipping: ${(e as Error)?.message?.slice(0, 120)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(JUDGE_CONCURRENCY, queries.length) }, () => worker()));

  console.log(`\n=== judge-label done ===`);
  console.log(`labeled:        ${labeled}${dryRun ? " (DRY RUN — not written)" : ""}`);
  console.log(`low-confidence: ${lowConf} (split votes — feed S2 calibration)`);
  console.log(`skipped:        ${skipped} (already-labeled / no-answer / thin pool)`);
  console.log(`regime:         ${regime}`);
}

main().catch((e) => {
  console.error("[judge-label] FAILED:", e);
  process.exit(1);
});
