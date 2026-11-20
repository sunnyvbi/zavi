
import { createHash } from "node:crypto";
import { serviceClient } from "@/services/supabase";
import { enqueueAgentRun } from "@/services/agents/runner";
import { asPlanUpgradeRequired } from "@/services/billing/tiers";
import { logDecisionNotTaken, type DecisionRejectionType } from "@/services/agents/log-decision-not-taken";
import type { AgentContext } from "@/services/agents/types";
import {
  isMetaPlaceholder,
  synthesizeClarifyingMarkdown,
} from "@/services/agents/render-select";
import {
  CODE_DISPATCH_TARGETS,
  productPmBacklogSchema,
  type ProductPmBacklog,
} from "./output-schema";
import { normSignature } from "./signature";
export { normSignature };
import { isPmRoadmapEnabled } from "./roadmap-flag";
import { emitNeedsActionDecisions } from "./needs-action";
import { UMBRELLA_CONNECTOR_ACCOUNT_LOGIN } from "@/services/sandbox/repo-access-gate";
import { getScopedRepoFullNames } from "@/services/connectors/github/scoped-repos";
import {
  deriveBaselineFromTraces,
  type OperatorDbTrace,
} from "./roadmap-metric";
import {
  roadmapHasInFlight,
  upsertRoadmapOnDispatch,
  runRecurrenceCheck,
  runLifecycleFollowThrough,
  type RecurrenceSummary,
  type LifecycleSummary,
} from "./roadmap";
import { isPmPrecisionGateEnabled } from "./precision-flag";
import { computeDispatchPrecision, type DispatchPrecision } from "./precision";

const MAX_DISPATCH_PER_RUN = 3;
const DEDUP_WINDOW_HOURS = 24;
const FORBIDDEN_DISPATCH_REGEX = /\b(migration|workflow|env(ironment)?|secret|credential|\.env|CI\/|infra(structure)?)\b/i;

const MONEY_PATH_REGEX = /\b(stripe|payout|payment|billing|invoice|charge(back)?|refund|transfer|subscription|auth|oauth|token|session|password|credential|sso|pii|gdpr|ccpa|compliance)\b/i;

const ARTIFACT_BODY_SANITY_FLOOR = 50;
const ARTIFACT_BODY_FALLBACK_THRESHOLD = 200;
const ARTIFACT_LABEL_MAX_NORMALIZED = 60;

export function normalizeArtifactLabel(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const trimmed = input
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[#*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, ARTIFACT_LABEL_MAX_NORMALIZED);
}

function prependArtifactHeader(body: string, label: string): string {
  if (/^#{1,6}\s/.test(body)) return body;
  return `## ${label}\n\n${body}`;
}

const IMPACT_N: Record<"low" | "medium" | "high", number> = { low: 1, medium: 3, high: 9 };
const EFFORT_N: Record<"low" | "medium" | "high", number> = { low: 1, medium: 3, high: 9 };

const CUSTOMER_IMPACT_MULT: Record<"low" | "medium" | "high", number> = {
  low: 1.0,
  medium: 1.5,
  high: 2.0,
};

type SkipReason =
  | "citation_invalid"
  | "citation_lookup_failed"
  | "rice_zero"
  | "forbidden_target"
  | "missing_repo_hint"
  | "missing_file_hints"
  | "forbidden_phrase"
  | "deduped_within_24h"
  | "cap_exceeded"
  | "enqueue_failed"
  | "self_dispatch"
  | "ungrounded_item"
  | "precision_downgrade"
  | "build_spec_conductor_owns_build"
  | "override_unvalidated"
  | "plan_upgrade_required";

type DispatchOutcome = {
  item_id: string;
  child_run_id: string;
};

type SkipRecord = { item_id: string; reason: SkipReason };

export async function processProductPmBacklog(
  ctx: AgentContext,
  rawBrief: ProductPmBacklog,
  opts?: {
    runMode?: "delivery" | "strategy_memo" | "iterate";
    isBuildAppSpec?: boolean;
    operatorDbReadThisRun?: boolean;
    operatorDbTraces?: readonly OperatorDbTrace[];
    engineerHandoff?: boolean;
  },
): Promise<{
  brief: ProductPmBacklog;
  dispatched: DispatchOutcome[];
  skipped: SkipRecord[];
}> {
  const runMode = opts?.runMode ?? "delivery";
  const isBuildAppSpec = opts?.isBuildAppSpec === true;
  const engineerHandoff = opts?.engineerHandoff === true;
  if (rawBrief.status === "strategy_memo") {
    const sBrief: ProductPmBacklog = JSON.parse(JSON.stringify(rawBrief)) as ProductPmBacklog;

    if (ctx.trigger !== "chat") {
      const coerced: ProductPmBacklog = {
        status: "insufficient_data",
        status_reason:
          "strategy_memo on non-chat trigger; coerced to delivery (cron = backlog-only).",
        rendered_markdown:
          "_Strategy mode is chat-only. This scheduled run produced no delivery backlog._",
        summary: { bullets: [] },
        backlog: [],
        dispatched_actions: [],
        recommended_actions_not_dispatched: [],
        sources_all: [],
        snapshot_run_id: ctx.runId,
      };
      return { brief: coerced, dispatched: [], skipped: [] };
    }

    const company = (ctx.memory?.company ?? "").trim();
    const s = sBrief.strategy;
    const assertsFacts = !!s && s.reframe_options.length > 0;
    const alreadyClarifying = !!s && s.clarifications_needed !== false;
    if (assertsFacts && !alreadyClarifying && company.length < 200) {
      const forcedQuestions = [
        "In one sentence: who is your first target customer and what are they doing today instead?",
        "What's your pricing / take-rate model, and why that vs the alternatives?",
        "Who are your top 1-2 competitors today, and what's the wedge that makes you not-them?",
        "What's your single biggest growth bottleneck right now — acquisition, activation, or retention — and why?",
      ];
      const forced: ProductPmBacklog = {
        status: "strategy_memo",
        rendered_markdown: synthesizeClarifyingMarkdown(forcedQuestions),
        summary: { bullets: [] },
        backlog: [],
        dispatched_actions: [],
        recommended_actions_not_dispatched: [],
        sources_all: [],
        snapshot_run_id: ctx.runId,
        strategy: {
          premise_check: "",
          reframe_options: [],
          research_findings: [],
          clarifications_needed: {
            questions: forcedQuestions,
          },
        },
      };
      return { brief: forced, dispatched: [], skipped: [] };
    }

    const cn = sBrief.strategy?.clarifications_needed;
    if (
      cn &&
      Array.isArray(cn.questions) &&
      cn.questions.length > 0 &&
      isMetaPlaceholder(sBrief.rendered_markdown)
    ) {
      sBrief.rendered_markdown = synthesizeClarifyingMarkdown(cn.questions);
    }
    const opts2 = sBrief.strategy?.reframe_options ?? [];
    if (opts2.length > 0) {
      sBrief.rendered_markdown = appendOptionsBlock(sBrief.rendered_markdown, opts2);
    }
    sBrief.snapshot_run_id = ctx.runId;
    return { brief: sBrief, dispatched: [], skipped: [] };
  }

  if (rawBrief.status !== "actionable") {
    const skipBrief: ProductPmBacklog = JSON.parse(JSON.stringify(rawBrief)) as ProductPmBacklog;
    skipBrief.snapshot_run_id = ctx.runId;

    if (skipBrief.status === "no_signal") {
      const normalized = normalizeArtifactLabel(skipBrief.artifact_label);
      skipBrief.artifact_label = normalized;

      const body = (skipBrief.rendered_markdown ?? "").trim();
      const hasLabel = typeof normalized === "string" && normalized.length > 0;
      const bodyLong = body.length >= ARTIFACT_BODY_FALLBACK_THRESHOLD;
      const bodyNonTrivial = body.length >= ARTIFACT_BODY_SANITY_FLOOR;

      if (hasLabel && bodyNonTrivial) {
        skipBrief.rendered_markdown = prependArtifactHeader(body, normalized);
      } else if (!hasLabel && bodyLong) {
        skipBrief.rendered_markdown = prependArtifactHeader(body, "Draft");
      }
    }

    return { brief: skipBrief, dispatched: [], skipped: [] };
  }

  const sb = serviceClient();
  const skipped: SkipRecord[] = [];
  let planUpgradeNote: string | null = null;
  const brief: ProductPmBacklog = JSON.parse(JSON.stringify(rawBrief)) as ProductPmBacklog;

  const roadmapEnabled = await isPmRoadmapEnabled();

  let recurrence: RecurrenceSummary = { won: 0, recurred: 0, moved: 0, flat: 0, metricOutcomes: [] };
  const baselineMetric = deriveBaselineFromTraces(opts?.operatorDbTraces);
  let lifecycle: LifecycleSummary = { stuck: [] };
  if (roadmapEnabled) {
    try {
      recurrence = await runRecurrenceCheck(ctx);
    } catch (e) {
      console.warn(`[pm post-run] roadmap recurrence check failed: ${(e as Error).message}`);
    }
    try {
      lifecycle = await runLifecycleFollowThrough(ctx);
    } catch (e) {
      console.warn(`[pm post-run] roadmap lifecycle follow-through failed: ${(e as Error).message}`);
    }
  }

  try {
    await emitNeedsActionDecisions(ctx);
  } catch (e) {
    console.warn(`[pm post-run] needs-action emit failed: ${(e as Error).message}`);
  }

  if (!isBuildAppSpec) {
    brief.backlog = brief.backlog.filter((item) => {
      if (item.evidence_sources.length === 0) {
        skipped.push({ item_id: item.item_id, reason: "ungrounded_item" });
        return false;
      }
      return true;
    });
  }

  const allCitedIds = new Set<string>();
  for (const item of brief.backlog) {
    for (const ev of item.evidence_sources) {
      if (typeof ev.agent_run_id === "string") allCitedIds.add(ev.agent_run_id);
    }
  }
  const validIds = new Set<string>();
  const citedRunsBySlug = new Map<string, { agent_slug: string; error: string | null }>();
  const groundingById = new Map<string, string>();
  let groundingReadFailed = false;
  let citationLookupFailed = false;
  if (allCitedIds.size > 0) {
    const { data, error } = await sb
      .from("agent_runs")
      .select("id, agent_slug, error, parsed, reasoning_text, output_text")
      .eq("tenant_id", ctx.tenant_id)
      .in("id", [...allCitedIds]);
    if (error) {
      console.warn(`[pm post-run] citation lookup failed: ${error.message}`);
      groundingReadFailed = true;
      citationLookupFailed = true;
      brief.status = "insufficient_data";
    } else {
      for (const r of (data ?? []) as Array<{
        id: string;
        agent_slug: string;
        error: string | null;
        parsed: unknown;
        reasoning_text: string | null;
        output_text: string | null;
      }>) {
        validIds.add(r.id);
        citedRunsBySlug.set(r.id, { agent_slug: r.agent_slug, error: r.error });
        groundingById.set(r.id, extractGroundingText(r));
      }
    }
  }

  brief.backlog = brief.backlog.filter((item) => {
    const allValid = item.evidence_sources.every((ev) => validIds.has(ev.agent_run_id));
    if (!allValid) {
      skipped.push({
        item_id: item.item_id,
        reason: citationLookupFailed ? "citation_lookup_failed" : "citation_invalid",
      });
      return false;
    }
    return true;
  });

  try {
    if (groundingReadFailed) {
      console.warn(
        "[pm post-run] item-grounding skipped (grounding-text read failed) — keeping citation-valid backlog",
      );
    } else {
      brief.backlog = brief.backlog.filter((item) => {
        const claimTokens = tokenize(`${item.problem} ${item.proposed_fix}`);
        if (claimTokens.size === 0) return true;

        const groundingTokens = new Set<string>();
        for (const ev of item.evidence_sources) {
          const g = groundingById.get(ev.agent_run_id);
          if (g) for (const t of tokenize(g)) groundingTokens.add(t);
        }
        if (groundingTokens.size === 0) return true;

        let overlap = false;
        for (const t of claimTokens) {
          if (groundingTokens.has(t)) {
            overlap = true;
            break;
          }
        }
        if (!overlap) {
          skipped.push({ item_id: item.item_id, reason: "ungrounded_item" });
          return false;
        }
        return true;
      });
    }
  } catch (e) {
    console.warn(`[pm post-run] item-grounding pass failed: ${(e as Error).message}`);
  }

  if (opts?.operatorDbReadThisRun === false) {
    let strippedCustImpact = 0;
    for (const item of brief.backlog) {
      if (item.customer_impact) {
        item.customer_impact = undefined;
        strippedCustImpact++;
      }
    }
    if (strippedCustImpact > 0) {
      console.warn(
        `[pm post-run] stripped customer_impact from ${strippedCustImpact} item(s): no operator_db read this run (Bundle A-E3 faithfulness gate)`,
      );
    }
  }

  for (const item of brief.backlog) {
    const uniqIds = new Set(item.evidence_sources.map((e) => e.agent_run_id));
    item.code_reach = uniqIds.size;
    item.code_confidence = countDistinctSignatures(uniqIds, citedRunsBySlug);
    const imp = IMPACT_N[item.impact];
    const eff = EFFORT_N[item.effort];
    const custMult = item.customer_impact
      ? CUSTOMER_IMPACT_MULT[item.customer_impact]
      : 1.0;
    item.rice_score = clamp(
      (item.code_reach * imp * custMult * item.code_confidence) / Math.max(eff, 1),
      0,
      10000,
    );
  }

  const llmRank = new Map(brief.backlog.map((b, i) => [b.item_id, i]));
  brief.backlog.sort((a, b) => b.rice_score - a.rice_score);
  for (let i = 0; i < Math.min(5, brief.backlog.length); i++) {
    const llmIdx = llmRank.get(brief.backlog[i].item_id) ?? i;
    if (Math.abs(llmIdx - i) > 1) {
      console.log(
        `[pm post-run] rank-divergence: item=${brief.backlog[i].item_id} llm_pos=${llmIdx} server_pos=${i}`,
      );
    }
  }

  applyPriorityOverrides(brief, { skipped });

  brief.snapshot_run_id = ctx.runId;

  const remainingItemIds = new Set(brief.backlog.map((b) => b.item_id));
  brief.dispatched_actions = brief.dispatched_actions.filter((d) => {
    if (!remainingItemIds.has(d.item_id)) {
      skipped.push({ item_id: d.item_id, reason: "citation_invalid" });
      return false;
    }
    return true;
  });

  {
    const { data: ghMeta, error: ghErr } = await sb
      .from("connector_metadata")
      .select("default_repo_full_name")
      .eq("tenant_id", ctx.tenant_id)
      .eq("slug", "github")
      .maybeSingle();
    if (ghErr) {
      console.warn(
        `[pm post-run] connector_metadata read failed for tenant=${ctx.tenant_id}: ${ghErr.message} — skipping repo-hint resolution`,
      );
    } else {
      const connectedRepos = await getScopedRepoFullNames(ctx.tenant_id, sb);
      let provisionedRepo: string | null = null;
      {
        const { data: prRow, error: prErr } = await sb
          .from("tenant_resources")
          .select("external_ref")
          .eq("tenant_id", ctx.tenant_id)
          .eq("resource_kind", "repo")
          .eq("mode", "provisioned")
          .maybeSingle();
        if (prErr) {
          console.warn(
            `[pm post-run] tenant_resources(repo) read failed for tenant=${ctx.tenant_id}: ${prErr.message} — keeping model hints as-is`,
          );
        } else {
          const ref = (prRow as { external_ref?: Record<string, unknown> } | null)?.external_ref;
          const full = ref?.github_full_name;
          if (typeof full === "string" && full.trim().length > 0) provisionedRepo = full.trim();
        }
      }
      const tenantDefault =
        typeof ghMeta?.default_repo_full_name === "string"
          ? ghMeta.default_repo_full_name
          : null;
      const defaultUsable = !!tenantDefault && connectedRepos.includes(tenantDefault);
      for (const d of brief.dispatched_actions) {
        const hint = (d.repo_hint ?? "").trim();
        const hintIsUmbrella = hint.startsWith(`${UMBRELLA_CONNECTOR_ACCOUNT_LOGIN}/`);
        if (provisionedRepo && (hint.length === 0 || hintIsUmbrella)) {
          d.repo_hint = provisionedRepo;
        } else if (hint.length > 0 && connectedRepos.includes(hint)) {
          d.repo_hint = hint;
        } else if (hint.length === 0) {
          d.repo_hint = defaultUsable ? tenantDefault! : "";
        } else {
          console.log(
            `[pm post-run] dropping dispatch: repo_hint "${hint}" not in connected repos for tenant=${ctx.tenant_id}`,
          );
          d.repo_hint = "";
        }
      }
    }
  }

  const itemById = new Map(brief.backlog.map((b) => [b.item_id, b]));
  brief.dispatched_actions = brief.dispatched_actions.filter((d) => {
    const item = itemById.get(d.item_id);
    if (!item) return false;
    if (d.target_agent_slug === ctx.agent.slug) {
      skipped.push({ item_id: d.item_id, reason: "self_dispatch" });
      return false;
    }
    if (!(CODE_DISPATCH_TARGETS as readonly string[]).includes(item.target)) {
      skipped.push({ item_id: d.item_id, reason: "forbidden_target" });
      return false;
    }
    if (!d.repo_hint || d.repo_hint.trim() === "") {
      skipped.push({ item_id: d.item_id, reason: "missing_repo_hint" });
      return false;
    }
    if (!d.file_hints || d.file_hints.length === 0) {
      skipped.push({ item_id: d.item_id, reason: "missing_file_hints" });
      return false;
    }
    if (FORBIDDEN_DISPATCH_REGEX.test(d.task_description)) {
      skipped.push({ item_id: d.item_id, reason: "forbidden_phrase" });
      return false;
    }
    return true;
  });

  const rankByItem = new Map(brief.backlog.map((b, i) => [b.item_id, i]));
  brief.dispatched_actions.sort(
    (a, b) => (rankByItem.get(a.item_id) ?? 999) - (rankByItem.get(b.item_id) ?? 999),
  );
  let precisionDowngrade = false;
  let precisionRead: DispatchPrecision | null = null;
  if (runMode === "delivery") {
    try {
      if (await isPmPrecisionGateEnabled()) {
        precisionRead = await computeDispatchPrecision(ctx);
        precisionDowngrade = precisionRead.downgrade;
      }
    } catch (e) {
      console.warn(`[pm post-run] precision gate read failed: ${(e as Error).message}`);
    }
  }

  const effectiveDispatchCap =
    runMode === "iterate" || precisionDowngrade || isBuildAppSpec ? 0 : MAX_DISPATCH_PER_RUN;
  const capHoldReason: SkipReason = isBuildAppSpec
    ? "build_spec_conductor_owns_build"
    : precisionDowngrade
      ? "precision_downgrade"
      : "cap_exceeded";
  const capped: typeof brief.dispatched_actions = [];
  for (const d of brief.dispatched_actions) {
    if (capped.length >= effectiveDispatchCap) {
      skipped.push({ item_id: d.item_id, reason: capHoldReason });
      continue;
    }
    capped.push(d);
  }
  brief.dispatched_actions = capped;

  const dispatched: DispatchOutcome[] = [];
  const survivors: typeof brief.dispatched_actions = [];
  for (const d of brief.dispatched_actions) {
    const item = itemById.get(d.item_id);
    if (!item) continue;
    const dedupKey = computeDedupKey({
      source: ctx.agent.slug,
      target: d.target_agent_slug,
      target_kind: item.target,
      repo_hint: d.repo_hint ?? "",
      file_hints: d.file_hints,
    });

    const since = new Date(Date.now() - DEDUP_WINDOW_HOURS * 3600 * 1000).toISOString();
    const { data: existing, error: dedupErr } = await sb
      .from("dispatch_history")
      .select("id")
      .eq("tenant_id", ctx.tenant_id)
      .eq("dedup_key", dedupKey)
      .gt("created_at", since)
      .limit(1)
      .maybeSingle();
    if (dedupErr) {
      console.warn(`[pm post-run] dedup lookup failed for ${dedupKey}: ${dedupErr.message}`);
    }
    if (existing) {
      skipped.push({ item_id: d.item_id, reason: "deduped_within_24h" });
      continue;
    }

    if (roadmapEnabled) {
      const inFlight = await roadmapHasInFlight(ctx, dedupKey);
      if (inFlight) {
        skipped.push({ item_id: d.item_id, reason: "deduped_within_24h" });
        continue;
      }
    }

    let baselineSignature: string | null = null;
    for (const ev of item.evidence_sources) {
      const meta = citedRunsBySlug.get(ev.agent_run_id);
      const sig = normSignature(meta?.error);
      if (sig) {
        baselineSignature = sig;
        break;
      }
    }

    const prdBlock = buildPrdBlock(d.acceptance_criteria, d.edge_cases);

    let child_run_id = "";
    try {
      const enq = await enqueueAgentRun({
        tenant_id: ctx.tenant_id,
        agent_slug: d.target_agent_slug,
        trigger: "a2a",
        payload: {
          source_agent: "pm",
          source_run_id: ctx.runId,
          task_description: d.task_description,
          repo_hint: d.repo_hint ?? "",
          file_hints: d.file_hints,
          context_summary: `Surfaced by pm RICE backlog. Theme: ${item.theme}. Reach=${item.code_reach}, confidence=${item.code_confidence}, rice=${item.rice_score.toFixed(2)}. Reasoning: ${item.reasoning.slice(0, 280)}${prdBlock}`,
          thread_id: ctx.thread_id,
        } as object,
      });
      if (!enq.run_id) {
        skipped.push({ item_id: d.item_id, reason: "enqueue_failed" });
        continue;
      }
      child_run_id = enq.run_id;
    } catch (e) {
      const planRefusal = asPlanUpgradeRequired(e);
      if (planRefusal) {
        skipped.push({ item_id: d.item_id, reason: "plan_upgrade_required" });
        planUpgradeNote ??= planRefusal.message;
        continue;
      }
      console.warn(`[pm post-run] enqueue engineer failed: ${(e as Error).message}`);
      skipped.push({ item_id: d.item_id, reason: "enqueue_failed" });
      continue;
    }

    const { error: insErr } = await sb.from("dispatch_history").insert({
      tenant_id: ctx.tenant_id,
      source_agent_slug: ctx.agent.slug,
      source_run_id: ctx.runId,
      target_agent_slug: d.target_agent_slug,
      target_run_id: child_run_id,
      dedup_key: dedupKey,
    });
    if (insErr) {
      console.warn(`[pm post-run] dispatch_history insert failed for ${dedupKey}: ${insErr.message}`);
    }

    await upsertRoadmapOnDispatch(ctx, {
      dedup_key: dedupKey,
      theme: item.theme,
      theme_normalized: item.theme_normalized,
      child_run_id,
      baseline_signature: baselineSignature,
      baseline_metric: baselineMetric,
    });

    survivors.push({ ...d, child_run_id });
    dispatched.push({ item_id: d.item_id, child_run_id });
  }
  brief.dispatched_actions = survivors;

  if (brief.backlog.length === 0) {
    brief.status = brief.status === "insufficient_data" ? "insufficient_data" : "no_signal";
    brief.summary.bullets = [];
    brief.summary.top_theme = undefined;
    brief.rendered_markdown = citationLookupFailed
      ? "_I couldn't verify this run's supporting evidence because of a transient error, so I'm holding the backlog rather than acting on unverified data. I'll retry on the next run._"
      : brief.status === "insufficient_data"
        ? "_Not enough recent agent activity to build a product backlog yet. Nothing to act on this run — check back once your agents have been running for a while._"
        : engineerHandoff
          ? "_I can hand this to the engineer, but I need a concrete target first: which repo should they update, and what change should this drive? Tell me that and I'll dispatch the engineer with this turn (and anything you shared) as context._"
          : "_No product backlog items to surface this run — I didn't find recent agent activity pointing to anything worth prioritizing. This isn't an error; there's just nothing actionable right now._";
  } else if (brief.status === "no_signal" && brief.backlog.length > 0) {
    brief.status = "actionable";
  } else if (brief.status === "actionable" && brief.summary.bullets.length === 0) {
    brief.summary.bullets = brief.backlog.slice(0, 3).map(
      (b) => `${b.theme} (rice=${b.rice_score.toFixed(1)}) — ${b.problem.slice(0, 100)}`,
    );
  }

  const RECOMMENDABLE_SKIP_REASONS = new Set([
    "forbidden_target",
    "cap_exceeded",
    "precision_downgrade",
    "plan_upgrade_required",
  ]);
  const alreadyRecommended = new Set(brief.recommended_actions_not_dispatched.map((r) => r.item_id));
  for (const s of skipped) {
    if (!RECOMMENDABLE_SKIP_REASONS.has(s.reason)) continue;
    if (alreadyRecommended.has(s.item_id)) continue;
    const item = itemById.get(s.item_id);
    if (!item) continue;
    if (brief.recommended_actions_not_dispatched.length >= 10) break;
    brief.recommended_actions_not_dispatched.push({
      item_id: s.item_id,
      description: item.proposed_fix.slice(0, 500),
      target_team: item.target === "product" ? "product" : "ops",
      urgency: item.impact === "high" ? "now" : item.impact === "medium" ? "this-week" : "this-month",
      needs_go: s.reason === "precision_downgrade",
    });
    alreadyRecommended.add(s.item_id);
  }

  if (!isBuildAppSpec && ctx.trigger !== "chat" && precisionDowngrade && precisionRead && brief.rendered_markdown && !brief.rendered_markdown.includes("> **Auto-dispatch paused")) {
    const pct = precisionRead.precision !== null ? Math.round(precisionRead.precision * 100) : 0;
    const line = `> **Auto-dispatch paused — your recent dispatches scored ${pct}% acceptance (${precisionRead.good}/${precisionRead.settled} kept).** I've moved this run's top fixes to "needs your go" below instead of auto-shipping them. Approve the ones worth building and I'll resume auto-dispatch as the score recovers.\n\n`;
    if ((line.length + brief.rendered_markdown.length) <= 3400) {
      brief.rendered_markdown = line + brief.rendered_markdown;
    }
  }

  if (planUpgradeNote) {
    const line = `\n\n> ${planUpgradeNote} I've listed the fixes below instead of building them. You can upgrade on the Billing page.`;
    const current = brief.rendered_markdown ?? "";
    if (current.length + line.length <= 3500) {
      brief.rendered_markdown = current + line;
    }
  }

  if (
    roadmapEnabled &&
    (recurrence.won > 0 || recurrence.recurred > 0 || recurrence.moved > 0 || recurrence.flat > 0)
  ) {
    const parts: string[] = [];
    if (recurrence.won > 0) parts.push(`${recurrence.won} fix${recurrence.won === 1 ? "" : "es"} measured as held (won)`);
    if (recurrence.recurred > 0) parts.push(`${recurrence.recurred} prior fix${recurrence.recurred === 1 ? " did" : "es did"} not hold (recurred — re-surfaced)`);
    if (recurrence.moved > 0) parts.push(`${recurrence.moved} tracked metric${recurrence.moved === 1 ? "" : "s"} moved`);
    if (recurrence.flat > 0) parts.push(`${recurrence.flat} tracked metric${recurrence.flat === 1 ? "" : "s"} flat`);
    const line = `\n\n## Learnings\nRoadmap outcomes this run: ${parts.join("; ")}.`;
    const current = brief.rendered_markdown ?? "";
    if (current.length + line.length <= 3500) {
      brief.rendered_markdown = current + line;
    }
  }

  if (roadmapEnabled && lifecycle.stuck.length > 0) {
    const STAGE_LABEL: Record<string, string> = {
      dispatched: "dispatched, no PR yet",
      engineer_done: "engineer done, no PR yet",
      pr_open: "PR open, awaiting review",
    };
    const items = lifecycle.stuck
      .slice(0, 5)
      .map((s) => {
        const where = STAGE_LABEL[s.stage] ?? s.stage;
        return `  • ${s.theme} — stuck ${s.days_stuck}d (${where})`;
      })
      .join("\n");
    const header = `\n\n## Stuck in review\n${lifecycle.stuck.length} dispatched fix${lifecycle.stuck.length === 1 ? " has" : "es have"} sat > ${7}d without landing — nudge these:`;
    const block = `${header}\n${items}`;
    const current = brief.rendered_markdown ?? "";
    if (current.length + block.length <= 3500) {
      brief.rendered_markdown = current + block;
    }
  }

  if (brief.status === "actionable" && brief.backlog.length > 0) {
    const top = brief.backlog[0];
    const ov = top.priority_override;
    if (ov && brief.rendered_markdown && !brief.rendered_markdown.includes("> **Ranked #1 over")) {
      const line = `> **Ranked #1 over higher-RICE items — ${ov.reason_class}:** ${ov.rationale.slice(0, 200)}\n\n`;
      if ((line.length + brief.rendered_markdown.length) <= 3400) {
        brief.rendered_markdown = line + brief.rendered_markdown;
      }
    }
  }

  if (brief.status === "actionable" && brief.backlog.length > 0) {
    brief.rendered_markdown = appendRiceTable(brief.rendered_markdown, brief.backlog);
  }

  const reparse = productPmBacklogSchema.safeParse(brief);
  if (!reparse.success) {
    console.warn(
      `[pm post-run] post-mutation revalidation failed — ${reparse.error.issues[0]?.message ?? "unknown"}`,
    );
  }

  const REASON_TO_REJECTION: Record<string, DecisionRejectionType> = {
    forbidden_target: "autonomy_forbidden",
    forbidden_phrase: "autonomy_forbidden",
    cap_exceeded: "cap_exceeded",
  };
  await Promise.all(
    skipped
      .filter((s) => s.reason in REASON_TO_REJECTION)
      .map((s) =>
        logDecisionNotTaken({
          tenant_id: ctx.tenant_id,
          agent_run_id: ctx.runId,
          agent_slug: ctx.agent.slug,
          decision_class: "pm.dispatch",
          rejection_type: REASON_TO_REJECTION[s.reason],
          reason_code: s.reason,
        }),
      ),
  );

  return { brief, dispatched, skipped };
}

function applyPriorityOverrides(
  brief: ProductPmBacklog,
  args: { skipped: SkipRecord[] },
): void {
  const itemIds = new Set(brief.backlog.map((b) => b.item_id));
  type Move = { item_id: string; targetRank: number };
  const moves: Move[] = [];
  for (const item of brief.backlog) {
    const ov = item.priority_override;
    if (!ov) continue;
    const valid = validateOverride(item, ov, { itemIds });
    if (!valid) {
      args.skipped.push({ item_id: item.item_id, reason: "override_unvalidated" });
      delete (item as { priority_override?: unknown }).priority_override;
      continue;
    }
    moves.push({ item_id: item.item_id, targetRank: ov.rank });
  }
  if (moves.length === 0) return;
  moves.sort((a, b) => a.targetRank - b.targetRank);
  for (const mv of moves) {
    const from = brief.backlog.findIndex((b) => b.item_id === mv.item_id);
    if (from < 0) continue;
    const to = Math.max(0, Math.min(mv.targetRank - 1, from));
    if (to >= from) continue;
    const [moved] = brief.backlog.splice(from, 1);
    brief.backlog.splice(to, 0, moved);
  }
}

function validateOverride(
  item: ProductPmBacklog["backlog"][number],
  ov: NonNullable<ProductPmBacklog["backlog"][number]["priority_override"]>,
  args: { itemIds: Set<string> },
): boolean {
  switch (ov.reason_class) {
    case "dependency":
      return (
        !!ov.depends_on_item_id &&
        ov.depends_on_item_id !== item.item_id &&
        args.itemIds.has(ov.depends_on_item_id)
      );
    case "money_or_compliance":
      return (
        (item.target === "backend" || item.target === "agent_prompt") &&
        MONEY_PATH_REGEX.test(
          `${item.theme} ${item.problem} ${item.proposed_fix} ${item.theme_normalized}`,
        )
      );
    case "churn_risk_anchor":
      return item.customer_impact === "high";
    case "table_stakes":
      return false;
    default:
      return false;
  }
}

function buildPrdBlock(
  acceptanceCriteria: string[] | undefined,
  edgeCases: string[] | undefined,
): string {
  const ac = (acceptanceCriteria ?? []).slice(0, 8).map((s) => s.slice(0, 300));
  const ec = (edgeCases ?? []).slice(0, 8).map((s) => s.slice(0, 300));
  if (ac.length === 0 && ec.length === 0) return "";
  const parts: string[] = [];
  if (ac.length > 0) {
    parts.push(`Acceptance criteria:\n${ac.map((c) => `- ${c}`).join("\n")}`);
  }
  if (ec.length > 0) {
    parts.push(`Edge cases:\n${ec.map((c) => `- ${c}`).join("\n")}`);
  }
  return `\n\n${parts.join("\n\n")}`;
}

const RENDERED_MARKDOWN_SOFT_CAP = 3400;
const RENDERED_MARKDOWN_HARD_CAP = 3900;
const RICE_TABLE_HEADING = "## RICE-ranked backlog";
const OPTIONS_HEADING = "## Options (ranked)";

function tableCell(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").trim();
}

function appendRiceTable(
  current: string | undefined,
  backlog: ProductPmBacklog["backlog"],
): string {
  const body = current ?? "";
  if (body.includes(RICE_TABLE_HEADING)) return body;

  const buildBlock = (rowCap: number): string => {
    const shown = backlog.slice(0, rowCap);
    const lines: string[] = [
      "",
      "",
      RICE_TABLE_HEADING,
      "| # | Item | RICE | Impact | Effort |",
      "| --- | --- | --- | --- | --- |",
    ];
    shown.forEach((item, i) => {
      const itemLabel = item.theme && item.theme.trim().length > 0
        ? item.theme
        : item.problem.slice(0, 60);
      lines.push(
        `| ${i + 1} | ${tableCell(itemLabel)} | ${item.rice_score.toFixed(1)} | ${tableCell(item.impact)} | ${tableCell(item.effort)} |`,
      );
    });
    const more = backlog.length - shown.length;
    if (more > 0) lines.push(`_…${more} more_`);
    return lines.join("\n");
  };

  for (let rowCap = Math.min(8, backlog.length); rowCap >= 1; rowCap--) {
    const candidate = body + buildBlock(rowCap);
    if (candidate.length <= RENDERED_MARKDOWN_SOFT_CAP) return candidate;
  }
  const minimal = body + buildBlock(1);
  return minimal.length <= RENDERED_MARKDOWN_HARD_CAP ? minimal : body;
}

function appendOptionsBlock(
  current: string | undefined,
  options: NonNullable<ProductPmBacklog["strategy"]>["reframe_options"],
): string {
  const body = current ?? "";
  if (body.includes(OPTIONS_HEADING)) return body;

  const sorted = [...options].sort((a, b) => a.rank - b.rank);

  const buildBlock = (count: number): string => {
    const shown = sorted.slice(0, count);
    const lines: string[] = ["", "", OPTIONS_HEADING];
    for (const opt of shown) {
      const rationale = (opt.rationale ?? "").replace(/[\r\n]+/g, " ").trim();
      lines.push(`**${opt.rank}. ${opt.title}** — ${rationale}`);
      if (opt.metrics && opt.metrics.length > 0) {
        lines.push(`_metrics: ${opt.metrics.join(", ")}_`);
      }
    }
    const more = sorted.length - shown.length;
    if (more > 0) lines.push(`_…${more} more_`);
    return lines.join("\n");
  };

  for (let count = sorted.length; count >= 1; count--) {
    const candidate = body + buildBlock(count);
    if (candidate.length <= RENDERED_MARKDOWN_SOFT_CAP) return candidate;
  }
  const minimal = body + buildBlock(1);
  return minimal.length <= RENDERED_MARKDOWN_HARD_CAP ? minimal : body;
}

function extractGroundingText(row: {
  parsed: unknown;
  reasoning_text: string | null;
  output_text: string | null;
}): string {
  let text = "";
  const parsed = row.parsed;
  if (parsed && typeof parsed === "object") {
    const summary = (parsed as Record<string, unknown>).summary;
    if (typeof summary === "string") text = summary;
  }
  if (!text && typeof row.reasoning_text === "string") text = row.reasoning_text;
  if (!text && typeof row.output_text === "string") text = row.output_text;
  return text.slice(0, 500);
}

const GROUNDING_STOPWORDS = new Set<string>([
  "the", "and", "for", "with", "that", "this", "from", "into", "have", "has",
  "are", "was", "were", "will", "would", "should", "could", "their", "there",
  "then", "than", "when", "what", "which", "while", "your", "yours", "about",
  "been", "being", "they", "them", "these", "those", "some", "such", "only",
  "also", "more", "most", "much", "very", "just", "over", "under", "after",
  "before", "because", "between", "within", "without", "item", "items",
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (GROUNDING_STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function countDistinctSignatures(
  citedIds: Set<string>,
  citedRunsBySlug: Map<string, { agent_slug: string; error: string | null }>,
): number {
  const groups = new Set<string>();
  for (const id of citedIds) {
    const meta = citedRunsBySlug.get(id);
    if (!meta) continue;
    groups.add(`${meta.agent_slug}:${normSignature(meta.error)}`);
  }
  return groups.size || 1;
}

export function computeDedupKey(args: {
  source: string;
  target: string;
  target_kind: string;
  repo_hint: string;
  file_hints: string[];
}): string {
  const payload = [
    args.source,
    args.target,
    args.target_kind,
    args.repo_hint,
    [...args.file_hints].sort().join(","),
  ].join("|");
  return `${args.source}:${args.target}:${createHash("sha256").update(payload).digest("hex").slice(0, 32)}`;
}
