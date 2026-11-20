
import { z } from "zod";
import { runGeneric } from "@/services/agents/generic-dispatcher";
import { getVisibleAgentSlugs } from "@/services/agents/visibility";
import { writeNote } from "@/services/memory";
import type {
  AgentContext,
  DispatcherResult,
} from "@/services/agents/types";
import { digestSchema, type Digest } from "./output-schema";
import { cosScrubAndAnnotate } from "./post-run";

const COS_SLUG = "chief-of-staff";
const NON_DISPATCHABLE = new Set([COS_SLUG, "operator"]);
const MAX_DISPATCH_DECISIONS = 4;
const DAILY_DIGEST_CLASS = "chief-of-staff.daily-digest";

export async function chiefOfStaffDispatcher(
  ctx: AgentContext,
  payload?: unknown,
): Promise<DispatcherResult> {
  const result = await runGeneric(ctx, payload);

  cosScrubAndAnnotate(ctx, result);

  if (!result.parse_ok || result.parsed == null) return result;

  const parsed = digestSchema.safeParse(result.parsed);
  if (!parsed.success) return result;

  await persistWeeklyPriorities(ctx, parsed.data.weekly_priorities);

  await maybeEmitDailyDigest(ctx, parsed.data);

  const candidates = parsed.data.tier1
    .map((t) => t.suggested_dispatch)
    .filter((d): d is NonNullable<typeof d> => d != null);

  if (candidates.length === 0) return result;

  let visible: ReadonlySet<string>;
  try {
    visible = await getVisibleAgentSlugs(ctx.tenant_id);
  } catch (e) {
    console.warn(
      `[chief-of-staff dispatcher] visible-fleet lookup failed for ${ctx.tenant_id}: ${(e as Error).message} — skipping dispatch emits`,
    );
    return result;
  }

  let emitted = 0;
  for (const d of candidates) {
    if (emitted >= MAX_DISPATCH_DECISIONS) break;
    const target = d.target_agent_slug.trim();
    if (NON_DISPATCHABLE.has(target) || !visible.has(target)) {
      console.warn(
        `[chief-of-staff dispatcher] dropping dispatch to invalid/hidden target '${target}' (tenant ${ctx.tenant_id})`,
      );
      continue;
    }
    try {
      const decisionId = await ctx.emitDecision("chief-of-staff.dispatch-specialist", {
        target_agent_slug: target,
        intent: d.intent,
      });
      emitted += 1;
      console.log(
        `[chief-of-staff dispatcher] emitted dispatch decision ${decisionId} → ${target} (tenant ${ctx.tenant_id})`,
      );
    } catch (e) {
      console.warn(
        `[chief-of-staff dispatcher] emit_decision failed for target '${target}': ${(e as Error).message}`,
      );
    }
  }

  return result;
}

type WeeklyPriority = NonNullable<
  z.infer<typeof digestSchema>["weekly_priorities"]
>;

async function persistWeeklyPriorities(
  ctx: AgentContext,
  priorities: WeeklyPriority | undefined,
): Promise<void> {
  if (!priorities || priorities.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  for (const p of priorities) {
    const slug = (p.agent_slug ?? "").trim();
    const priority = (p.priority ?? "").trim();
    if (!slug || !priority) continue;
    try {
      await writeNote(ctx.tenant_id, {
        note_type: "untyped",
        title: `Weekly priority — ${slug} — ${today}`,
        body_markdown: `**${slug}**: ${priority}`,
        source: "agent_run",
        source_ref: ctx.runId,
        tags: ["agent_priorities", `agent:${slug}`, "weekly-priority"],
      });
    } catch (e) {
      console.warn(
        `[chief-of-staff dispatcher] writeNote(agent_priorities) failed for '${slug}': ${(e as Error).message}`,
      );
    }
  }
}

export function digestHasSignal(d: Digest): boolean {
  if (!d.rendered_markdown || !d.rendered_markdown.trim()) return false;
  return (
    d.tier1.length > 0 ||
    d.tier2.length > 0 ||
    d.tier3.length > 0 ||
    d.tier4.length > 0
  );
}

async function maybeEmitDailyDigest(ctx: AgentContext, digest: Digest): Promise<void> {
  if (ctx.trigger !== "cron") return;
  if (!digestHasSignal(digest)) {
    console.log(
      `[chief-of-staff dispatcher] daily-digest suppressed (no signal) for tenant ${ctx.tenant_id}`,
    );
    return;
  }
  try {
    const decisionId = await ctx.emitDecision(DAILY_DIGEST_CLASS, {
      rendered_markdown: digest.rendered_markdown,
      tier1: digest.tier1,
      tier2: digest.tier2,
      tier3: digest.tier3,
      tier4: digest.tier4,
    });
    console.log(
      `[chief-of-staff dispatcher] emitted daily-digest decision ${decisionId} (tenant ${ctx.tenant_id})`,
    );
  } catch (e) {
    console.warn(
      `[chief-of-staff dispatcher] daily-digest emit failed (tenant ${ctx.tenant_id}): ${(e as Error).message}`,
    );
  }
}
