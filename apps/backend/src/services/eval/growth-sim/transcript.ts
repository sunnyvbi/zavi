
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Score } from "./score";
import type { RunLog, Scenario } from "./types";

export function transcriptMarkdown(scenario: Scenario, log: RunLog): string {
  const lines: string[] = [
    `# ${scenario.business}`,
    ``,
    `Goal: ${scenario.goal.objective} (target ${scenario.goal.target} ${scenario.outcomeLabel}, due in ${scenario.goal.dueDays} days)`,
    `Channels: ${scenario.channels.map((c) => `${c.slug} (added by ${c.addedBy})`).join(", ")}`,
    `Autopilot: ${scenario.autopilot ? "on" : "off"}`,
    ``,
  ];
  for (const d of log.days) {
    const s = d.snapshot;
    lines.push(`## Day ${d.day}`);
    const changedToday = d.applied?.goalChanges.length ? " (target changed today)" : "";
    lines.push(`${scenario.outcomeLabel}: ${s.goalCurrent} of ${s.goalTarget}${changedToday} · pending cards: ${s.pendingCards} · paused: ${s.paused.join(", ") || "none"} · open asks: ${s.openAsks}`);
    for (const n of log.final.notes.filter((x) => x.by === "silence" && x.day === d.day)) {
      lines.push(`Note sent (no review, a question's deadline passed): **What I changed:** ${n.changed.join(" / ")}`);
    }
    if (!d.applied || !d.view) {
      lines.push(`No review.`, ``);
      continue;
    }
    const v = d.view;
    lines.push(`Review.`);
    lines.push(`Last 7 days: ${v.tiles7d.visits} visits, ${v.tiles7d.outcome} ${scenario.outcomeLabel}, ${v.tiles7d.conversionPct}% conversion. Founder silent ${v.founder.daysSilent} days.`);
    for (const c of v.channels) {
      const k = c.cards14d;
      lines.push(`- ${c.slug}${c.paused ? " (paused)" : ""}: ${k.pending} pending (${k.seenNotActed} seen, not acted), ${k.approved} approved, ${k.rejected} rejected, ${c.visits7d} visits in 7 days`);
    }
    const a = d.applied;
    if (a.note.sent === false) lines.push(`(This review's note had nothing new, so it was not sent to the founder.)`);
    lines.push(`**What I saw:** ${a.note.saw.join(" / ") || "-"}`);
    if (a.note.sections?.length) {
      if (a.note.headline) lines.push(`**Headline:** ${a.note.headline}`);
      for (const sec of a.note.sections) {
        lines.push(`**${sec.title}:** ${[...sec.rows.map((r) => r.line), ...(sec.more ? [sec.more.line] : [])].join(" / ")}`);
      }
    } else {
      lines.push(`**What I changed:** ${[...a.goalChanges.map((g) => `goal target -> ${g.target} (${g.why})`), ...a.channelPauses.map((p) => `paused ${p.slug} (${p.why})`), ...a.moves.map((m) => `${m.target_agent}: ${m.what}`)].join(" / ") || "-"}`);
      lines.push(`**What I need from you:** ${a.note.need.join(" / ") || "-"}`);
      if (a.note.would?.length) lines.push(`**What I would change (autopilot off):** ${a.note.would.join(" / ")}`);
    }
    lines.push(`Next review in ${a.nextReviewInDays} days.`, ``);
  }
  return lines.join("\n");
}

export function writeTranscript(dir: string, scenario: Scenario, log: RunLog, score: Score): string {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${log.scenarioId}.${log.arm}.seed${log.seed}`);
  const { pass: _pass, ...scenarioMeta } = scenario;
  writeFileSync(`${base}.json`, JSON.stringify({ scenario: scenarioMeta, score, log }, null, 1));
  writeFileSync(`${base}.md`, transcriptMarkdown(scenario, log));
  return `${base}.md`;
}

export function reportMarkdown(scores: Score[], expectedSeeds?: number): string {
  const rows = scores.map(
    (s) =>
      `| ${s.scenarioId} | ${s.arm} | ${s.seed} | ${s.pass ? "PASS" : "fail"} | ${s.passedByDay ?? "-"} | ${s.hardChecks.length ? s.hardChecks.join("; ") : "ok"} | ${s.restraint.length ? s.restraint.join("; ") : "ok"} | ${s.reviews} | ${s.tokens} |`,
  );
  const cells = new Map<string, Score[]>();
  for (const s of scores) cells.set(`${s.scenarioId}|${s.arm}`, [...(cells.get(`${s.scenarioId}|${s.arm}`) ?? []), s]);
  const summary = [...cells].map(([k, ss]) => {
    const [id, arm] = k.split("|");
    const complete = expectedSeeds === undefined || ss.length >= expectedSeeds;
    const all = complete && ss.every((s) => s.pass && s.hardChecks.length === 0 && s.restraint.length === 0);
    const of = expectedSeeds ?? ss.length;
    return `| ${id} | ${arm} | ${ss.filter((s) => s.pass).length}/${of} | ${all ? "PASS" : complete ? "fail" : "incomplete"} |`;
  });
  return [
    `## Summary (pass = every seed passes, no hard-check or restraint failure)`,
    `| scenario | arm | seeds passed | verdict |`,
    `|---|---|---|---|`,
    ...summary,
    ``,
    `## Every run`,
    `| scenario | arm | seed | pass | by day | hard checks | restraint | reviews | tokens |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...rows,
  ].join("\n");
}
