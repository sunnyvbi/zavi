
import type { RunEvidence } from "./run-evidence";

const PROMOTION_BANNED = [
  /\bno self[- ]?promo\w*/i,
  /\bno promotion\b/i,
  /\bno advertis\w*/i,
  /\bdo not promote\b/i,
  /\bno solicit\w*/i,
  /\bpromotional content is not allowed\b/i,
  /\bno vendors?\b/i,
  /\bbusinesses may not\b/i,
  /\bself[- ]?promotion is (?:not allowed|banned|prohibited)\b/i,
  /\bno\s+(?:[a-z-]+\s+(?:or|and|&)\s+)?self[- ]?promo\w*(?![^.\n!?;]{0,40}\b(?:fine|ok|okay|allowed|welcome|permitted)\b)/i,
  /\bself[- ]?promo\w*\s+(?:is|are)\s+(?:not\s+(?:allowed|permitted)|banned|prohibited|forbidden)\b/i,
  /\bno promotional (?:posts?|content|links?)\b/i,
];

export type RulesVerdict = "permitted" | "banned" | "unread" | "no_provider";

export type RulesProvider = {
  channels: ReadonlySet<string>;
  target: (input: { presentation?: unknown; content: string }) => string | null;
  resolve: (target: string, evidence: RunEvidence) => RulesVerdict;
  untargetedIsUnread?: ReadonlySet<string>;
};

function redditTarget(input: { presentation?: unknown; content: string }): string | null {
  const p = input.presentation as { subreddit?: unknown } | undefined;
  if (p && typeof p.subreddit === "string" && p.subreddit.trim()) {
    return p.subreddit.trim().replace(/^\/?r\//i, "").toLowerCase();
  }
  const m = /\br\/([A-Za-z0-9_]{2,30})\b/.exec(input.content);
  return m ? m[1].toLowerCase() : null;
}

export const redditRulesProvider: RulesProvider = {
  channels: new Set(["reddit_organic", "reddit_ads"]),
  untargetedIsUnread: new Set(["reddit_organic"]),
  target: redditTarget,
  resolve: (target, evidence) => {
    const rules = evidence.rulesByCommunity.get(target.toLowerCase());
    if (!rules || !rules.complete) return "unread";
    return PROMOTION_BANNED.some((re) => re.test(rules.text)) ? "banned" : "permitted";
  },
};

export const RULES_PROVIDERS: readonly RulesProvider[] = [redditRulesProvider];

export function providerFor(channel: string): RulesProvider | null {
  return RULES_PROVIDERS.find((p) => p.channels.has(channel)) ?? null;
}

export function unverifiableTarget(content: string): string | null {
  return redditTarget({ content });
}

export const MIN_USABLE_CHARS = 120;

export type RulesGateResult = {
  content: string;
  verdict: RulesVerdict;
  target: string | null;
  brandFree?: boolean;
  hold?: "rules_unread_no_brandfree_variant";
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function brandMatcher(name: string): RegExp {
  return new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`, "i");
}

export function mentionsBrand(content: string, companyNames: string[]): boolean {
  return companyNames.some((n) => n.length >= 3 && brandMatcher(n).test(content));
}

export function brandFreeVariant(content: string, companyNames: string[]): string {
  const plug = /\b(we built|we made|we offer|our (?:tool|product|service|app|platform)|try ours|disclosure)\b/i;
  const names = companyNames.filter((n) => n.length >= 3);
  const kept = content
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split(/(?<=[.!?])\s+/)
        .filter((s) => {
          if (plug.test(s)) return false;
          return !names.some((n) => brandMatcher(n).test(s));
        })
        .join(" ")
        .trim(),
    )
    .filter((para) => para.length > 0)
    .join("\n\n");
  return kept.replace(/\n{3,}/g, "\n\n").trim();
}

function communityKey(name: string): string {
  return name.trim().replace(/^\/?r\//i, "").toLowerCase();
}

export function applyCommunityRulesGate(input: {
  channel: string;
  content: string;
  presentation?: unknown;
  context?: string;
  bannedCommunities?: ReadonlySet<string>;
  companyNames: string[];
  evidence: RunEvidence;
}): RulesGateResult {
  const provider = providerFor(input.channel);
  if (!provider) {
    return { content: input.content, verdict: "no_provider", target: null };
  }
  const target =
    provider.target({ presentation: input.presentation, content: input.content }) ??
    (input.context ? provider.target({ content: input.context }) : null);
  if (!target && !provider.untargetedIsUnread?.has(input.channel)) {
    return { content: input.content, verdict: "no_provider", target: null };
  }

  const banned = new Set([...(input.bannedCommunities ?? [])].map(communityKey));
  const verdict: RulesVerdict = !target
    ? "unread"
    : banned.has(communityKey(target))
      ? "banned"
      : provider.resolve(target, input.evidence);
  if (verdict === "permitted") return { content: input.content, verdict, target };
  if (input.companyNames.length === 0) {
    return { content: input.content, verdict, target, hold: "rules_unread_no_brandfree_variant" };
  }
  if (!mentionsBrand(input.content, input.companyNames)) {
    return { content: input.content, verdict, target };
  }
  const stripped = brandFreeVariant(input.content, input.companyNames);
  if (stripped.length < MIN_USABLE_CHARS) {
    return {
      content: input.content,
      verdict,
      target,
      hold: "rules_unread_no_brandfree_variant",
    };
  }
  return { content: stripped, verdict, target, brandFree: true };
}
