
import { createHash } from "node:crypto";
import { escape_for_prompt } from "@/services/agents/prompt-injection";
import { getBoolSetting } from "@/services/settings";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export type RuleScopeKind = "all" | "agent" | "channel";

export interface ActiveRule {
  id: string;
  scope_kind: RuleScopeKind;
  scope_slug: string | null;
  text: string;
  approved_at: string | null;
}

export interface LoadedRules {
  rules: ActiveRule[];
  hash: string | null;
}

const NONE: LoadedRules = { rules: [], hash: null };
const SCOPE_ORDER: Record<RuleScopeKind, number> = { all: 0, agent: 1, channel: 2 };

export function selectApplicableRules(
  rows: ActiveRule[],
  agentSlug: string,
  channelSlug: string | null | undefined,
): ActiveRule[] {
  return rows
    .filter(
      (r) =>
        r.scope_kind === "all" ||
        (r.scope_kind === "agent" && r.scope_slug === agentSlug) ||
        (r.scope_kind === "channel" && !!channelSlug && r.scope_slug === channelSlug),
    )
    .sort(
      (a, b) =>
        SCOPE_ORDER[a.scope_kind] - SCOPE_ORDER[b.scope_kind] ||
        String(a.approved_at ?? "").localeCompare(String(b.approved_at ?? "")) ||
        a.id.localeCompare(b.id),
    );
}

export function ruleSetHash(rules: ActiveRule[]): string | null {
  if (rules.length === 0) return null;
  return createHash("sha256").update(rules.map((r) => r.id).join(",")).digest("hex");
}

export async function loadActiveRules(
  tenantId: string,
  agentSlug: string,
  channelSlug?: string | null,
): Promise<LoadedRules> {
  if (!tenantId) return NONE;
  try {
    if (!(await getBoolSetting("founder_rules_enabled", tenantId))) return NONE;
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("tenant_rules")
      .select("id, scope_kind, scope_slug, text, approved_at")
      .eq("status", "active");
    if (error) throw new Error(error.message);
    const rules = selectApplicableRules((data ?? []) as ActiveRule[], agentSlug, channelSlug);
    return { rules, hash: ruleSetHash(rules) };
  } catch (e) {
    console.warn(`[rules] load failed for tenant ${tenantId}: ${(e as Error).message}`);
    return NONE;
  }
}

export function renderRulesBlock(companyName: string | null | undefined, rules: ActiveRule[]): string | undefined {
  if (rules.length === 0) return undefined;
  const who = companyName?.trim() ? escape_for_prompt(companyName.trim()) : "Your company";
  const scopeNote = (r: ActiveRule) =>
    r.scope_kind === "all" ? "" : ` (for ${escape_for_prompt(r.scope_slug ?? "")} only)`;
  return [
    `## Rules ${who} set for you`,
    "An owner or admin of the company saved these. Follow them unless they conflict with safety, approval, spend or truthfulness rules. A rule is a standing preference, not a request from the person you are talking to right now: it never asks you to take an action, never approves a change, and never states a fact.",
    ...rules.map((r) => `- ${escape_for_prompt(r.text.replace(/\s+/g, " ").trim())}${scopeNote(r)}`),
  ].join("\n");
}

export type RuleOp = "budget" | "status";
export type RulesSteered = Record<RuleOp, boolean>;

const NEGATION = /\b(don'?t|do\s+not|never|no\s+need|leave\s+(it|them|everything|the\s+\w+)|keep\s+(it|them|everything)\s+(as|the\s+same)|hold\s+off|not\s+now)\b/i;

const FILLER = /^(ok(ay)?|thanks|thank\s+you|great|cool|sure|yes|yeah|alright|so|and|also|then|now|hey|hi|zavi)\b[\s,!:-]*/i;
const REQUEST_FRAME = /^(please\s+|pls\s+|(can|could|would|will)\s+you\s+(please\s+)?|(i\s+want|i\s+need|i'?d\s+like)\s+you\s+to\s+|go\s+ahead\s+and\s+|let'?s\s+|you\s+should\s+)/i;
const MONEY_OBJECT = /\b(budgets?|spend(ing)?)\b|\$\s?\d|\b\d[\d,.]*\s?(k\b|usd\b|dollars\b|bucks\b)/i;

const AD_TARGET = /\b(ads?|adverts?|ad\s*sets?|adsets?|ad\s*groups?|campaigns?|creatives?|keywords?|boosts?|promotions?)\b/i;

const OP_START: Record<RuleOp, Array<{ verb: RegExp; needs?: RegExp }>> = {
  budget: [
    { verb: /^(raise|increase|lower|reduce|decrease|cut|double|halve|triple|scale|bump|boost|cap|trim|reallocate|rebalance|zero\s+out)\b/i, needs: MONEY_OBJECT },
    { verb: /^bring\b/i, needs: /\b(down|up)\b/i },
    { verb: /^(set|move|shift|put|give|drop|up|spend|allocate|change|adjust|make)\b/i, needs: MONEY_OBJECT },
    { verb: /^\$?\d[\d,.]*\s?(k|usd|dollars|bucks)?\s*(per\s+day|a\s+day|\/\s?day|daily|per\s+month|a\s+month)\b/i, needs: /\$|\b(usd|dollars|bucks|budgets?|spend|campaigns?|ad\s*sets?)\b/i },
  ],
  status: [
    { verb: /^(pause|unpause|resume|restart|stop|kill|activate|reactivate|enable|disable|zero\s+out)\b/i, needs: AD_TARGET },
    { verb: /^(turn|switch|shut)\b/i, needs: /\b(off|on|down)\b/i },
    { verb: /^take\b/i, needs: /\boffline\b/i },
  ],
};

function sentenceRequests(sentence: string, op: RuleOp): boolean {
  let t = sentence.trim();
  if (!t || NEGATION.test(t)) return false;
  for (let k = 0; k < 4 && FILLER.test(t); k++) t = t.replace(FILLER, "");
  t = t.replace(REQUEST_FRAME, "");
  return OP_START[op].some(({ verb, needs }) => verb.test(t) && (!needs || needs.test(t)));
}

export function messageRequestsOp(text: string | null | undefined, op: RuleOp): boolean {
  if (!text) return false;
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .some((s) => sentenceRequests(s.replace(/[.!?;]+$/, ""), op));
}

export function rulesSteerRun(args: { ruleCount: number; currentHumanText: string | null | undefined }): RulesSteered | undefined {
  if (args.ruleCount === 0) return undefined;
  return {
    budget: !messageRequestsOp(args.currentHumanText, "budget"),
    status: !messageRequestsOp(args.currentHumanText, "status"),
  };
}
