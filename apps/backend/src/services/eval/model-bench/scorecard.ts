
import { renameSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarnessFailure } from "@/services/eval/shadow-harness";
import { hashFixture, type TaskFixture } from "./fixtures";
import {
  NOT_MEASURABLE,
  PARTIAL_READ_CHANNELS,
  REQUIRED_CHANNEL_UNITS,
  REQUIRED_ROLE_UNITS,
  missingUnits,
} from "./miner";
import { BENCH_TENANTS } from "./tenants";
import type { TrialResult } from "./runner";
import { fromTracedToolName } from "@/services/mcp/types";
import {
  allTrialsPassed,
  taskRates,
  trialPassRate,
  verdictCounts,
  verdictGap,
  type ScoredTrial,
} from "./scorer";

export type SearchRecall = {
  tasks: number;
  tasks_with_miss: number;
  trials: number;
  no_reference: number;
  trials_with_miss: number;
  missed_tools: Array<{ name: string; trials: number }>;
};

function canonicalToolName(name: string): string | null {
  const p = fromTracedToolName(name);
  return p ? `${p.server_id}__${p.tool_name}` : null;
}

export function computeSearchRecall(
  candidate: ReadonlyArray<TrialResult>,
  reference: ReadonlyArray<TrialResult>,
): SearchRecall {
  const refByTask = new Map<string, Set<string>>();
  for (const r of reference) {
    if (r.outcome !== "completed") continue;
    if (!refByTask.has(r.task_id)) refByTask.set(r.task_id, new Set());
    for (const c of r.raw?.tool_calls ?? []) {
      const n = canonicalToolName(c.name);
      if (n) refByTask.get(r.task_id)!.add(n);
    }
  }
  const tasks = new Set<string>();
  const tasksWithMiss = new Set<string>();
  const missed = new Map<string, number>();
  let trials = 0;
  let noReference = 0;
  let trialsWithMiss = 0;
  for (const r of candidate) {
    if (r.outcome !== "completed") continue;
    const surfaced = r.raw?.surfaced_tools;
    if (!surfaced) continue;
    const refTools = refByTask.get(r.task_id);
    if (!refTools) {
      noReference++;
      continue;
    }
    trials++;
    tasks.add(r.task_id);
    const seen = new Set(surfaced);
    const misses = [...refTools].filter((n) => !seen.has(n));
    if (misses.length === 0) continue;
    trialsWithMiss++;
    tasksWithMiss.add(r.task_id);
    for (const m of misses) missed.set(m, (missed.get(m) ?? 0) + 1);
  }
  return {
    tasks: tasks.size,
    tasks_with_miss: tasksWithMiss.size,
    trials,
    no_reference: noReference,
    trials_with_miss: trialsWithMiss,
    missed_tools: [...missed.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([name, n]) => ({ name, trials: n })),
  };
}

export function searchRecallLines(s: SearchRecall | undefined): string[] {
  const out = ["## Search recall (candidate; counted apart from model failures)", ""];
  if (s && s.trials === 0 && s.no_reference > 0) {
    out.push(`- Not measured: tool search was active on ${s.no_reference} candidate trial(s), but no completed Claude prod-loop reference exists for their tasks.`, "");
    return out;
  } else if (!s || s.trials === 0) {
    out.push("- Not measured: tool search was not active on any candidate trial.", "");
    return out;
  }
  out.push(
    `- Tasks where a tool the Claude prod-loop reference called was never surfaced to the candidate: ` +
      `${s.tasks_with_miss} of ${s.tasks} (${s.trials_with_miss} of ${s.trials} trials)`,
  );
  if (s.missed_tools.length) {
    out.push(
      `- Most-missed tools: ${s.missed_tools
        .slice(0, 8)
        .map((m) => `${m.name} (${m.trials})`)
        .join(", ")}`,
    );
  }
  out.push("");
  return out;
}

export type BenchScope = { companies?: string[]; units?: string[] };

export type ScorecardInput = {
  date: string;
  model_key: string;
  model_lineage: string;
  harness_sha: string;
  trials: number;
  fixtures: ReadonlyArray<TaskFixture>;
  candidate: ReadonlyArray<ScoredTrial>;
  reference_sdk: ReadonlyArray<ScoredTrial>;
  harness_shared: ReadonlyArray<ScoredTrial>;
  no_substantive?: ReadonlyArray<{ company: string; unit: string }>;
  judges: string[] | "judge_unavailable";
  scope?: BenchScope | null;
  harness_judges: string[] | "judge_unavailable";
  harness_partial?: boolean;
  search_recall?: SearchRecall;
  spent_usd: number;
  max_usd: number;
  partial: boolean;
  dry_run: boolean;
  prod_reference?: ReadonlyArray<{ task_id: string; run_id: string; model_used: string; date: string }>;
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

function rowLine(label: string, s: ReadonlyArray<ScoredTrial>, trials: number, judged: boolean): string {
  const tr = trialPassRate(s);
  const all = allTrialsPassed(taskRates(s), trials);
  const excluded = s.filter((x) => x.pass === null).length;
  const ctx = s.filter((x) => x.outcome === "context_too_small").length;
  const modelFail = s.filter((x) => x.outcome === "model_failure").length;
  const v = verdictCounts(s);
  const bsw = judged ? `${v.better} | ${v.same} | ${v.worse}` : "(the bar) | - | -";
  return `| ${label} | ${bsw} | ${tr.passes}/${tr.n} (${pct(tr.rate)}) | ${all.k} of ${all.of} | ${modelFail} | ${ctx} | ${excluded} |`;
}

function gapLine(label: string, s: ReadonlyArray<ScoredTrial>): string {
  const g = verdictGap(s);
  if (!g) return `| ${label} | n/a | n/a | 0 |`;
  return `| ${label} | ${signed(g.gap)} | [${signed(g.lo)}, ${signed(g.hi)}] | ${g.tasks} |`;
}

const bswCell = (s: ReadonlyArray<ScoredTrial>) => {
  if (s.length === 0) return "-";
  const v = verdictCounts(s);
  if (v.better + v.same + v.worse === 0) return "- (unjudged)";
  return `${v.better}/${v.same}/${v.worse}`;
};

export function renderScorecard(i: ScorecardInput): string {
  const units = [...new Set(i.fixtures.map((f) => `${f.cohort}:${f.unit}`))].sort();
  const lines: string[] = [];
  if (i.scope && (i.scope.companies?.length || i.scope.units?.length)) {
    lines.push(
      `> SCOPED RUN (companies: ${i.scope.companies?.join(", ") || "all"}; units: ${i.scope.units?.join(", ") || "all"}). ` +
        "A smoke test on a slice of the fleet, not a fleet verdict.",
    );
    lines.push("");
  }
  lines.push(`# Model bench: ${i.model_key} (${i.date})`);
  lines.push("");
  if (i.dry_run) lines.push("> DRY RUN: fake model client, synthetic fixtures. Not a measurement.", "");
  if (i.partial) {
    lines.push(
      `> PARTIAL: the --max-usd cap ($${i.max_usd.toFixed(2)}) stopped scheduling before every trial ran.`,
      "",
    );
  }
  const prod = i.prod_reference && i.prod_reference.length > 0 ? i.prod_reference : null;
  if (prod) {
    lines.push("> PROD-REFERENCE MODE: each task's reference is the prod run's own report + shipped code change. Claude was NOT re-run.");
    for (const p of prod) {
      lines.push(`> - ${p.task_id}: reference = prod run ${p.run_id} (Claude ${p.model_used}, ${p.date.slice(0, 10)}), not re-run`);
    }
    lines.push("");
  }
  lines.push(`- Model: ${i.model_key} (${i.model_lineage})`);
  lines.push(`- Harness build: ${i.harness_sha}`);
  lines.push(`- fixture_version: ${[...new Set(i.fixtures.map((f) => f.fixture_version))].join(", ")}`);
  lines.push(`- Trials per task: ${i.trials}`);
  lines.push(`- Judges: ${i.judges === "judge_unavailable" ? "judge_unavailable (hard checks only)" : i.judges.join(" + ")}`);
  if (!prod) {
    lines.push(
      `- Harness-effect judges: ${i.harness_judges === "judge_unavailable" ? "judge_unavailable (hard checks only)" : i.harness_judges.join(" + ")}`,
    );
  }
  lines.push(`- Spend: $${i.spent_usd.toFixed(2)} of $${i.max_usd.toFixed(2)} cap`);
  lines.push("");
  lines.push("## Headline vs Claude prod loop (full agent loop; tool-format and context failures count)");
  lines.push("");
  lines.push("Pass = hard checks pass AND the blind judges rate the answer same or better than Claude's prod-loop answer (majority of 2 judges x 2 orders; splits = same).");
  lines.push("");
  lines.push("| Row | Better | Same | Worse | Pass | Tasks passing every trial | Model failures | context_too_small | Excluded (infra/unattributed/unpinned/judge_incomplete) |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  lines.push(rowLine(i.model_key, i.candidate, i.trials, true));
  if (prod) {
    lines.push(rowLine("Claude prod run (reference, not re-run)", i.reference_sdk, i.trials, false));
  } else {
    lines.push(rowLine("Claude, shared loop", i.harness_shared, i.trials, true));
    lines.push(rowLine("Claude, prod loop (SDK)", i.reference_sdk, i.trials, false));
  }
  lines.push("");
  lines.push("## Paired gap vs Claude prod loop (better=+1, same=0, worse=-1; task-level bootstrap, 95%, stratified by cohort x company)");
  lines.push("");
  lines.push("| Comparison | Mean score | 95% interval | Tasks |");
  lines.push("|---|---|---|---|");
  lines.push(gapLine(`${i.model_key} vs Claude (prod loop)`, i.candidate));
  lines.push(
    prod
      ? "| Harness effect: Claude shared loop vs prod loop | n/a (prod-reference mode, Claude not re-run) | - | - |"
      : i.harness_partial
        ? "| Harness effect: Claude shared loop vs prod loop | n/a (partial) | n/a (partial) | - |"
        : gapLine("Harness effect: Claude shared loop vs prod loop", i.harness_shared),
  );
  lines.push("");
  lines.push("## Deterministic checks (candidate)");
  lines.push("");
  const hc = i.candidate.map((s) => s.hard);
  const sum = (f: (h: (typeof hc)[number]) => number) => hc.reduce((s, h) => s + f(h), 0);
  lines.push(`- Schema valid: ${hc.filter((h) => h.schema_ok).length}/${hc.length}`);
  lines.push(`- Forbidden-action attempts: ${sum((h) => h.forbidden_attempts)}`);
  lines.push(`- Invalid tool calls: ${sum((h) => h.invalid_tool_calls)}/${sum((h) => h.tool_calls)}`);
  if (prod) {
    const b = hc.filter((h) => h.build_ok !== undefined);
    lines.push(`- Build step ok (typecheck + tests + a real code change): ${b.filter((h) => h.build_ok).length}/${b.length}`);
  }
  const js = i.candidate.map((s) => s.judge).filter((j): j is NonNullable<typeof j> => !!j);
  const unanimous = js.filter((j) => j.votes.every((v) => v === j.votes[0])).length;
  lines.push(`- Judged pairs: ${js.length} (all 4 judge calls agreed on ${unanimous})`);
  lines.push("");
  lines.push(...searchRecallLines(i.search_recall));
  const inScope = (company: string) => !i.scope?.companies?.length || i.scope.companies.includes(company);
  const onCard = (t: (typeof BENCH_TENANTS)[number]) =>
    t.fleet === false ? !!i.scope?.companies?.includes(t.company) : inScope(t.company);
  const trivialOnly = (company: string, unit: string) =>
    (i.no_substantive ?? []).some((x) => x.company === company && x.unit === unit);
  for (const cohort of ["role", "channel"] as const) {
    lines.push(`## ${cohort === "role" ? "Roles" : "Channels"}`);
    lines.push("");
    lines.push("| Unit | Candidate b/s/w | Claude shared b/s/w | Claude prod pass | Note |");
    lines.push("|---|---|---|---|---|");
    const fullRoster = cohort === "role" ? REQUIRED_ROLE_UNITS : REQUIRED_CHANNEL_UNITS;
    const roster = i.scope?.units?.length ? fullRoster.filter((u) => i.scope!.units!.includes(u)) : fullRoster;
    const fromFixtures = units.filter((x) => x.startsWith(`${cohort}:`)).map((x) => x.slice(cohort.length + 1));
    for (const u of [...new Set([...roster, ...fromFixtures])].sort()) {
      if (NOT_MEASURABLE.has(u)) {
        lines.push(`| ${u} | - | - | - | not measurable yet: ${NOT_MEASURABLE.get(u)} |`);
        continue;
      }
      if (!fromFixtures.includes(u)) {
        const cos = BENCH_TENANTS.filter(onCard);
        const trivial = cos.filter((t) => trivialOnly(t.company, u)).map((t) => t.company);
        const unusable = cos.filter((t) => !trivialOnly(t.company, u)).map((t) => t.company);
        const why =
          trivial.length === 0
            ? "no usable run"
            : unusable.length === 0
              ? "no substantive run"
              : `no substantive run (${trivial.join(", ")}); no usable run (${unusable.join(", ")})`;
        lines.push(`| ${u} | - | - | - | not covered: ${why} |`);
        continue;
      }
      const ofUnit = (s: ReadonlyArray<ScoredTrial>) => s.filter((x) => x.unit === u);
      const t = trialPassRate(ofUnit(i.reference_sdk));
      lines.push(
        `| ${u} | ${bswCell(ofUnit(i.candidate))} | ${bswCell(ofUnit(i.harness_shared))} | ${t.n ? `${t.passes}/${t.n}` : "-"} | ${PARTIAL_READ_CHANNELS.get(u) ?? ""} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Coverage by company");
  lines.push("");
  for (const t of BENCH_TENANTS) {
    if (!onCard(t)) continue;
    const n = i.fixtures.filter((f) => f.company === t.company).length;
    if (t.id === null) {
      lines.push(`- ${t.company} (${t.shape}): not covered (tenant id not pinned)`);
      continue;
    }
    const missing = missingUnits(t.company, i.fixtures).filter(
      (u) => !i.scope?.units?.length || i.scope.units.includes(u),
    );
    const noSubst = missing.filter((u) => trivialOnly(t.company, u));
    const noUsable = missing.filter((u) => !trivialOnly(t.company, u));
    lines.push(
      `- ${t.company} (${t.shape}): ${n} task(s)` +
        (noUsable.length ? `; not covered: no usable run: ${noUsable.join(", ")}` : "") +
        (noSubst.length ? `; not covered: no substantive run: ${noSubst.join(", ")}` : ""),
    );
  }
  lines.push("");
  lines.push("## Fixture hashes");
  lines.push("");
  for (const f of [...i.fixtures].sort((a, b) => (a.task_id < b.task_id ? -1 : 1))) {
    lines.push(`- ${f.task_id}: ${hashFixture(f)} (v${f.fixture_version})`);
  }
  lines.push("");
  return lines.join("\n");
}

export function assertNoFixturePayload(md: string, fixtures: ReadonlyArray<TaskFixture>): void {
  const W = 32;
  const sources: string[] = [];
  for (const f of fixtures) {
    sources.push(f.input.prompt.system, f.input.prompt.initial_user);
    for (const r of f.evidence) sources.push(r.content);
    if (f.prod_reference) sources.push(f.prod_reference.summary, f.prod_reference.diff);
  }
  for (const s of sources) {
    if (!s || s.length < W) {
      if (s && s.trim().length >= 12 && md.includes(s)) {
        throw new HarnessFailure("scorecard contains fixture payload text; refusing to publish");
      }
      continue;
    }
    for (let i = 0; i + W <= s.length; i += Math.max(1, Math.floor(W / 2))) {
      if (md.includes(s.slice(i, i + W))) {
        throw new HarnessFailure("scorecard contains fixture payload text; refusing to publish");
      }
    }
  }
}

export function publishScorecard(
  finalPath: string,
  md: string,
  fixtures: ReadonlyArray<TaskFixture>,
): string {
  assertNoFixturePayload(md, fixtures);
  const dir = dirname(finalPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}.md`);
  writeFileSync(tmp, md);
  renameSync(tmp, finalPath);
  return finalPath;
}
