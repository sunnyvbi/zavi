
import { CHANNELS } from "@zavi/shared";
import { DRAFTS_WITHOUT_CONNECTOR, readsPublicEvidence } from "@/services/channels/due";

export type ChannelReadiness = {
  channel_slug: string;
  runnable: boolean;
  connect: readonly string[];
  reason: "runnable" | "needs_connector" | "needs_site" | "unknown_channel";
};

export function channelReadiness(
  channel_slug: string,
  linkedConnectors: ReadonlySet<string>,
  hasPublicSite: boolean,
): ChannelReadiness {
  const ch = CHANNELS.find((c) => c.slug === channel_slug);
  if (!ch) {
    return { channel_slug, runnable: false, connect: [], reason: "unknown_channel" };
  }

  if (ch.connectors.some((c) => linkedConnectors.has(c))) {
    return { channel_slug, runnable: true, connect: [], reason: "runnable" };
  }

  const publicCapable = readsPublicEvidence(ch.tools);
  if (publicCapable && hasPublicSite) {
    return { channel_slug, runnable: true, connect: [], reason: "runnable" };
  }

  if (DRAFTS_WITHOUT_CONNECTOR.has(channel_slug) && hasPublicSite) {
    return { channel_slug, runnable: true, connect: [], reason: "runnable" };
  }

  if (DRAFTS_WITHOUT_CONNECTOR.has(channel_slug)) {
    return { channel_slug, runnable: false, connect: [], reason: "needs_site" };
  }

  if (publicCapable) {
    return { channel_slug, runnable: false, connect: [], reason: "needs_site" };
  }

  return {
    channel_slug,
    runnable: false,
    connect: [...ch.connectors],
    reason: "needs_connector",
  };
}
