import { summarize, ratio } from "./stats.mjs";
import { SCORE_AXES, EVIDENCE_PROVENANCES, isEvidence } from "./schema.mjs";

export const PAIRED_TARGET = 20;

function provenanceLabel(records) {
  const counts = {};
  for (const r of records) counts[r.provenance] = (counts[r.provenance] || 0) + 1;
  const parts = Object.entries(counts)
    .sort()
    .map(([p, n]) => `${n} ${p}`);
  return parts.length ? `n=${parts.join(" + ")}` : "n=0";
}

function scoreRowsFor(records, joinedRows, evidence) {
  const runIds = new Set(records.map((r) => r.run_id));
  const direct = records.filter((r) => r.scores).map((r) => r.scores);
  const blind = joinedRows
    .filter((j) => runIds.has(j.run_id) && (evidence ? isEvidence(j) && EVIDENCE_PROVENANCES.includes(j.opponent_provenance) : true))
    .map((j) => j.scores);
  return [...direct, ...blind];
}

export function systemMetrics(records, joinedRows = [], { evidence = true } = {}) {
  const label = provenanceLabel(records);
  const first = summarize(records.map((r) => r.timings.to_first_preview_s));
  const complete = summarize(records.map((r) => r.timings.to_usable_complete_s));
  const cost = summarize(records.map((r) => r.cost.usd));
  const withRepairs = records.filter((r) => r.repairs !== null);
  const journeys = records.flatMap((r) => r.journeys);
  const reqs = records.flatMap((r) => r.requirement_coverage);
  const scoreRows = scoreRowsFor(records, joinedRows, evidence);
  const axes = {};
  for (const axis of SCORE_AXES) {
    const s = summarize(scoreRows.map((row) => row[axis] ?? null));
    axes[axis] = { mean: s.mean, n: s.n, nulls: s.nulls };
  }
  const runIds = new Set(records.map((r) => r.run_id));
  const judged = joinedRows.filter(
    (j) => runIds.has(j.run_id) && j.outcome !== null && (evidence ? isEvidence(j) && EVIDENCE_PROVENANCES.includes(j.opponent_provenance) : true),
  );
  const wins = judged.filter((j) => j.outcome === "win").length;
  const ties = judged.filter((j) => j.outcome === "tie").length;
  return {
    records: records.length,
    label,
    to_first_preview_s: first,
    to_usable_complete_s: complete,
    cost_usd: cost,
    repair_rate: { value: ratio(withRepairs.filter((r) => r.repairs > 0).length, withRepairs.length), n: withRepairs.length, nulls: records.length - withRepairs.length },
    journey_pass_rate: { value: ratio(journeys.filter((j) => j.passed).length, journeys.length), n: journeys.length },
    requirement_coverage: { value: ratio(reqs.filter((c) => c.met).length, reqs.length), n: reqs.length },
    axes,
    preference: { win_rate: ratio(wins, judged.length), wins, ties, losses: judged.length - wins - ties, n: judged.length },
  };
}

function fmtNum(v, unit = "", digits = 0) {
  if (v === null || v === undefined) return "n/a";
  return `${unit === "$" ? "$" : ""}${v.toFixed(digits)}${unit && unit !== "$" ? unit : ""}`;
}

function fmtPct(v) {
  return v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(0)}%`;
}

function nullNote(nulls) {
  return nulls ? `, ${nulls} null excluded` : "";
}

function metricLines(name, m) {
  const L = m.label;
  const t = (s, unit, digits) => `median ${fmtNum(s.median, unit, digits)} / p90 ${fmtNum(s.p90, unit, digits)} (${L}; ${s.n} with value${nullNote(s.nulls)})`;
  const lines = [
    `${name}`,
    `  records:                 ${m.records} (${L})`,
    `  time to first preview:   ${t(m.to_first_preview_s, "s", 0)}`,
    `  time to usable complete: ${t(m.to_usable_complete_s, "s", 0)}`,
    `  cost per build:          ${t(m.cost_usd, "$", 2)}`,
    `  repair rate:             ${fmtPct(m.repair_rate.value)} of builds needed a repair (${L}; ${m.repair_rate.n} with value${nullNote(m.repair_rate.nulls)})`,
    `  journey pass rate:       ${fmtPct(m.journey_pass_rate.value)} (${m.journey_pass_rate.n} journeys; ${L})`,
    `  requirement coverage:    ${fmtPct(m.requirement_coverage.value)} (${m.requirement_coverage.n} requirements; ${L})`,
  ];
  for (const axis of SCORE_AXES) {
    const a = m.axes[axis];
    lines.push(`  score ${axis.padEnd(19)} ${a.mean === null ? "n/a" : a.mean.toFixed(2)} (${a.n} ratings on ${L})`);
  }
  const p = m.preference;
  lines.push(`  blind preference:        win rate ${fmtPct(p.win_rate)} (${p.wins}W/${p.ties}T/${p.losses}L over ${p.n} blind judgments; ${L})`);
  return lines;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function mockedTable(records) {
  const head = ["run_id", "brief", "system", "provenance", "preview_s", "complete_s", "cost", "repairs", "journeys", "coverage"];
  const widths = [34, 18, 8, 18, 10, 11, 8, 8, 9, 9];
  const rows = records.map((r) => {
    const jp = r.journeys.length ? `${r.journeys.filter((j) => j.passed).length}/${r.journeys.length}` : "-";
    const cv = r.requirement_coverage.length ? `${r.requirement_coverage.filter((c) => c.met).length}/${r.requirement_coverage.length}` : "-";
    return [r.run_id, r.brief_id, r.system, r.provenance, r.timings.to_first_preview_s ?? "null", r.timings.to_usable_complete_s ?? "null", r.cost.usd ?? "null", r.repairs ?? "null", jp, cv];
  });
  return [head, ...rows].map((cols) => cols.map((c, i) => pad(c, widths[i])).join(" ").trimEnd());
}

export function buildReport({ records, joinedRows = [], systems = ["zavi", "lovable"], pairedTarget = PAIRED_TARGET }) {
  const evidence = records.filter(isEvidence);
  const notEvidence = records.filter((r) => !isEvidence(r));
  const allSystems = [...new Set([...systems, ...evidence.map((r) => r.system)])];
  const perSystem = {};
  for (const s of allSystems) {
    const recs = evidence.filter((r) => r.system === s);
    perSystem[s] = systemMetrics(recs, joinedRows, { evidence: true });
  }
  const pairedBriefs = [...new Set(evidence.map((r) => r.brief_id))].filter((b) =>
    systems.every((s) => evidence.some((r) => r.brief_id === b && r.system === s)),
  );
  const empty = systems.filter((s) => perSystem[s].records === 0);
  const headline = empty.length === 0;
  const lines = ["SITE QUALITY BENCHMARK REPORT", ""];
  lines.push(`Evidence records (actual_ai_build + manual_import): ${evidence.length}. Not-evidence records (mocked + hand_written_demo): ${notEvidence.length}.`);
  lines.push("");
  if (headline) {
    const [a, b] = systems;
    const pa = perSystem[a];
    const pb = perSystem[b];
    lines.push(`COMPARISON HEADLINE: ${a} vs ${b} on ${pairedBriefs.length} paired briefs (target ${pairedTarget}).`);
    lines.push(`  p90 time to first preview: ${a} ${fmtNum(pa.to_first_preview_s.p90, "s")} (${pa.label}) vs ${b} ${fmtNum(pb.to_first_preview_s.p90, "s")} (${pb.label})`);
    lines.push(`  journey pass rate: ${a} ${fmtPct(pa.journey_pass_rate.value)} vs ${b} ${fmtPct(pb.journey_pass_rate.value)}`);
    lines.push(`  blind preference win rate for ${a}: ${fmtPct(pa.preference.win_rate)} over ${pa.preference.n} blind judgments`);
    if (pairedBriefs.length < pairedTarget) {
      lines.push(`  CAUTION: ${pairedBriefs.length} of ${pairedTarget} planned paired builds. Directional only, not the decision-grade comparison.`);
    }
  } else {
    lines.push(`NO COMPARISON HEADLINE: ${empty.map((s) => `${s} has 0 actual_ai_build/manual_import records`).join("; ")}.`);
    lines.push("  A comparison needs real records on both sides. Mocked and hand-written demo rows never count.");
  }
  lines.push("");
  lines.push("PER SYSTEM (evidence only)");
  for (const s of allSystems) {
    lines.push(...metricLines(s, perSystem[s]));
    lines.push("");
  }
  lines.push("MOCKED (not evidence)");
  if (notEvidence.length === 0) lines.push("  none");
  else {
    lines.push(...mockedTable(notEvidence).map((l) => `  ${l}`));
    const mockJudged = joinedRows.filter((j) => !isEvidence(j) || !EVIDENCE_PROVENANCES.includes(j.opponent_provenance));
    lines.push(`  blind ratings touching these rows: ${mockJudged.length} (practice only)`);
  }
  return {
    text: lines.join("\n") + "\n",
    data: { headline, missing_systems: empty, paired_briefs: pairedBriefs, paired_target: pairedTarget, per_system: perSystem, not_evidence_records: notEvidence.length },
  };
}
