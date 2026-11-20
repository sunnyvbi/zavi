#!/usr/bin/env tsx
import "dotenv/config";
import { REPLAY_CASES } from "./skill-runtime-replay-cases";
import { SKILL_REGISTRY } from "../src/services/agents/skill-runtime";
import { runArm, codexGrade } from "./skill-runtime-replay-lib";
import {
  caseSkill,
  computeSkillLift,
  normalizeVerdict,
  type AbTrial,
  type BlindPlacement,
  type JudgeToken,
} from "./skill-ab-lift";

const DEFAULT_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const LIVE_SKILLS = SKILL_REGISTRY.map((s) => s.slug);

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function argVal(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function selectCases(skillFilter: string) {
  return REPLAY_CASES.map((c) => ({ c, skill: caseSkill(c) }))
    .filter((x): x is { c: typeof x.c; skill: string } => x.skill !== null)
    .filter((x) => (skillFilter ? x.skill === skillFilter : true));
}

function printDryPlan(tenant_id: string, skillFilter: string, repeat: number) {
  const selected = selectCases(skillFilter);
  console.log("\n=== skill A/B lift — DRY RUN (no runs enqueued) ===\n");
  console.log(`Tenant: ${tenant_id}`);
  console.log(`Live skills: ${LIVE_SKILLS.join(", ")}${skillFilter ? `  (filtered → ${skillFilter})` : ""}`);
  console.log(`Repeats per case: ${repeat}`);
  console.log(`Single-skill A/B cases: ${selected.length}\n`);
  const bySkill = new Map<string, number>();
  for (const { skill } of selected) bySkill.set(skill, (bySkill.get(skill) ?? 0) + repeat);
  for (const [skill, n] of [...bySkill.entries()].sort()) {
    console.log(`  [${skill}]  ${n} A/B pair(s)`);
  }
  console.log("\nEach pair runs arm-INJECT (skill body present) + arm-SUPPRESS");
  console.log("(payload.suppress_skill_runtime=true) CHAT-FAITHFULLY in-process (draft mode),");
  console.log("then the blind cross-family judge (codexGrade) picks the better answer.");
  console.log("Positions are ALTERNATED so the judge's position bias cancels.");
  console.log("Re-run with --run (REAL model calls on your tokens, QA tenant) to emit lift.\n");
}

async function main() {
  const tenant_id = argVal("tenant", DEFAULT_TENANT);
  const skillFilter = argVal("skill", "");
  const repeat = Math.max(1, parseInt(argVal("repeat", "1"), 10) || 1);

  if (skillFilter && !LIVE_SKILLS.includes(skillFilter)) {
    console.error(`--skill ${skillFilter} is not a live skill. Live: ${LIVE_SKILLS.join(", ")}`);
    process.exit(1);
  }

  if (!hasFlag("run")) {
    printDryPlan(tenant_id, skillFilter, repeat);
    return;
  }

  const selected = selectCases(skillFilter);
  if (selected.length === 0) {
    console.error("No single-skill A/B cases match the filter — nothing to run.");
    process.exit(1);
  }

  console.log(`\n=== skill A/B lift — LIVE (${selected.length} case(s) × ${repeat} × 2 arms) ===`);
  console.log(`Tenant: ${tenant_id}  |  judge: codex blind cross-family\n`);

  const trials: AbTrial[] = [];
  let trialIdx = 0;
  let fidelityBreaches = 0;
  let controlBreaches = 0;

  for (const { c, skill } of selected) {
    for (let r = 0; r < repeat; r++) {
      console.log(`── ${c.id} [${skill}] (rep ${r + 1}/${repeat}) ──`);
      const inject = await runArm(c, tenant_id, false);
      const suppress = await runArm(c, tenant_id, true);
      console.log(`   INJECT:   status=${inject.status} index=${inject.index_present ? "present" : "ABSENT"}`);
      console.log(`   SUPPRESS: status=${suppress.status} index=${suppress.index_present ? "PRESENT?!" : "absent"}`);

      if (!inject.index_present || suppress.index_present) {
        fidelityBreaches++;
        console.log(`   ⚠ FIDELITY BREACH — dropping trial (inject.index=${inject.index_present}, suppress.index=${suppress.index_present}).`);
        trials.push({ skill, winner: "error" });
        trialIdx++;
        continue;
      }
      if (suppress.loaded_slugs.length > 0) {
        controlBreaches++;
        console.log(`   ⚠ CONTROL BREACH — suppress arm loaded a skill; dropping trial.`);
        trials.push({ skill, winner: "error" });
        trialIdx++;
        continue;
      }
      if (!inject.output_text || !suppress.output_text) {
        console.log(`   ~ empty output on one arm — dropping trial.`);
        trials.push({ skill, winner: "error" });
        trialIdx++;
        continue;
      }

      const injectIsA = trialIdx % 2 === 0;
      const placement: BlindPlacement = injectIsA
        ? { a_arm: "inject", b_arm: "suppress" }
        : { a_arm: "suppress", b_arm: "inject" };
      const [aText, bText] = injectIsA
        ? [inject.output_text, suppress.output_text]
        : [suppress.output_text, inject.output_text];

      const token = codexGrade(c.prompt, aText, bText) as JudgeToken;
      const winner = normalizeVerdict(token, placement);
      trials.push({ skill, winner });
      trialIdx++;
      const mark = winner === "inject" ? "★ INJECT better" : winner === "suppress" ? "☆ SUPPRESS better (playbook didn't help)" : winner === "tie" ? "= tie" : "! judge error";
      console.log(`   verdict: ${mark}  (token=${token}, injectAsA=${injectIsA})\n`);
    }
  }

  const report = computeSkillLift(trials);
  console.log("═══ PER-SKILL LIFT (blind, chat-faithful, draft) ═══");
  for (const s of report.perSkill) {
    const pct = (s.lift * 100).toFixed(0);
    console.log(
      `  ${s.skill.padEnd(14)} lift=${s.lift >= 0 ? "+" : ""}${pct}%  ` +
        `[${s.verdict}]  inject=${s.inject_wins} suppress=${s.suppress_wins} tie=${s.ties} err=${s.errors} (graded ${s.graded})`,
    );
  }
  const o = report.overall;
  console.log(`  ${"__overall__".padEnd(14)} lift=${o.lift >= 0 ? "+" : ""}${(o.lift * 100).toFixed(0)}%  [${o.verdict}]  inject=${o.inject_wins} suppress=${o.suppress_wins} tie=${o.ties} err=${o.errors} (graded ${o.graded})`);
  console.log(`\nFidelity breaches: ${fidelityBreaches}  |  Control breaches: ${controlBreaches} (both should be 0)`);
  console.log("\nInterpret:");
  console.log("  lift > +34% [helps]  → the playbook improves answers → worth the E4 trust-gate cost.");
  console.log("  lift ~ 0    [neutral]→ the playbook doesn't move quality on these tasks → don't gate on faith.");
  console.log("  lift < -34% [hurts]  → the playbook makes answers worse → fix or retire the skill.");
  console.log("  insufficient         → too few graded trials; raise --repeat or add cases.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
