import { isDeepStrictEqual } from "node:util";
import { parseStrategy, type ParsedStrategy } from "./strategy";
import type { PlanCritique } from "./plan-review";

export type RevisionMode = "full" | "targeted";
const PATCH_FIELDS = new Set([
  "summary", "also_fix", "target_rationale", "goal", "first_steps",
  "channel_bets", "would_change_plan",
]);

export function canTargetRevision(critique: PlanCritique): boolean {
  return critique.scores.constraint >= 8 && critique.scores.grounding >= 8 &&
    critique.unsupported_facts.length === 0 && critique.issues.length > 0 &&
    critique.issues.every(i => i.bar !== "constraint" && i.bar !== "grounding");
}

export const TARGETED_REVISION_CONTRACT = `You may return ONE <strategy_patch> JSON object containing ONLY changed top-level fields from: summary, also_fix, target_rationale, goal, first_steps, channel_bets, would_change_plan. Include complete values for changed fields (whole arrays/objects, never partial nested objects). Omitted fields are preserved exactly by the server. Preserve the goal's target_metric and the existing channel slugs and order. Never patch north_star, constraint, company_facts, basis_evidence, gaps, unmeasured, growth_moves, brand_voice or channel_fit. Fix related sections together so the whole strategy remains consistent. If any issue needs a change outside that scope, return the COMPLETE <strategy> block instead. The entire resulting strategy will receive an independent review, not only the changed sections.`;

export type RevisionResult = { ok: true; strategy: ParsedStrategy; targeted: boolean } | { ok: false };

export function parseRevision(raw: string, original: ParsedStrategy, mode: RevisionMode): RevisionResult {
  if (!raw.includes("<strategy_patch>")) {
    const parsed = parseStrategy(raw);
    return parsed.ok ? { ok: true, strategy: parsed.strategy, targeted: false } : { ok: false };
  }
  if (mode !== "targeted" || raw.length > 64_000) return { ok: false };
  const match = raw.trim().match(/^<strategy_patch>\s*([\s\S]*?)\s*<\/strategy_patch>$/);
  if (!match) return { ok: false };
  try {
    const patch: unknown = JSON.parse(match[1]);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false };
    const keys = Object.keys(patch);
    if (!keys.length || keys.some(key => !PATCH_FIELDS.has(key))) return { ok: false };
    const merged = { ...original, ...patch };
    const parsed = parseStrategy(`<strategy>${JSON.stringify(merged)}</strategy>`);
    if (!parsed.ok) return { ok: false };
    for (const key of keys as Array<keyof ParsedStrategy>) {
      if (!isDeepStrictEqual(merged[key], parsed.strategy[key])) return { ok: false };
    }
    if (original.goal && (!parsed.strategy.goal || parsed.strategy.goal.target_metric !== original.goal.target_metric)) return { ok: false };
    if (!isDeepStrictEqual(original.channel_bets.map(b => b.channel_slug), parsed.strategy.channel_bets.map(b => b.channel_slug))) return { ok: false };
    if (isDeepStrictEqual(merged, original)) return { ok: false };
    return { ok: true, targeted: true, strategy: {
      ...merged,
      ...(keys.includes("channel_bets") && original.channel_fit ? { channel_fit: parsed.strategy.channel_fit } : {}),
    } };
  } catch { return { ok: false }; }
}
