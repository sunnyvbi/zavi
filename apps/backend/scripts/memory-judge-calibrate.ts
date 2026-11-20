
import "tsconfig-paths/register";
import { serviceClient } from "@/services/supabase";
import { searchMemory } from "@/services/memory";
import {
  labelQuery,
  getAvailableJudges,
  classifyCalibration,
  JUDGE_LABELER_ALLOWED_TENANTS,
  type Candidate,
  type CalibrationVerdict,
} from "@/services/memory/judge-labeler";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const SEARCH_K = 8;
const CONCURRENCY = Math.max(1, Number(process.env.PRAXIS_JUDGE_CONCURRENCY) || 4);

type AnchorResult = {
  query: string;
  anchor_expected: string[];
  judge_expected: string[];
  verdict: CalibrationVerdict | "skipped_non_cross_family";
};

async function main() {
  const tenant_id = process.argv[2] || DEFAULT_TENANT;
  const sb = serviceClient();

  if (!JUDGE_LABELER_ALLOWED_TENANTS.has(tenant_id)) {
    console.error(`[calibrate] REFUSED tenant ${tenant_id}: judge sends note bodies to OpenAI; upcar-ai dogfood only.`);
    process.exit(1);
  }
  const judges = getAvailableJudges();
  if (judges.length < 2) {
    console.error(`[calibrate] need ≥2 judge families; only ${judges.length} (${judges.map((j) => j.family).join(",") || "none"}).`);
    process.exit(1);
  }
  console.log(`[calibrate] tenant=${tenant_id} families=[${judges.map((j) => j.family).join(",")}] concurrency=${CONCURRENCY}`);

  const { data: anchors, error } = await sb
    .from("memory_recall_golden")
    .select("query, expected_note_ids, labeling_regime")
    .eq("tenant_id", tenant_id)
    .eq("active", true);
  if (error) throw new Error(`anchor load failed: ${error.message}`);
  const trusted = (anchors ?? []).filter(
    (a) => (!a.labeling_regime || !String(a.labeling_regime).startsWith("llm_judge")) && (a.expected_note_ids ?? []).length > 0,
  );
  console.log(`[calibrate] ${trusted.length} trusted anchor goldens (excluded ${(anchors ?? []).length - trusted.length} llm_judge/empty)`);
  if (trusted.length === 0) {
    console.error("[calibrate] no trusted anchors — nothing to calibrate against.");
    process.exit(1);
  }

  const results: AnchorResult[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= trusted.length) return;
      const anchor = trusted[i];
      const anchor_expected = (anchor.expected_note_ids ?? []) as string[];
      try {
        const hits = await searchMemory(tenant_id, anchor.query, SEARCH_K, { agent_slug: "memory-calibrate" });
        const candidates: Candidate[] = hits.map((h) => ({ note_id: h.note_id, title: h.title, body: h.body }));
        const present = new Set(candidates.map((c) => c.note_id));
        const missing = anchor_expected.filter((id) => !present.has(id));
        if (missing.length > 0) {
          const { data: notes, error: noteErr } = await sb
            .from("memory_note")
            .select("id, title, body_markdown")
            .eq("tenant_id", tenant_id)
            .in("id", missing);
          if (noteErr) throw new Error(`anchor-note hydrate failed: ${noteErr.message}`);
          for (const n of notes ?? []) candidates.push({ note_id: n.id, title: n.title ?? "", body: n.body_markdown ?? "" });
          const loaded = new Set(candidates.map((c) => c.note_id));
          const stillMissing = anchor_expected.filter((id) => !loaded.has(id));
          if (stillMissing.length > 0) {
            results.push({ query: anchor.query, anchor_expected, judge_expected: [], verdict: "skipped_non_cross_family" });
            continue;
          }
        }
        if (candidates.length < 2) {
          results.push({ query: anchor.query, anchor_expected, judge_expected: [], verdict: "skipped_non_cross_family" });
          continue;
        }
        const r = await labelQuery(anchor.query, candidates, judges);
        if (r.families_voted < 2) {
          results.push({ query: anchor.query, anchor_expected, judge_expected: r.expected_note_ids, verdict: "skipped_non_cross_family" });
          continue;
        }
        results.push({
          query: anchor.query,
          anchor_expected,
          judge_expected: r.expected_note_ids,
          verdict: classifyCalibration(r.expected_note_ids, anchor_expected),
        });
      } catch (e) {
        results.push({ query: anchor.query, anchor_expected, judge_expected: [], verdict: "skipped_non_cross_family" });
        console.warn(`[calibrate] anchor errored: ${(e as Error)?.message?.slice(0, 120)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, trusted.length) }, () => worker()));

  const scored = results.filter((r) => r.verdict !== "skipped_non_cross_family");
  const strong = scored.filter((r) => r.verdict === "strong").length;
  const weak = scored.filter((r) => r.verdict === "weak").length;
  const disagree = scored.filter((r) => r.verdict === "disagree").length;
  const agreementRate = scored.length > 0 ? Number(((strong + weak) / scored.length).toFixed(4)) : 0;
  const strongRate = scored.length > 0 ? Number((strong / scored.length).toFixed(4)) : 0;

  const out = {
    ts: new Date().toISOString(),
    tenant_id,
    families: judges.map((j) => j.family),
    anchors_total: trusted.length,
    scored: scored.length,
    skipped_non_cross_family: results.length - scored.length,
    strong,
    weak,
    disagree,
    agreement_rate: agreementRate,
    strong_rate: strongRate,
    judge_confidence_weight: agreementRate,
  };
  const dir = join(process.cwd(), ".bench");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `judge-calibration-${tenant_id.slice(0, 8)}-${out.ts.slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify({ ...out, disagreements: scored.filter((r) => r.verdict === "disagree").slice(0, 12) }, null, 2));

  console.log(`\n=== judge calibration ===`);
  console.log(`anchors scored:   ${scored.length} / ${trusted.length} (${out.skipped_non_cross_family} skipped: <2 families / thin pool)`);
  console.log(`strong agree:     ${strong}`);
  console.log(`weak agree:       ${weak}`);
  console.log(`disagree:         ${disagree}`);
  console.log(`AGREEMENT RATE:   ${(agreementRate * 100).toFixed(1)}%  (strong+weak)/scored = judge confidence weight`);
  console.log(`strong-only rate: ${(strongRate * 100).toFixed(1)}%`);
  const dis = scored.filter((r) => r.verdict === "disagree").slice(0, 8);
  if (dis.length) {
    console.log(`\nexample DISAGREEMENTS (anchor vs judge):`);
    for (const d of dis) console.log(`  - ${JSON.stringify(d.query).slice(0, 50)}\n      anchor=${d.anchor_expected.map((s) => s.slice(0, 8))} judge=${d.judge_expected.map((s) => s.slice(0, 8))}`);
  }
  console.log(`\npersisted: ${file}`);
}

main().catch((e) => {
  console.error("[calibrate] FAILED:", e);
  process.exit(1);
});
