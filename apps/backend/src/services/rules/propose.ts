
import { getBoolSetting } from "@/services/settings";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { detectRule } from "./detect";
import type { RuleScopeKind } from "./load";

export type RuleSourceKind = "chat_message" | "slack_run" | "email_message" | "channel_reject";

export interface ProposedRule {
  rule_id: string;
  text: string;
  scope_kind: RuleScopeKind;
  scope_slug: string | null;
  origin: string;
}

export function toCodePointOffset(s: string, utf16Offset: number): number {
  return Array.from(s.slice(0, utf16Offset)).length;
}

export async function proposeRule(args: {
  tenantId: string;
  sourceKind: RuleSourceKind;
  sourceId: string;
  sourceText: string;
  detectText?: string;
  ownRange?: [number, number];
  agentSlug?: string | null;
  runId?: string;
}): Promise<ProposedRule | null> {
  try {
    if (!(await getBoolSetting("founder_rules_enabled", args.tenantId))) return null;
    const detected = await detectRule(args.detectText ?? args.sourceText, {
      tenantId: args.tenantId,
      runId: args.runId,
    });
    if (!detected) return null;
    const [from, to] = args.ownRange ?? [0, args.sourceText.length];
    const at = args.sourceText.indexOf(detected.quote, from);
    if (at < 0 || at + detected.quote.length > to) return null;

    const scope_kind: RuleScopeKind = detected.appliesTo === "this_agent" && args.agentSlug ? "agent" : "all";
    const scope_slug = scope_kind === "agent" ? (args.agentSlug ?? null) : null;
    const { data, error } = await tenantRpc(asTenantId(args.tenantId), "rule_propose", {
      p_source_kind: args.sourceKind,
      p_source_id: args.sourceId,
      p_start: toCodePointOffset(args.sourceText, at),
      p_end: toCodePointOffset(args.sourceText, at + detected.quote.length),
      p_scope_kind: scope_kind,
      p_scope_slug: scope_slug,
    });
    if (error) throw new Error(error.message);
    const r = data as { status: string; rule_id?: string; text?: string; origin?: string };
    if (r.status !== "suggested" || !r.rule_id || !r.text) return null;
    return { rule_id: r.rule_id, text: r.text, scope_kind, scope_slug, origin: r.origin ?? "" };
  } catch (e) {
    console.warn(`[rules] propose from ${args.sourceKind} ${args.sourceId} failed: ${(e as Error).message}`);
    return null;
  }
}
