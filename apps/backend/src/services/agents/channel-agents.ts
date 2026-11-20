
import { CHANNELS, type Channel } from "@zavi/shared";

export type ChannelAgent = {
  agent_slug: string;
  channel_slug: string;
  name: string;
  category: Channel["category"];
  description: string;
};

const BY_AGENT: ReadonlyMap<string, ChannelAgent> = new Map(
  CHANNELS.map((c) => [
    c.executor,
    {
      agent_slug: c.executor,
      channel_slug: c.slug,
      name: c.name,
      category: c.category,
      description: c.description,
    },
  ]),
);

export function channelAgentSlugs(): ReadonlySet<string> {
  return new Set(BY_AGENT.keys());
}

export function isChannelAgent(slug: string): boolean {
  return BY_AGENT.has(slug);
}

export function channelForAgent(slug: string): ChannelAgent | null {
  return BY_AGENT.get(slug) ?? null;
}

export function listChannelAgents(): readonly ChannelAgent[] {
  return Array.from(BY_AGENT.values());
}

export function renderChannelRosterForPrompt(): string {
  const byCategory = new Map<string, ChannelAgent[]>();
  for (const a of listChannelAgents()) {
    const list = byCategory.get(a.category) ?? [];
    list.push(a);
    byCategory.set(a.category, list);
  }
  const lines: string[] = [];
  for (const [category, agents] of byCategory) {
    lines.push(`${category}:`);
    for (const a of agents) {
      lines.push(`  - \`${a.agent_slug}\` — ${a.name}. ${a.description}`);
    }
  }
  return lines.join("\n");
}
