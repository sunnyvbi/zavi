#!/usr/bin/env tsx
import "dotenv/config";
import { REPLAY_CASES, type ReplayCase } from "./skill-runtime-replay-cases";
import { SKILL_REGISTRY } from "../src/services/agents/skill-runtime";
import { runArm, codexGrade } from "./skill-runtime-replay-lib";

const DEFAULT_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const KNOWN_SLUGS = SKILL_REGISTRY.map((s) => s.slug);

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function argVal(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function printDryPlan(tenant_id: string, cases: readonly ReplayCase[]) {
  console.log("\n=== skill-runtime replay — DRY RUN (no runs enqueued) ===\n");
  console.log(`Tenant: ${tenant_id}`);
  console.log(`Live skills: ${KNOWN_SLUGS.join(", ")}`);
  console.log(`Cases: ${cases.length}\n`);
  for (const c of cases) {
    const exp = c.kind === "negative" ? "load NOTHING" : `load one of [${c.expected_slugs.join(", ")}]`;
    console.log(`  [${c.kind.toUpperCase()}] ${c.id}  (${c.agent_slug})`);
    console.log(`      prompt: ${c.prompt}`);
    console.log(`      expect: ${exp}`);
    console.log(`      why:    ${c.note}\n`);
  }
  console.log("Each case runs TWO arms A(normal)+B(suppress) CHAT-FAITHFULLY in-process (draft mode):");
  console.log("temp eval thread+message → runChat draft → read tool_calls + prompt_snapshot → delete the thread.");
  console.log("Re-run with --run (REAL model calls on your tokens, QA tenant); --grade adds an optional codex A/B grade.");
  console.log("No Inngest/deploy needed — runs in this process against prod data. Reports a TRUSTWORTHY chat-path load-rate.\n");
}

async function main() {
  const tenant_id = argVal("tenant", DEFAULT_TENANT);
  const only = argVal("case", "");
  const cases = only ? REPLAY_CASES.filter((c) => c.id === only) : REPLAY_CASES;
  if (cases.length === 0) {
    console.error(`No case matches --case ${only}`);
    process.exit(1);
  }

  if (!hasFlag("run")) {
    printDryPlan(tenant_id, cases);
    return;
  }

  const grade = hasFlag("grade");
  console.log(`\n=== skill-runtime replay — LIVE (${cases.length} cases × 2 arms) ===`);
  console.log(`Tenant: ${tenant_id}  |  grading: ${grade ? "codex blind" : "off"}\n`);

  let posHits = 0, posTotal = 0, falseLoads = 0, negTotal = 0, controlBreaches = 0, qualityWins = 0, graded = 0, fidelityBreaches = 0;

  for (const c of cases) {
    console.log(`── ${c.id} (${c.kind}, ${c.agent_slug}) ──`);
    const [a, b] = [await runArm(c, tenant_id, false), await runArm(c, tenant_id, true)];

    const loadFired = a.loaded_slugs.length > 0;
    const rightSlug = a.loaded_slugs.some((s) => c.expected_slugs.includes(s));
    console.log(`   A(load):    status=${a.status} index=${a.index_present ? "present" : "ABSENT"} loaded=[${a.loaded_slugs.join(",") || "none"}]`);
    console.log(`   B(no-load): status=${b.status} index=${b.index_present ? "PRESENT?!" : "absent"} loaded=[${b.loaded_slugs.join(",") || "none"}]`);

    if (!a.index_present || b.index_present) {
      fidelityBreaches++;
      console.log(`   ⚠ FIDELITY BREACH: expected index present in A + absent in B (got A=${a.index_present}, B=${b.index_present}).`);
    }

    if (b.loaded_slugs.length > 0) {
      controlBreaches++;
      console.log(`   ⚠ CONTROL BREACH: no-load arm loaded a skill — suppress lever failed.`);
    }

    if (c.kind === "positive") {
      posTotal++;
      if (loadFired && rightSlug) { posHits++; console.log(`   ✓ selection: loaded an expected skill`); }
      else console.log(`   ✗ selection: expected [${c.expected_slugs.join(",")}], got [${a.loaded_slugs.join(",") || "none"}]`);
    } else if (c.kind === "negative") {
      negTotal++;
      if (loadFired) { falseLoads++; console.log(`   ✗ false-load: loaded on a no-playbook task`); }
      else console.log(`   ✓ correctly loaded nothing`);
    } else {
      console.log(`   ~ ambiguous: loaded [${a.loaded_slugs.join(",") || "none"}] (not scored)`);
    }

    if (grade && c.kind !== "negative" && a.output_text && b.output_text) {
      const verdict = codexGrade(c.prompt, a.output_text, b.output_text);
      graded++;
      if (verdict === "A") { qualityWins++; console.log(`   ★ quality: LOAD arm better (codex)`); }
      else if (verdict === "B") console.log(`   ☆ quality: NO-LOAD arm better (codex) — playbook didn't help here`);
      else console.log(`   = quality: ${verdict} (codex)`);
    }
    console.log("");
  }

  console.log("═══ SUMMARY (chat-faithful, in-process draft) ═══");
  console.log(`Selection (positives):   ${posHits}/${posTotal} loaded an expected skill`);
  console.log(`False-loads (negatives): ${falseLoads}/${negTotal}`);
  console.log(`Control breaches:        ${controlBreaches} (must be 0 — no-load arm loaded)`);
  console.log(`Fidelity breaches:       ${fidelityBreaches} (must be 0 — index must be present in A, absent in B on the REAL chat prompt)`);
  if (grade) console.log(`Quality wins (load>no-load): ${qualityWins}/${graded} (codex blind)`);
  console.log("\nInterpret (deterministic — no LLM judge needed for the load-rate):");
  console.log("  fidelity=0 breaches → the number is TRUSTWORTHY (index really reaches the model).");
  console.log("  then: high selection + zero false-loads → mechanism works, expand corpus.");
  console.log("  weak selection WITH fidelity clean → the model won't self-select (persona/mapping) → fix mapping + auto-load, NOT more corpus.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
