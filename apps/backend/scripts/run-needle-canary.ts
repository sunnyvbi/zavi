#!/usr/bin/env tsx
import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serviceClient } from "@/services/supabase";
import { upsertAnchor } from "@/services/memory/upsert-anchor";
import { makeRepeatTaskAbLiveDeps } from "@/services/memory/repeat-task-ab-live";
import type { RepeatTaskGoldenLite } from "@/services/memory/repeat-task-ab";
import {
  evaluateNeedle,
  summarizeNeedleRun,
  type NeedleResult,
} from "@/services/memory/needle-canary";

const CANARY_TENANT = "15f31176-3bc6-4d06-9136-5940c1e09036";
const CANARY_SLUG = "zzz-mem-needle-canary";
const CANARY_NAME = "Needle Canary (test tenant)";

type Golden = {
  id: string;
  nonce: string;
  fact: string;
  query: string;
  agent_slug: string;
};

function loadGoldens(): Golden[] {
  const path = join(__dirname, "..", "eval", "memory-needle", "goldens.json");
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as { goldens: Golden[] };
  return parsed.goldens;
}

async function seed(goldens: Golden[]): Promise<void> {
  const sb = serviceClient();
  const { error: tErr } = await sb
    .from("tenants")
    .upsert(
      { id: CANARY_TENANT, slug: CANARY_SLUG, display_name: CANARY_NAME, kind: "test" },
      { onConflict: "id" },
    );
  if (tErr) throw new Error(`tenant upsert failed: ${tErr.message}`);

  const body =
    "# Company reference codes\n\n" +
    goldens.map((g) => `- ${g.fact}`).join("\n") +
    "\n";
  for (const slug of ["company", "support"] as const) {
    await upsertAnchor({
      tenant_id: CANARY_TENANT,
      slug,
      title: `${slug}.md`,
      body_markdown: body,
      source: "human",
    });
  }
  console.log(`seeded ${goldens.length} facts into company + support anchors on ${CANARY_SLUG}\n`);
}

function parseLimit(argv: string[]): number | null {
  const i = argv.indexOf("--limit");
  if (i < 0) return null;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--limit must be a positive integer`);
  return n;
}

const VERDICT_ICON: Record<string, string> = {
  pass: "✅",
  answer_missing: "❌ MEMORY-NOT-USED",
  prompt_missing: "⚠️  NOT-IN-PROMPT",
  hallucinated: "❌ HALLUCINATED",
  bleed: "⚠️  BLEED",
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let limit: number | null;
  try {
    limit = parseLimit(argv);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }

  let goldens = loadGoldens();
  if (limit) goldens = goldens.slice(0, limit);
  const allNonces = goldens.map((g) => g.nonce);

  if (argv.includes("--seed")) await seed(goldens);

  const deps = makeRepeatTaskAbLiveDeps();
  const results: NeedleResult[] = [];

  for (const g of goldens) {
    const golden: RepeatTaskGoldenLite = {
      id: g.id,
      tenant_id: CANARY_TENANT,
      agent_slug: g.agent_slug,
      query: g.query,
    };
    let result: NeedleResult;
    try {
      const disp = await deps.dispatch(golden, "brain_on");
      result = evaluateNeedle({
        prompt: disp.prompt_snapshot ?? "",
        answer: disp.output_text ?? "",
        nonce: g.nonce,
        allNonces,
      });
    } catch (e) {
      console.error(`  dispatch failed for ${g.id}: ${(e as Error).message}`);
      result = {
        nonce: g.nonce,
        prompt_has: false,
        answer_has: false,
        foreign_known: [],
        hallucinated: [],
        verdict: "prompt_missing",
      };
    }
    results.push(result);
    console.log(
      `${VERDICT_ICON[result.verdict] ?? result.verdict}  [${g.id}] ${g.nonce} — ${result.verdict}`,
    );
  }

  const s = summarizeNeedleRun(results);
  console.log("\n── Needle canary summary ────────────────────────────────");
  console.log(`goldens run:  ${s.total}`);
  console.log(`passed:       ${s.passed}  (${(s.pass_rate * 100).toFixed(0)}%)`);
  for (const [v, n] of Object.entries(s.by_verdict)) {
    if (n > 0) console.log(`  ${v}: ${n}`);
  }

  const hasInfra = s.by_verdict.prompt_missing > 0;
  const hasRegression =
    s.by_verdict.answer_missing + s.by_verdict.hallucinated + s.by_verdict.bleed > 0;
  if (hasInfra) process.exit(2);
  if (hasRegression) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(2);
});
