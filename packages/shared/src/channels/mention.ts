
import { CHANNELS } from "./registry";

export type ChannelMentionMatch = {
  agent_slug: string;
  channel_slug: string;
  name: string;
  rest: string;
};

function labelsFor(c: (typeof CHANNELS)[number]): string[] {
  const out = new Set<string>([
    c.executor.toLowerCase(),
    c.executor.toLowerCase().replace(/_/g, " "),
    c.executor.toLowerCase().replace(/_/g, "-"),
    c.name.toLowerCase(),
  ]);
  return [...out];
}

const LABELS: ReadonlyArray<{ label: string; channel: (typeof CHANNELS)[number] }> =
  CHANNELS.flatMap((c) => labelsFor(c).map((label) => ({ label, channel: c }))).sort(
    (a, b) => b.label.length - a.label.length,
  );

export function matchChannelMention(raw: string): ChannelMentionMatch | null {
  if (!raw) return null;
  const m = /^\s*@\s*/.exec(raw);
  if (!m) return null;
  const after = raw.slice(m[0].length);
  const lower = after.toLowerCase();
  for (const { label, channel } of LABELS) {
    if (!lower.startsWith(label)) continue;
    const next = after.charAt(label.length);
    if (next && !/[\s:,.!?]/.test(next)) continue;
    return {
      agent_slug: channel.executor,
      channel_slug: channel.slug,
      name: channel.name,
      rest: after.slice(label.length).replace(/^[\s:,]+/, "").trim(),
    };
  }
  return null;
}

export function isChannelMention(raw: string): boolean {
  return matchChannelMention(raw) !== null;
}

export type AgentMentionMatch = {
  agent_slug: string;
  name: string;
  rest: string;
};

export const AGENT_MENTIONS: ReadonlyArray<{ agent_slug: string; name: string; labels: string[] }> = [
  { agent_slug: "cgo", name: "Your CGO", labels: ["your cgo", "cgo"] },
  { agent_slug: "engineer", name: "Engineer", labels: ["engineer"] },
  { agent_slug: "fundraising", name: "Fundraising", labels: ["fundraising"] },
  {
    agent_slug: "supply-demand-balancer",
    name: "Supply & Demand",
    labels: ["supply & demand", "supply and demand", "supply-demand-balancer", "supply-demand"],
  },
];

const AGENT_LABELS = AGENT_MENTIONS.flatMap((a) => a.labels.map((label) => ({ label, agent: a }))).sort(
  (a, b) => b.label.length - a.label.length,
);

export function matchAgentMention(raw: string): AgentMentionMatch | null {
  if (!raw) return null;
  const m = /^\s*@\s*/.exec(raw);
  if (!m) return null;
  const after = raw.slice(m[0].length);
  const lower = after.toLowerCase();
  for (const { label, agent } of AGENT_LABELS) {
    if (!lower.startsWith(label)) continue;
    const next = after.charAt(label.length);
    if (next && !/[\s:,.!?]/.test(next)) continue;
    return { agent_slug: agent.agent_slug, name: agent.name, rest: after.slice(label.length).replace(/^[\s:,]+/, "").trim() };
  }
  return null;
}
