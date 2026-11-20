import { getChannel } from "@zavi/shared";

export type ChannelFamily = "organic" | "paid";

export function channelFamily(slug: string): ChannelFamily {
  const channel = getChannel(slug);
  return channel?.category === "paid" && channel.section !== "creators" ? "paid" : "organic";
}

export function channelName(slug: string): string {
  return getChannel(slug)?.name ?? "the platform";
}
