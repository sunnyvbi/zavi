
import { logEvent } from "@/services/logging/logEvent";

const OPERATOR_SLUG = "operator";

export const TRUST_SHAPED_ASK_PATTERNS: readonly RegExp[] = [
  /\b(what|which|who)\b[^?\n]{0,30}\b(model|provider|ai|llm)\b/i,
  /\b(what|which|who)\b[^?\n]{0,20}\b(powers?|runs?|backs?|drives?|is\s+behind|underpins?)\b[^?\n]{0,10}\byou\b/i,
  /\b(anthropic|openai|claude|gpt|chatgpt|llama|gemini|grok)\b(?!\s+ads?\b)/i,
  /\b(soc ?2|hipaa|gdpr|ccpa|dpa|subprocessor|compliance|certified|certification)\b/i,
  /\b(staff|engineer|employee|admin)s?\b[^?\n]{0,30}\b(see|access|read|view|debug)\b[^?\n]{0,30}\b(my|our|the|user|customer)\b[^?\n]{0,30}\b(data|messages|chats|conversations)\b/i,
  /\b(retention|data\s+deletion|wipe|purge|delete\s+my\s+data)\b/i,
  /how\s+(long|much)\s+[^?\n]{0,20}\b(keep|retain|store)\b[^?\n]{0,20}\b(my|our|user|customer|data|messages)\b/i,
];

type LeakCategory = "model_provider" | "soc2" | "staff_access" | "retention";

interface LeakPattern {
  pattern: RegExp;
  category: LeakCategory;
}

const LEAK_PATTERNS: readonly LeakPattern[] = [
  { pattern: /\b(anthropic|claude(?:\s+\d|\s+sonnet|\s+opus|\s+haiku)?)\b/i, category: "model_provider" },
  { pattern: /\b(openai|gpt-?\d|chatgpt|gpt|llama|llama-?\d|gemini|grok)\b(?!\s+ads?\b)/i, category: "model_provider" },
  { pattern: /(we are|we're|yes,? we are|no,? we are not|not yet) (soc ?2|hipaa|gdpr|ccpa)( certified| compliant)?/i, category: "soc2" },
  { pattern: /(soc ?2|hipaa) (type ?(i|ii|1|2)|certified|compliant)/i, category: "soc2" },
  { pattern: /(staff|engineers?|employees?|admins?) (can|cannot|do not|don't|may|will) (see|access|read|view|debug)/i, category: "staff_access" },
  { pattern: /(retain|store|keep) (your|user|customer)? ?(data|messages|chats|conversations) (for|up to) \d+ (days?|months?|years?)/i, category: "retention" },
];

const REPLACEMENT_TEMPLATES: Record<LeakCategory, string> = {
  model_provider:
    "Our model stack is covered under our security disclosures, not chat. If you're evaluating for a deal, I'll route you to our security team. They share the architecture brief under DPA.",
  soc2:
    "Compliance posture (SOC 2, subprocessor list, retention windows) is in our trust-center / DPA, not chat. Want me to route you to security?",
  staff_access:
    "Staff data-access policy lives in our DPA, not chat. Security team owns the written answer. Want me to flag your account so they reach out?",
  retention:
    "Compliance posture (SOC 2, subprocessor list, retention windows) is in our trust-center / DPA, not chat. Want me to route you to security?",
};

export function isTrustShapedAsk(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  for (const p of TRUST_SHAPED_ASK_PATTERNS) {
    if (p.test(text)) return true;
  }
  return false;
}

export interface TrustLeakResult {
  leaked: boolean;
  category?: LeakCategory;
}

export function containsTrustLeak(text: string): TrustLeakResult {
  if (!text || typeof text !== "string") return { leaked: false };
  for (const entry of LEAK_PATTERNS) {
    if (entry.pattern.test(text)) {
      return { leaked: true, category: entry.category };
    }
  }
  return { leaked: false };
}

export interface TrustGuardInput {
  agent_slug: string;
  user_message: string;
  agent_text: string;
}

export interface TrustGuardOutput {
  text: string;
  fired: boolean;
  category?: LeakCategory;
}

export function applyTrustGuardSync(input: TrustGuardInput): TrustGuardOutput {
  if (input.agent_slug !== OPERATOR_SLUG) {
    return { text: input.agent_text, fired: false };
  }
  if (!isTrustShapedAsk(input.user_message)) {
    return { text: input.agent_text, fired: false };
  }
  const leak = containsTrustLeak(input.agent_text);
  if (!leak.leaked || !leak.category) {
    return { text: input.agent_text, fired: false };
  }
  return {
    text: REPLACEMENT_TEMPLATES[leak.category],
    fired: true,
    category: leak.category,
  };
}

export function extractUserMessageFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  if (typeof p.current_user_text_raw === "string" && p.current_user_text_raw.trim()) {
    return p.current_user_text_raw;
  }
  if (typeof p.user_message === "string") return p.user_message;
  if (p.slack && typeof p.slack === "object") {
    const s = p.slack as Record<string, unknown>;
    if (typeof s.text === "string") return s.text;
  }
  if (p.email && typeof p.email === "object") {
    const e = p.email as Record<string, unknown>;
    if (typeof e.body === "string") return e.body;
    if (typeof e.snippet === "string") return e.snippet;
    if (typeof e.subject === "string") return e.subject;
  }
  if (p.teams && typeof p.teams === "object") {
    const t = p.teams as Record<string, unknown>;
    if (typeof t.text === "string") return t.text;
  }
  if (typeof p.task_description === "string") return p.task_description;
  if (typeof p.intent === "string") return p.intent;
  if (typeof p.text === "string") return p.text;
  if (typeof p.prompt === "string") return p.prompt;
  return "";
}

export async function applyTrustGuard(input: {
  tenant_id: string;
  run_id: string;
  agent_slug: string;
  user_message: string;
  agent_text: string;
}): Promise<TrustGuardOutput> {
  const result = applyTrustGuardSync({
    agent_slug: input.agent_slug,
    user_message: input.user_message,
    agent_text: input.agent_text,
  });
  if (result.fired) {
    void logEvent({
      level: "warn",
      source: "agents.post_text_trust_guard",
      code: "low_conf_trust_seatbelt_fired",
      message: `trust seatbelt replaced ${result.category} leak in operator output`,
      tenant_id: input.tenant_id,
      meta: {
        run_id: input.run_id,
        category: result.category,
      },
    });
  }
  return result;
}
