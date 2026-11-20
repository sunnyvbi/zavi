import type { AuthedRequest } from "@/services/auth/middleware";
import { loadTenantRole } from "@/services/auth/tenant-role";
import { setCompanyFact } from "@/services/company/facts";
import { logEvent } from "@/services/logging/logEvent";
import { sanitizeFetchedContent } from "@/services/onboarding/enrichment/sanitize";
import { findSecretLikeTokens } from "@/services/site-functions/contract";

export type OwnerChatFactKey = "prices" | "service_area" | "hours";
export type OwnerChatFacts = Partial<Record<OwnerChatFactKey, string>>;

const FACT_MAX_CHARS = 500;
const FACT_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

const MONEY = /[$€£₹]\s?\d|\b\d+(?:\.\d+)?\s?(?:dollars|usd|per hour|an hour|\/hr)\b/i;
const NOT_OUR_PRICE =
  /\b(competitors?|rivals?|they(?:'re| are)?|them|their|other (?:guys?|shops?|businesses|companies|places|cleaners)|others?|next door|down the street|nearby|average|market|budget|ad spend|spend|revenue|mrr|arr|funding|raised|salary|costs? me|paid)\b/i;
const NOT_OURS = /\b(competitors?|rivals?|they(?:'re| are)?|their|other (?:guys?|shops?|businesses|companies|places|cleaners)|next door|down the street)\b/i;
const TIME = "\\d{1,2}(?::\\d{2})?\\s?(?:am|pm)?";
const TIME_RANGE = new RegExp(`\\b${TIME}\\s?(?:-|–|to|until|till)\\s?${TIME}\\b`, "i");
const CLOCK = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i;
const DAY = /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?s?\b|\bweekdays?\b|\bweekends?\b|\bdaily\b/i;
const HOURS_WORD = /\b(?:open|opens|hours|closed|close|closes)\b/i;
const AREA_WORD = /\bservice areas?\b|\bareas? (?:we|i) (?:serve|cover|work in)\b/i;
const AREA_VERB = /\b(?:[Ww]e|I)(?:'re| are| am)? (?:serve|serving|cover|covering|service|work in|operate in)\s+(?:all of |the )?[A-Z][a-z]+/;
const QUESTION = /\?\s*$|^\s*(?:what|how|why|when|where|who|which|should|could|can|do|does|is|are)\b/i;

function clauses(message: string): string[] {
  return message
    .split(/(?<=[.!?])\s+|[\n;]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !QUESTION.test(c));
}

function joined(parts: string[]): string | undefined {
  const out: string[] = [];
  let size = 0;
  for (const part of [...new Set(parts)]) {
    const next = size + part.length + (out.length ? 2 : 0);
    if (next > FACT_MAX_CHARS) break;
    out.push(part);
    size = next;
  }
  return out.length ? out.join("; ") : undefined;
}

export function extractOwnerChatFacts(message: string): OwnerChatFacts {
  const all = clauses(sanitizeFetchedContent(message));
  const hours = all.filter(
    (c) =>
      !NOT_OURS.test(c) &&
      ((TIME_RANGE.test(c) && (DAY.test(c) || HOURS_WORD.test(c) || CLOCK.test(c))) || (HOURS_WORD.test(c) && DAY.test(c))),
  );
  const prices = all.filter((c) => MONEY.test(c) && !NOT_OUR_PRICE.test(c));
  const areas = all.filter((c) => !NOT_OURS.test(c) && (AREA_WORD.test(c) || AREA_VERB.test(c)));
  const found: OwnerChatFacts = {};
  const p = joined(prices);
  const a = joined(areas);
  const h = joined(hours);
  if (p) found.prices = p;
  if (a) found.service_area = a;
  if (h) found.hours = h;
  return found;
}

export type OwnerChatFactDeps = {
  role: (auth: AuthedRequest) => Promise<string | null>;
  save: (tenant_id: string, key: OwnerChatFactKey, value: string, source_ref: string) => Promise<{ ok: boolean; error: string | null }>;
};

const realDeps: OwnerChatFactDeps = { role: loadTenantRole, save: setCompanyFact };

export async function saveOwnerChatFacts(
  auth: AuthedRequest,
  message: string,
  deps: OwnerChatFactDeps = realDeps,
): Promise<OwnerChatFactKey[]> {
  const saved: OwnerChatFactKey[] = [];
  if (findSecretLikeTokens(message).length > 0) return saved;
  try {
    const facts = Object.entries(extractOwnerChatFacts(message)) as Array<[OwnerChatFactKey, string]>;
    if (facts.length === 0) return saved;
    const role = await deps.role(auth);
    if (!role || !FACT_ROLES.has(role)) return saved;
    for (const [key, value] of facts) {
      const r = await deps.save(auth.tenant_id, key, value, `said in website chat by user ${auth.user_id}`);
      if (r.ok) saved.push(key);
      else throw new Error(r.error ?? "fact not saved");
    }
  } catch (e) {
    await logEvent({ level: "warn", source: "website.chat", code: "owner_chat_fact_failed", tenant_id: auth.tenant_id, error: e }).catch(() => undefined);
  }
  return saved;
}
