import { channelForAgent } from "./channel-agents";
import { CHANNELS, getChannel } from "@zavi/shared";

export function paidChannelForAgent(agentSlug: string | null | undefined) {
  const channel = agentSlug ? channelForAgent(agentSlug) : null;
  return channel?.category === "paid" ? channel : null;
}

export function isOutsidePaidChannel(agentSlug: string | null | undefined, serverId: string): boolean {
  const own = paidChannelForAgent(agentSlug);
  if (!own || !serverId.endsWith("_ads") || serverId === own.channel_slug) return false;
  return !getChannel(own.channel_slug)?.tools.some((tool) => tool.startsWith(`${serverId}_`));
}

export function isOutsidePaidChannelTool(
  agentSlug: string | null | undefined,
  serverId: string,
  toolName: string,
): boolean {
  const own = paidChannelForAgent(agentSlug);
  if (!own) return false;
  if (serverId === "composio") {
    const upper = toolName.toUpperCase();
    const named = CHANNELS.find((c) => c.category === "paid" && upper.startsWith(`${c.slug.toUpperCase()}_`));
    return !!named && isOutsidePaidChannel(agentSlug, named.slug);
  }
  if (isOutsidePaidChannel(agentSlug, serverId)) return true;
  const declared = getChannel(own.channel_slug)?.tools ?? [];
  if (serverId.endsWith("_ads") && serverId !== own.channel_slug) {
    return !declared.includes(`${serverId}_${toolName}`);
  }
  return serverId === "growth" && toolName === "read_ads_perf" && !declared.includes("growth_read_ads_perf");
}

export function ownActionClassScopes(agentSlug: string | null | undefined, scopes: readonly string[]): string[] {
  const own = paidChannelForAgent(agentSlug);
  if (!own) return [...scopes];
  const kept = scopes.filter((s) => !isOutsidePaidChannel(agentSlug, s.replace(/\.%$/, "")));
  return [...new Set([`${own.channel_slug}.%`, ...kept])];
}

export function paidChannelScopePrompt(agentSlug: string, trigger?: string): string {
  const channel = paidChannelForAgent(agentSlug);
  if (!channel) return "";
  return [
    `## Current channel: ${channel.name} (${channel.channel_slug})`,
    `You are the ${channel.name} specialist. A generic request for ad options means options on ${channel.name}. Keep recommendations, campaign reads and proposals within this channel.`,
    "Company memory and Growth strategy are background evidence, not permission to expand the request. Other platforms' drafts, performance and standing test plans must not become recommendations or required tests here. Never describe recalled performance as a live read.",
    "If the user explicitly wants a cross-channel plan, explain that the operator should route the other channels to their specialists; complete this channel's part.",
    trigger === "channel_recipe"
      ? "This run is the full channel check: work every router step and hand over the recipe's artifact. Earlier runs, chat answers included, are history to follow up on, not the current request."
      : "Use the channel playbook only for steps relevant to the current request. An options request needs options, not automatic campaign creation, activation or a full scheduled audit. Follow the conversation's reply format.",
  ].join("\n");
}
