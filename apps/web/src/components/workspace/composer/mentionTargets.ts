
import {
  AGENT_MENTIONS,
  CHANNELS,
  RETIRED_CHANNEL_SLUGS,
  connectorHasConnectPath,
  matchAgentMention,
  type Channel,
} from "@zavi/shared";
import { lockedTierOf, type LockTier } from "@/lib/workspace/planUpgrade";
import { customAgentRows, visibleAgentPages } from "../layout/agentPages";

export type MentionTarget =
  | {
      kind: "channel";
      key: string;
      name: string;
      sendSlug: string;
      channel: Channel;
    }
  | {
      kind: "agent";
      key: string;
      name: string;
      sendSlug: string;
      subtitle?: string;
      lockedTier?: Exclude<LockTier, "free"> | null;
      custom?: boolean;
    };

export type MentionSection = {
  id: string;
  heading?: string;
  label?: string;
  rows: MentionTarget[];
};

export type TeamMember = {
  slug: string;
  name: string;
  lockedTier: Exclude<LockTier, "free"> | null;
  custom?: boolean;
};

export function teamFromTree(
  treeAgents: ReadonlyArray<{ slug: string; name?: string; custom?: boolean; locked_tier?: string | null }>,
  supplyDemandEligible: boolean,
): TeamMember[] {
  const pages = visibleAgentPages(treeAgents, supplyDemandEligible);
  const builtIns = AGENT_MENTIONS.flatMap((a) => {
    const page = pages.find((p) => p.slug === a.agent_slug);
    return page ? [{ slug: page.slug, name: page.label, lockedTier: page.lockedTier }] : [];
  });
  const custom = customAgentRows(treeAgents).map((a) => ({
    slug: a.slug,
    name: a.name as string,
    lockedTier: lockedTierOf(a),
    custom: true,
  }));
  return [...builtIns, ...custom];
}

export const CGO_TARGET: MentionTarget = {
  kind: "agent",
  key: "agent:cgo",
  name: "Your CGO",
  sendSlug: "cgo",
  subtitle: "plan, goals, where to spend",
};

export function channelTarget(channel: Channel): MentionTarget {
  return {
    kind: "channel",
    key: `channel:${channel.slug}`,
    name: channel.name,
    sendSlug: channel.executor,
    channel,
  };
}

function teamTarget(member: TeamMember): MentionTarget {
  return {
    kind: "agent",
    key: `agent:${member.slug}`,
    name: member.name,
    sendSlug: member.slug,
    lockedTier: member.lockedTier,
    custom: member.custom,
  };
}

const LIVE_CHANNELS = (): Channel[] =>
  CHANNELS.filter((c) => !RETIRED_CHANNEL_SLUGS.has(c.slug)) as Channel[];

function searchWords(t: MentionTarget): string[] {
  const words = [t.name.toLowerCase(), t.sendSlug.toLowerCase()];
  if (t.kind === "channel") words.push(t.channel.executor.toLowerCase());
  else words.push(...(AGENT_MENTIONS.find((a) => a.agent_slug === t.sendSlug)?.labels ?? []));
  return words;
}

export function matchesMentionQuery(t: MentionTarget, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || searchWords(t).some((w) => w.includes(q));
}

const SEARCH_SLUGS = new Set(["seo", "geo", "blog"]);

export const CHANNEL_GROUPS = [
  { id: "ads", label: "Ads" },
  { id: "search", label: "Search" },
  { id: "social", label: "Social" },
  { id: "creators", label: "Video and creators" },
  { id: "messages", label: "Messages" },
] as const;

export type ChannelGroup = (typeof CHANNEL_GROUPS)[number]["id"];

export function channelGroup(c: Pick<Channel, "slug" | "category" | "section">): ChannelGroup {
  if (c.section === "creators") return "creators";
  if (c.category === "paid") return "ads";
  if (c.category === "owned") return "messages";
  if (SEARCH_SLUGS.has(c.slug)) return "search";
  return "social";
}

export function isChannelConnected(c: Pick<Channel, "connectors">, connected: ReadonlySet<string>): boolean {
  return c.connectors.some((slug) => connected.has(slug));
}

export function connectSlugFor(c: Pick<Channel, "connectors">): string | null {
  return c.connectors.find((slug) => connectorHasConnectPath(slug)) ?? null;
}

export function channelOnlySections(query: string): MentionSection[] {
  const rows = LIVE_CHANNELS().map(channelTarget).filter((t) => matchesMentionQuery(t, query));
  return rows.length ? [{ id: "channels", heading: "Channels", rows }] : [];
}

export function homeMentionSections({
  query,
  connected,
  team,
  recent,
}: {
  query: string;
  connected: ReadonlySet<string> | null;
  team: readonly TeamMember[];
  recent: readonly string[];
}): MentionSection[] {
  const channels = LIVE_CHANNELS();
  const teamRows = [...team]
    .sort((a, b) => Number(!!a.lockedTier) - Number(!!b.lockedTier))
    .map(teamTarget);
  const roster = new Map<string, MentionTarget>();
  for (const t of [...teamRows, ...channels.map(channelTarget)]) roster.set(t.key, t);

  const recentRows = recent
    .filter((k, i) => recent.indexOf(k) === i && k !== CGO_TARGET.key)
    .map((k) => roster.get(k))
    .filter((t): t is MentionTarget => !!t)
    .slice(0, 3);
  const taken = new Set(recentRows.map((t) => t.key));
  const keep = (t: MentionTarget) => !taken.has(t.key) && matchesMentionQuery(t, query);

  const sections: MentionSection[] = [];
  const push = (s: MentionSection) => {
    if (s.rows.length) sections.push(s);
  };
  push({ id: "cgo", rows: [CGO_TARGET].filter((t) => matchesMentionQuery(t, query)) });
  push({ id: "recent", heading: "Recent", rows: recentRows.filter((t) => matchesMentionQuery(t, query)) });
  const on = connected ? channels.filter((c) => isChannelConnected(c, connected)) : [];
  push({ id: "connected", heading: "Connected", rows: on.map(channelTarget).filter(keep) });
  push({ id: "team", heading: "Your team", rows: teamRows.filter(keep) });
  const off = channels.filter((c) => !on.includes(c));
  let first = true;
  for (const g of CHANNEL_GROUPS) {
    const rows = off.filter((c) => channelGroup(c) === g.id).map(channelTarget).filter(keep);
    if (!rows.length) continue;
    sections.push({
      id: `off-${g.id}`,
      heading: first ? "Not connected yet" : undefined,
      label: g.label,
      rows,
    });
    first = false;
  }
  return sections;
}

export function flattenSections(sections: readonly MentionSection[]): MentionTarget[] {
  return sections.flatMap((s) => s.rows);
}

const RECENT_KEEP = 6;

export function recentStorageKey(userId: string | null | undefined, tenantId: string | null | undefined): string | null {
  return userId && tenantId ? `zavi:mention-recent:${userId}:${tenantId}` : null;
}

export function readRecentMentions(storageKey: string | null): string[] {
  if (!storageKey) return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string").slice(0, RECENT_KEEP) : [];
  } catch {
    return [];
  }
}

export function rememberRecentMention(storageKey: string | null, key: string): void {
  if (!storageKey) return;
  try {
    const next = [key, ...readRecentMentions(storageKey).filter((k) => k !== key)].slice(0, RECENT_KEEP);
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
  }
}

const CUSTOM_MENTION_RE = /^\s*@\s*(c-[a-z0-9]{8,12})(?=$|[\s:,.!?])/;

export function matchHomeAgentMention(
  raw: string,
  customAgents: ReadonlyArray<{ slug: string; name: string }>,
): { agent_slug: string; name: string; rest: string } | null {
  const builtIn = matchAgentMention(raw);
  if (builtIn) return builtIn;
  const m = CUSTOM_MENTION_RE.exec(raw);
  if (!m) return null;
  const hit = customAgents.find((a) => a.slug === m[1]);
  return hit
    ? { agent_slug: hit.slug, name: hit.name, rest: raw.slice(m[0].length).replace(/^[\s:,]+/, "").trim() }
    : null;
}
