import type { RedditPayload } from "./shared";
import type { RedditInsights } from "./types";
import { normSub } from "./ui";

export type Opportunity = RedditInsights["opportunities"][number];

export function redditPostId(url: string | null | undefined): string | null {
  const m = /\/comments\/([a-z0-9]+)/i.exec(url ?? "");
  return m ? m[1].toLowerCase() : null;
}

export function pageOneRank(o: Opportunity): number | null {
  const r = o.google.rank;
  return r !== null && r <= 10 ? r : null;
}

export function strategyDefaultSubs(data: RedditPayload): string[] | null {
  const saved = (data.workspace?.communities ?? []).filter((c) => normSub(c.name));
  const selected = saved.filter((c) => c.selected).map((c) => normSub(c.name));
  const deselectedSome = selected.length < saved.length;
  return selected.length > 0 && deselectedSome ? [...new Set(selected)] : null;
}

export function strategyVisibleOpportunities(data: RedditPayload, selectedSubs: string[] | null): Opportunity[] {
  const insights = data.insights && data.insights.has_data ? data.insights : null;
  const opportunities = insights?.opportunities ?? [];
  const effective = selectedSubs ?? strategyDefaultSubs(data);
  if (effective === null) return opportunities;
  const set = new Set(effective.map(normSub));
  return opportunities.filter((o) => set.has(normSub(o.subreddit)));
}

