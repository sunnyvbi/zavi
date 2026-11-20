
import type { PostProcessorFn } from "@/agents/index";
import { writeNote, listNotes } from "@/services/memory";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";
import { getVisibleAgentSlugs } from "@/services/agents/visibility";
import {
  classifyGrowthStage,
  normalizeFunnelSteps,
  buildCurrentGrowthPlan,
  isScaleBudgetBet,
  isEarlyStage,
  type GrowthStage,
  type GrowthPlanBet,
  type CurrentGrowthPlan,
  type ExecTag,
} from "@/services/growth/current-growth-plan";
import { diagnoseFunnelTool } from "@/services/tools/growth/diagnose_funnel";
import {
  maybeResolveMarketFitReview,
  isMarketFitReviewPayload,
} from "./market-fit-review";

const CURRENT_PLAN_TAG = "current-growth-plan";

const GROWTH_BET_CLASSES = [
  "growth-lead.reallocate-budget",
  "growth-lead.lifecycle-draft",
  "growth-lead.social-draft",
];
const MAX_PENDING_BETS = 5;
const RE_PROPOSE_SUPPRESS_DAYS = 30;

const DISPATCH_SPECIALIST_CLASS = "growth-lead.dispatch-specialist";

const SOCIAL_PUBLISH_CLASS = "social.publish.v2";
const NON_DISPATCHABLE_TARGETS = new Set(["growth-lead", "operator"]);
const SLUG_RE = /^[a-z0-9-]+$/;

function parseSuggestedDispatch(
  raw: string | null,
): { slug: string; action: string | null } | null {
  if (!raw) return null;
  const token = raw.split("(")[0].trim().split(/\s+/)[0] ?? "";
  if (!token) return null;
  const dot = token.indexOf(".");
  const slug = (dot === -1 ? token : token.slice(0, dot)).toLowerCase();
  const action = dot === -1 ? null : token.slice(dot + 1).trim() || null;
  if (slug === "founder" || !SLUG_RE.test(slug)) return null;
  return { slug, action };
}

export function buildPublishPayload(
  channel: string,
  draft: string,
): Record<string, unknown> | null {
  if (channel === "linkedin_image") {
    const img = draft.match(/^\s*Image:\s*(\S+)\s*$/im);
    if (!img) return null;
    const text = draft.replace(/^\s*Image:.*$/im, "").trim();
    if (!text) return null;
    return { text, image_path: img[1] };
  }

  if (channel !== "reddit") return { text: draft };

  const sub = draft.match(/^\s*Subreddit:\s*(?:\/?r\/)?([A-Za-z0-9_]{1,21})\s*$/im);
  const title = draft.match(/^\s*Title:\s*(.+?)\s*$/im);
  if (!sub || !title) return null;

  const body = draft
    .replace(/^\s*Subreddit:.*$/im, "")
    .replace(/^\s*Title:.*$/im, "")
    .trim();
  if (!body) return null;

  return { subreddit: sub[1], title: title[1], text: body };
}

function normalizeClaim(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
}
function betDedupeKey(
  decisionClass: string,
  body: { bet_claim?: unknown; to_channel?: unknown },
): string {
  const bet = typeof body.bet_claim === "string" ? normalizeClaim(body.bet_claim) : "";
  const to = typeof body.to_channel === "string" ? body.to_channel.toLowerCase().trim() : "";
  return `${decisionClass}|${to}|${bet}`;
}

type NoteSignal = { agent: string; note_id: string; signal: string };
type ToolSignal = { tool: string; signal: string };
type MemorySignal = { memory: string; signal: string };
type SourceSignal = NoteSignal | ToolSignal | MemorySignal;

const KNOWN_GROWTH_TOOLS = new Set([
  "growth__diagnose_funnel",
  "growth__constraint_diagnosis",
  "growth__read_ads_perf",
  "growth__read_cohort",
  "growth__seo_audit",
  "growth__liquidity_gap",
  "growth__marketplace_intelligence",
  "growth__content_punchlist",
]);

type Lever = "budget" | "lifecycle" | "social";
const DECISION_CLASS_BY_LEVER: Record<Lever, string> = {
  budget: "growth-lead.reallocate-budget",
  lifecycle: "growth-lead.lifecycle-draft",
  social: "growth-lead.social-draft",
};

function isNoteSignal(s: SourceSignal): s is NoteSignal {
  return "note_id" in s;
}
function isToolSignal(s: SourceSignal): s is ToolSignal {
  return "tool" in s;
}
function isMemorySignal(s: SourceSignal): s is MemorySignal {
  return "memory" in s;
}

type ParsedBet = {
  raw: string;
  bet: string;
  lever: Lever;
  from_channel: string | null;
  to_channel: string;
  amount_usd: number | null;
  amount_qualitative: boolean;
  source_signals: SourceSignal[];
  confidence: "high" | "medium" | "low";
  rationale: string;
  suggested_dispatch: string | null;
  suggested_publish: string | null;
  draft: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseBetBlock(
  block: string,
  fanInNoteIds: Set<string> | null,
): ParsedBet | { error: string } {
  const get = (label: string): string | null => {
    const m = block.match(new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, "m"));
    return m ? m[1] : null;
  };

  const bet = get("Bet");
  const fromTo = get("From\\s*[→\\->]+\\s*To") || get("From");
  const amountRaw = get("Amount");
  const confidence = (get("Confidence") || "").toLowerCase().trim();
  const rationale = get("Rationale") || "";
  const suggested_dispatch = get("Suggested dispatch");
  const suggested_publish = get("Suggested publish");

  const draftMatch = block.match(
    /Draft:[ \t]*\r?\n?([\s\S]*?)(?=\r?\n[ \t]*(?:Bet|Lever|Amount|Source signals|Confidence|Rationale|Suggested dispatch|Suggested publish):|$)/,
  );
  const draft = draftMatch ? draftMatch[1].trim() || null : null;
  const leverRaw = (get("Lever") || "budget").toLowerCase().trim();
  if (!["budget", "lifecycle", "social"].includes(leverRaw)) {
    return { error: `invalid Lever '${leverRaw}' (want budget|lifecycle|social)` };
  }
  const lever = leverRaw as Lever;

  if ((lever === "lifecycle" || lever === "social") && !draft) {
    return {
      error: `${lever} bet missing required Draft: section (shippable copy)`,
    };
  }

  if (!bet) return { error: "missing Bet line" };
  if (!amountRaw) return { error: "missing Amount line" };
  if (!["high", "medium", "low"].includes(confidence)) {
    return { error: `invalid Confidence '${confidence}' (want high|medium|low)` };
  }

  let from_channel: string | null = null;
  let to_channel = "";
  if (fromTo) {
    const arrow = fromTo.match(/^(.+?)\s*[→\->]+\s*(.+)$/);
    if (arrow) {
      from_channel = arrow[1].trim();
      to_channel = arrow[2].trim();
    } else {
      to_channel = fromTo.trim();
    }
  }
  if (!to_channel) return { error: "missing to_channel" };

  let amount_usd: number | null = null;
  let amount_qualitative = false;
  if (/^qualitative$/i.test(amountRaw.trim())) {
    amount_qualitative = true;
  } else {
    const m = amountRaw.match(/\$\s*(\d+(?:\.\d+)?)/);
    if (!m) return { error: `unparseable Amount '${amountRaw}'` };
    amount_usd = parseFloat(m[1]);
  }

  const signalsBlock = block.match(/Source signals:\s*\n((?:\s*-.*\n?)+)/m);
  if (!signalsBlock) return { error: "missing Source signals block" };
  const signalLines = signalsBlock[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"));
  if (signalLines.length === 0) return { error: "empty Source signals list" };

  const source_signals: SourceSignal[] = [];
  for (const line of signalLines) {
    const agent = line.match(/agent:\s*['"]([^'"]+)['"]/)?.[1];
    const note_id = line.match(/note_id:\s*['"]([^'"]+)['"]/)?.[1];
    const tool = line.match(/tool:\s*['"]([^'"]+)['"]/)?.[1];
    const memory = line.match(/memory:\s*['"]([^'"]+)['"]/)?.[1];
    const signal = line.match(/signal:\s*['"]([^'"]+)['"]/)?.[1];
    if (!signal) {
      return { error: `signal missing in line: ${line}` };
    }
    const families = [
      agent || note_id ? "note" : null,
      tool ? "tool" : null,
      memory ? "memory" : null,
    ].filter(Boolean);
    if (families.length > 1) {
      return { error: `signal line mixes provenance shapes: ${line}` };
    }
    if (agent && note_id) {
      if (!UUID_RE.test(note_id)) {
        return { error: `note_id is not a uuid: ${note_id}` };
      }
      if (fanInNoteIds === null) {
        return {
          error: `note signal but run had no fan-in set (cite a {tool} instead): ${note_id}`,
        };
      }
      if (!fanInNoteIds.has(note_id)) {
        return { error: `note_id not in this run's fan-in set: ${note_id}` };
      }
      source_signals.push({ agent, note_id, signal });
    } else if (tool) {
      if (!KNOWN_GROWTH_TOOLS.has(tool)) {
        return { error: `unknown growth tool in signal: ${tool}` };
      }
      source_signals.push({ tool, signal });
    } else if (memory) {
      source_signals.push({ memory, signal });
    } else {
      return {
        error: `signal line needs {agent,note_id}, {tool}, or {memory}: ${line}`,
      };
    }
  }
  if (source_signals.length === 0) {
    return { error: "source_signals must be non-empty" };
  }

  return {
    raw: block,
    bet,
    lever,
    from_channel,
    to_channel,
    amount_usd,
    amount_qualitative,
    source_signals,
    confidence: confidence as "high" | "medium" | "low",
    rationale,
    suggested_dispatch,
    suggested_publish,
    draft: lever === "budget" ? null : draft,
  };
}

function extractFunnelDiagnosis(machine_digest: string): string | null {
  const m = machine_digest.match(
    /##\s*Funnel diagnosis[^\n]*\n([\s\S]*?)(?=\n##\s|$)/,
  );
  const body = m?.[1]?.trim();
  return body && body.length > 0 ? body : null;
}

function extractTier1BetBlocks(machine_digest: string): string[] {
  const tier1Match = machine_digest.match(/##\s*Tier\s*1[^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
  if (!tier1Match) return [];
  const tier1 = tier1Match[1];
  const chunks = tier1.split(/\n(?=Bet:)/);
  return chunks.map((c) => c.trim()).filter((c) => c.startsWith("Bet:"));
}

async function deriveGrowthStage(
  ctx: Parameters<PostProcessorFn>[0],
): Promise<GrowthStage> {
  try {
    const res = (await diagnoseFunnelTool.execute(
      {
        tenant_id: ctx.tenant_id,
        log: () => {},
        run_id: ctx.runId,
        agent_slug: "growth-lead",
      },
      {},
    )) as { funnel?: unknown };
    return classifyGrowthStage({
      sourceAvailable: true,
      steps: normalizeFunnelSteps(res?.funnel),
    });
  } catch {
    return classifyGrowthStage({ sourceAvailable: false, steps: [] });
  }
}

const GROWTH_DATA_SLUGS = [
  "operator_db",
  "stripe",
  "meta_ads",
  "google_ads",
  "posthog",
] as const;

async function hasConnectedGrowthDataSource(tenantId: string): Promise<boolean> {
  try {
    const { data, error } = await serviceClient()
      .from("connector_metadata")
      .select("slug")
      .eq("tenant_id", tenantId)
      .in("slug", GROWTH_DATA_SLUGS as unknown as string[])
      .limit(1);
    if (error) {
      console.warn(
        `[growth-lead post-run] connector_metadata read failed for tenant=${tenantId}; treating as not-connected: ${error.message}`,
      );
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.warn(
      `[growth-lead post-run] connector_metadata read threw for tenant=${tenantId}; treating as not-connected: ${(e as Error).message}`,
    );
    return false;
  }
}

function toPlanBet(b: ParsedBet): GrowthPlanBet {
  const evidence_text = [
    b.rationale,
    ...b.source_signals.map((s) => s.signal),
    ...b.source_signals.map((s) =>
      isToolSignal(s) ? s.tool : isMemorySignal(s) ? s.memory : "",
    ),
  ].join(" ");
  return {
    bet: b.bet,
    lever: b.lever,
    amount_usd: b.amount_usd,
    amount_qualitative: b.amount_qualitative,
    suggested_dispatch: b.suggested_dispatch,
    suggested_publish: b.suggested_publish,
    evidence_text,
  };
}

function renderCurrentGrowthPlan(plan: CurrentGrowthPlan): string {
  const label = (e: ExecTag): string =>
    e === "yes"
      ? "ready to run"
      : e === "needs-connector"
      ? "needs a connector"
      : e === "needs-data"
      ? "needs more data"
      : "manual";
  const lines: string[] = [
    `## Current growth plan`,
    ``,
    `**Stage:** ${plan.stage}`,
    ``,
    `### Do this first`,
    plan.now
      ? `- ${plan.now.action} _(${label(plan.now.exec)})_`
      : `- (no new action surfaced this run)`,
  ];
  if (plan.next.length > 0) {
    lines.push(``, `### Next`, ...plan.next.map((a) => `- ${a.action} _(${label(a.exec)})_`));
  }
  if (plan.later.length > 0) {
    lines.push(``, `### Later`, ...plan.later.map((s) => `- ${s}`));
  }
  return lines.join("\n");
}

async function upsertCurrentGrowthPlan(
  ctx: Parameters<PostProcessorFn>[0],
  stage: GrowthStage,
  validBets: ParsedBet[],
): Promise<void> {
  const connected =
    stage === "data_not_ready"
      ? await hasConnectedGrowthDataSource(ctx.tenant_id)
      : false;
  const plan = buildCurrentGrowthPlan({
    stage,
    bets: validBets.map(toPlanBet),
    updatedAt: new Date().toISOString(),
    hasConnectedGrowthDataSource: connected,
  });

  let existingId: string | null = null;
  try {
    const existing = await listNotes(ctx.tenant_id, {
      note_type: "growth_priorities",
      tag: CURRENT_PLAN_TAG,
      limit: 1,
    });
    existingId = existing[0]?.id ?? null;
  } catch (e) {
    console.warn(
      `[growth-lead post-run] find current-plan note failed; creating fresh (run_id=${ctx.runId}): ${(e as Error).message}`,
    );
  }

  try {
    await writeNote(ctx.tenant_id, {
      ...(existingId ? { id: existingId } : {}),
      note_type: "growth_priorities",
      title: `Current growth plan — ${plan.stage}`,
      body_markdown: renderCurrentGrowthPlan(plan),
      source: "agent_run",
      source_ref: ctx.runId,
      tags: [CURRENT_PLAN_TAG, `stage:${plan.stage}`],
      metadata: { kind: "current_growth_plan", plan },
    });
  } catch (e) {
    console.warn(
      `[growth-lead post-run] writeNote(current growth plan) failed (run_id=${ctx.runId}): ${(e as Error).message}`,
    );
  }
}

export const growthOrchestratorPostProcess: PostProcessorFn = async (
  ctx,
  result,
  payload,
) => {
  try {
    const handled = await maybeResolveMarketFitReview(ctx, result, payload);
    if (handled) return;
  } catch (e) {
    console.warn(
      `[growth-lead post-run] market-fit review branch threw (run_id=${ctx.runId}); sweep will re-drive: ${(e as Error).message}`,
    );
    if (isMarketFitReviewPayload(payload)) return;
  }

  if (!result.parse_ok || !result.parsed) {
    console.warn(
      `[growth-lead post-run] envelope parse failed, skipping (run_id=${ctx.runId})`,
    );
    return;
  }

  const rawIds =
    payload && typeof payload === "object"
      ? (payload as { fan_in_note_ids?: unknown }).fan_in_note_ids
      : undefined;
  const fanInNoteIds: Set<string> | null = Array.isArray(rawIds)
    ? new Set(rawIds.filter((x): x is string => typeof x === "string"))
    : null;

  const parsed = result.parsed as
    | { rendered_markdown?: string; machine_digest?: string }
    | null;
  const machine = parsed?.machine_digest ?? parsed?.rendered_markdown ?? "";
  if (!machine) {
    console.warn(`[growth-lead post-run] empty machine_digest/rendered_markdown (run_id=${ctx.runId})`);
    return;
  }

  const blocks = extractTier1BetBlocks(machine);
  const validBets: ParsedBet[] = [];
  const skipped: Array<{ block_preview: string; reason: string }> = [];

  for (const block of blocks) {
    const parsedBet = parseBetBlock(block, fanInNoteIds);
    if ("error" in parsedBet) {
      skipped.push({
        block_preview: block.slice(0, 120),
        reason: parsedBet.error,
      });
      console.warn(
        `[growth-lead post-run] skipping bet — ${parsedBet.error} (run_id=${ctx.runId})`,
      );
      continue;
    }
    validBets.push(parsedBet);
  }

  const stage = await deriveGrowthStage(ctx);

  await upsertCurrentGrowthPlan(ctx, stage, validBets);

  const seenKeys = new Set<string>();
  let pendingCount = 0;
  try {
    const sinceIso = new Date(
      Date.now() - RE_PROPOSE_SUPPRESS_DAYS * 86_400_000,
    ).toISOString();
    const { data: existing } = await serviceClient()
      .from("decisions")
      .select("decision_class, body, status")
      .eq("tenant_id", ctx.tenant_id)
      .in("status", ["proposed", "acted", "rejected"])
      .gte("emitted_at", sinceIso)
      .in("decision_class", GROWTH_BET_CLASSES);
    for (const d of (existing ?? []) as Array<{
      decision_class: string;
      body: Record<string, unknown> | null;
      status: string;
    }>) {
      if (d.status === "proposed") pendingCount += 1;
      seenKeys.add(betDedupeKey(d.decision_class, d.body ?? {}));
    }
  } catch (e) {
    console.warn(
      `[growth-lead post-run] pending-decision read failed; skipping dedupe/cap (run_id=${ctx.runId}): ${(e as Error).message}`,
    );
  }

  let visibleFleet: ReadonlySet<string> | null = null;
  try {
    visibleFleet = await getVisibleAgentSlugs(ctx.tenant_id);
  } catch (e) {
    console.warn(
      `[growth-lead post-run] visible-fleet lookup failed; skipping dispatch emits (run_id=${ctx.runId}): ${(e as Error).message}`,
    );
  }

  const emittedDecisionIds: string[] = [];
  const emittedDispatchIds: string[] = [];
  const emittedPublishIds: string[] = [];
  for (const bet of validBets) {
    if (isScaleBudgetBet(bet) && isEarlyStage(stage)) {
      console.log(
        `[growth-lead post-run] stage-gate — dropping scale-budget bet at stage=${stage}: '${bet.bet.slice(0, 60)}' (run_id=${ctx.runId})`,
      );
      continue;
    }
    const decisionClass = DECISION_CLASS_BY_LEVER[bet.lever];
    const key = betDedupeKey(decisionClass, { bet_claim: bet.bet, to_channel: bet.to_channel });
    if (seenKeys.has(key)) {
      console.log(
        `[growth-lead post-run] dedupe — bet already proposed or recently decided, skipping: '${bet.bet.slice(0, 60)}' (run_id=${ctx.runId})`,
      );
      continue;
    }
    if (pendingCount >= MAX_PENDING_BETS) {
      console.log(
        `[growth-lead post-run] cap — ${pendingCount} growth bets already pending (max ${MAX_PENDING_BETS}), skipping rest (run_id=${ctx.runId})`,
      );
      break;
    }

    const decisionBody = {
      bet_claim: bet.bet,
      from_channel: bet.from_channel,
      to_channel: bet.to_channel,
      amount_usd: bet.amount_usd,
      amount_qualitative: bet.amount_qualitative,
      source_signals: bet.source_signals,
      confidence: bet.confidence,
      rationale: bet.rationale,
      source_run_id: ctx.runId,
      ...(bet.draft ? { draft: bet.draft } : {}),
    };

    let decisionId: string;
    try {
      decisionId = await ctx.emitDecision(decisionClass, decisionBody);
    } catch (e) {
      console.warn(
        `[growth-lead post-run] emitDecision failed for bet '${bet.bet.slice(0, 60)}': ${(e as Error).message}`,
      );
      continue;
    }
    emittedDecisionIds.push(decisionId);
    seenKeys.add(key);
    pendingCount += 1;

    const provenanceTags = Array.from(
      new Set(
        bet.source_signals.map((s) =>
          isMemorySignal(s)
            ? `source-memory:${s.memory}`
            : isToolSignal(s)
            ? `source-tool:${s.tool}`
            : `source-agent:${s.agent}`,
        ),
      ),
    );
    const tags = [
      `decision:${decisionId}`,
      `lever:${bet.lever}`,
      ...provenanceTags,
      `to-channel:${bet.to_channel}`,
      ...(bet.from_channel ? [`from-channel:${bet.from_channel}`] : []),
      `confidence:${bet.confidence}`,
    ];

    try {
      await writeNote(ctx.tenant_id, {
        note_type: "growth_cross_bet",
        title: bet.bet.slice(0, 120),
        body_markdown: [
          `## ${bet.bet}`,
          ``,
          `**From → To:** ${bet.from_channel ?? "(new test)"} → ${bet.to_channel}`,
          `**Amount:** ${
            bet.amount_qualitative ? "qualitative" : `$${bet.amount_usd}/wk`
          }`,
          `**Confidence:** ${bet.confidence}`,
          ``,
          `### Source signals`,
          ...bet.source_signals.map((s) =>
            isMemorySignal(s)
              ? `- memory \`${s.memory}\` — ${s.signal}`
              : isToolSignal(s)
              ? `- tool \`${s.tool}\` — ${s.signal}`
              : `- ${s.agent} note \`${s.note_id}\` — ${s.signal}`,
          ),
          ``,
          `### Rationale`,
          bet.rationale,
          ...(bet.draft ? [``, `### Draft`, bet.draft] : []),
        ].join("\n"),
        source: "agent_run",
        source_ref: ctx.runId,
        tags,
      });
    } catch (e) {
      console.warn(
        `[growth-lead post-run] writeNote(growth_cross_bet) failed for decision ${decisionId}: ${(e as Error).message}`,
      );
    }

    if (visibleFleet) {
      const target = parseSuggestedDispatch(bet.suggested_dispatch);
      if (target && !NON_DISPATCHABLE_TARGETS.has(target.slug) && visibleFleet.has(target.slug)) {
        const intent = [
          target.action ? `Requested action: ${target.action}` : null,
          `Growth bet: ${bet.bet}`,
          bet.rationale ? `Rationale: ${bet.rationale}` : null,
          bet.draft ? `Spec / draft to ship:\n${bet.draft}` : null,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 2000);
        try {
          const dispatchId = await ctx.emitDecision(DISPATCH_SPECIALIST_CLASS, {
            target_agent_slug: target.slug,
            intent,
            ...(bet.draft ? { draft: bet.draft } : {}),
            origin_decision_id: decisionId,
            dispatched_by: "growth-lead",
          });
          emittedDispatchIds.push(dispatchId);
          console.log(
            `[growth-lead post-run] emitted dispatch decision ${dispatchId} → ${target.slug} (origin bet ${decisionId}, run_id=${ctx.runId})`,
          );
        } catch (e) {
          console.warn(
            `[growth-lead post-run] dispatch emitDecision failed for target '${target.slug}' (origin bet ${decisionId}): ${(e as Error).message}`,
          );
        }
      } else if (bet.suggested_dispatch && (!target || !visibleFleet.has(target?.slug ?? ""))) {
        console.log(
          `[growth-lead post-run] dispatch skipped — suggested '${bet.suggested_dispatch}' is not a dispatchable visible agent (run_id=${ctx.runId})`,
        );
      }
    }

    if (bet.lever === "social") {
      const channel = ((bet.suggested_publish ?? "").trim().split(/\s+/)[0] ?? "")
        .toLowerCase();
      const payload = channel && bet.draft ? buildPublishPayload(channel, bet.draft) : null;
      if (channel && bet.draft && payload) {
        try {
          const publishId = await ctx.emitDecision(SOCIAL_PUBLISH_CLASS, {
            channel,
            payload,
            scheduled_at: null,
          });
          emittedPublishIds.push(publishId);
          console.log(
            `[growth-lead post-run] emitted social publish decision ${publishId} → ${channel} (origin bet ${decisionId}, run_id=${ctx.runId})`,
          );
        } catch (e) {
          console.warn(
            `[growth-lead post-run] social.publish.v2 emitDecision failed for channel '${channel}' (origin bet ${decisionId}): ${(e as Error).message}`,
          );
        }
      } else {
        console.log(
          `[growth-lead post-run] social publish skipped — ${
            !channel
              ? "no Suggested publish channel"
              : !bet.draft
                ? "no Draft copy"
                : `Draft missing the fields '${channel}' needs (reddit needs Subreddit: + Title: lines)`
          } (origin bet ${decisionId}, run_id=${ctx.runId})`,
        );
      }
    }
  }

  try {
    await writeNote(ctx.tenant_id, {
      note_type: "growth_attribution_snapshot",
      title: `Growth attribution snapshot — ${new Date().toISOString().slice(0, 10)}`,
      body_markdown: [
        `## Run-level attribution snapshot`,
        ``,
        `- Valid bets emitted: ${validBets.length}`,
        `- Bets skipped (validation): ${skipped.length}`,
        `- Decision IDs: ${emittedDecisionIds.join(", ") || "(none)"}`,
        ``,
        ...(skipped.length > 0
          ? [
              `### Skipped bet reasons`,
              ...skipped.map((s) => `- ${s.reason} — \`${s.block_preview}\``),
            ]
          : []),
      ].join("\n"),
      source: "agent_run",
      source_ref: ctx.runId,
      tags: ["cohort-snapshot"],
    });
  } catch (e) {
    console.warn(
      `[growth-lead post-run] writeNote(growth_attribution_snapshot) failed: ${(e as Error).message}`,
    );
  }

  const funnelDiagnosis = extractFunnelDiagnosis(machine);
  if (funnelDiagnosis) {
    try {
      await writeNote(ctx.tenant_id, {
        note_type: "growth_funnel_diagnosis",
        title: `Funnel diagnosis — ${new Date().toISOString().slice(0, 10)}`,
        body_markdown: funnelDiagnosis,
        source: "agent_run",
        source_ref: ctx.runId,
        tags: ["funnel-diagnosis"],
      });
    } catch (e) {
      console.warn(
        `[growth-lead post-run] writeNote(growth_funnel_diagnosis) failed: ${(e as Error).message}`,
      );
    }
  }

  const toolSignals = validBets.flatMap((b) =>
    b.source_signals
      .filter(isToolSignal)
      .map((s) => ({ lever: b.lever, tool: s.tool, signal: s.signal })),
  );
  if (toolSignals.length > 0) {
    try {
      await writeNote(ctx.tenant_id, {
        note_type: "growth_lever_signal",
        title: `Lever signals — ${new Date().toISOString().slice(0, 10)}`,
        body_markdown: [
          `## Tool-cited lever signals this run`,
          ``,
          ...toolSignals.map(
            (t) => `- [${t.lever}] \`${t.tool}\` — ${t.signal}`,
          ),
        ].join("\n"),
        source: "agent_run",
        source_ref: ctx.runId,
        tags: [
          "lever-signal",
          ...Array.from(new Set(toolSignals.map((t) => `lever:${t.lever}`))),
        ],
      });
    } catch (e) {
      console.warn(
        `[growth-lead post-run] writeNote(growth_lever_signal) failed: ${(e as Error).message}`,
      );
    }
  }

  console.log(
    `[growth-lead post-run] complete (run_id=${ctx.runId}, valid_bets=${validBets.length}, skipped=${skipped.length}, dispatches=${emittedDispatchIds.length}, publishes=${emittedPublishIds.length})`,
  );
};
