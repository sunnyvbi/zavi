
import { createHash } from "node:crypto";
import { upsertAnchor } from "@/services/memory/upsert-anchor";
import { writeNote } from "@/services/memory";
import { sanitizeGapAnswer } from "@/services/memory/brain-slots";
import {
  createFounderGoalServiceRole,
  commitGrowthPlanServiceRole,
} from "@/routes/workspace/autopilot";
import { projectStrategy } from "@/routes/workspace/growth-strategy";
import { readStrategyNote } from "./strategy-note";
import { fanOutFirstRun } from "./auto-first-run";

type Strategy = NonNullable<ReturnType<typeof projectStrategy>>;

export type ApplyResult = {
  applied: boolean;
  skipped?: "no_strategy" | "unchanged";
  wrote: { goal: boolean; anchors: boolean; flag: boolean; plan: boolean };
  problems: string[];
};

export function renderNorthStarAnchor(metric: string, why: string): string {
  const lines = [`# North Star metric`, "", `**${metric}**`];
  if (why) lines.push("", why);
  lines.push("", "_Set from the growth strategy the founder accepted._");
  return lines.join("\n");
}

export function renderGtmAnchor(
  constraint: string,
  leverFamily: string,
  bets: string[],
): string {
  const lines = ["# Growth approach", "", "## The binding constraint", "", constraint];
  if (leverFamily) lines.push("", `Lever family: ${leverFamily}`);
  if (bets.length > 0) {
    lines.push("", "## Channels we are betting on", "", ...bets.map((b) => `- ${b}`));
  }
  lines.push("", "_Set from the growth strategy the founder accepted._");
  return lines.join("\n");
}

export function spineKey(s: Strategy): string {
  return `${s.north_star.metric.trim().toLowerCase()}::${s.constraint.statement
    .trim()
    .toLowerCase()}`;
}

export function strategyFingerprint(s: Strategy): string {
  const material = {
    north_star: s.north_star,
    constraint: s.constraint,
    goal: s.goal ?? null,
    bets: s.channel_bets.map((b) => ({
      channel_slug: b.channel_slug,
      intent: b.intent,
      rationale: b.rationale ?? null,
      expected_effect: b.expected_effect ?? null,
      falsifier: b.falsifier ?? null,
    })),
    basis_evidence: s.basis_evidence ?? [],
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32);
}

export async function applyGrowthStrategy(
  tenant_id: string,
  opts: { by: "page"; user_id: string; run_id?: undefined } | { by: "agent"; run_id: string },
): Promise<ApplyResult> {
  const wrote = { goal: false, anchors: false, flag: false, plan: false };
  const problems: string[] = [];

  const note = await readStrategyNote(tenant_id);
  const strategy = projectStrategy(note?.metadata.strategy ?? null);
  if (!note || !strategy) {
    return { applied: false, skipped: "no_strategy", wrote, problems };
  }

  const meta = note.metadata;
  const fingerprint = strategyFingerprint(strategy);
  if (meta.accepted === true && meta.applied_fingerprint === fingerprint) {
    if (opts.by === "agent") {
      await fanOutFirstRun(tenant_id, strategy.channel_bets);
    }
    return { applied: true, skipped: "unchanged", wrote, problems };
  }

  const spine = spineKey(strategy);
  let goalId =
    typeof meta.applied_goal_id === "string" ? meta.applied_goal_id : null;

  if (strategy.goal && spine !== meta.applied_spine) {
    const created = await createFounderGoalServiceRole({
      tenant_id,
      objective: strategy.goal.objective,
      target_metric: strategy.goal.target_metric,
      humanMetric: strategy.goal.target_metric,
      target_value: strategy.goal.target_value,
      baseline_value: null,
      due_date: strategy.goal.due_date,
      priority: null,
      actor:
        opts.by === "page"
          ? { source: "founder", user_id: opts.user_id, why: "Applied the growth strategy" }
          : { source: "cgo", run_id: opts.run_id, why: `Applied the growth strategy: ${strategy.goal.objective}`.slice(0, 1000) },
    });
    if (created.ok) {
      wrote.goal = true;
      goalId = created.id;
    } else {
      problems.push(`goal not created: ${created.message}`);
    }
  }

  try {
    await upsertAnchor({
      tenant_id,
      slug: "metrics_north_star",
      title: "Metrics / North Star",
      body_markdown: sanitizeGapAnswer(
        renderNorthStarAnchor(
          strategy.north_star.metric,
          strategy.north_star.why,
        ),
      ),
      source: "agent_write",
    });
    await upsertAnchor({
      tenant_id,
      slug: "gtm_growth",
      title: "GTM / Growth",
      body_markdown: sanitizeGapAnswer(
        renderGtmAnchor(
          strategy.constraint.statement,
          strategy.constraint.lever_family,
          strategy.channel_bets.map((b) => b.channel_slug),
        ),
      ),
      source: "agent_write",
    });
    wrote.anchors = true;
  } catch (e) {
    problems.push(`brain anchors not written: ${(e as Error).message}`);
  }

  try {
    const committed = await commitGrowthPlanServiceRole({
      tenant_id,
      objective: strategy.goal?.objective ?? strategy.constraint.statement,
      north_star_metric: strategy.north_star.metric,
      constraint_statement: strategy.constraint.statement,
      constraint_confidence: strategy.constraint.confidence,
      bets: strategy.channel_bets.map((b) => ({
        channel_slug: b.channel_slug,
        intent: b.intent,
        rationale: b.rationale,
        expected_effect: b.expected_effect,
        falsifier: b.falsifier,
        autorun: false,
      })),
      basis_evidence: strategy.basis_evidence,
    });
    if (committed.ok) wrote.plan = true;
    else problems.push(`plan not committed: ${committed.message}`);
  } catch (e) {
    problems.push(`plan not committed: ${(e as Error).message}`);
  }

  if (wrote.plan) {
    try {
      await writeNote(tenant_id, {
        id: note.id,
        note_type: "growth_strategy",
        title: note.title,
        body_markdown: note.body_markdown,
        source: opts.by === "page" ? "human" : "agent_run",
        ...(opts.run_id ? { source_ref: opts.run_id } : {}),
        tags: note.tags,
        metadata: {
          ...meta,
          accepted: true,
          applied_fingerprint: fingerprint,
          applied_spine: spine,
          ...(goalId ? { applied_goal_id: goalId } : {}),
        },
      });
    } catch (e) {
      problems.push(`flag write warning: ${(e as Error).message}`);
    }
    try {
      const after = await readStrategyNote(tenant_id);
      wrote.flag =
        after?.metadata.accepted === true &&
        after.metadata.applied_fingerprint === fingerprint;
      if (!wrote.flag) problems.push("the accepted flag did not persist");
    } catch (e) {
      problems.push(
        `could not confirm the accepted flag: ${(e as Error).message}`,
      );
    }
  }

  if (wrote.plan && wrote.flag && opts.by === "agent") {
    const firstRun = await fanOutFirstRun(tenant_id, strategy.channel_bets);
    if (!firstRun.ran) problems.push(`first run skipped: ${firstRun.reason}`);
  }

  return { applied: wrote.plan && wrote.flag, wrote, problems };
}
