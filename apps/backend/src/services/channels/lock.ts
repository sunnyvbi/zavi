
import { isChannelSlug } from "@zavi/shared";
import { ExpectedToolError } from "@/services/tools/types";
import { globalClient } from "@/services/tenant-client";
import { channelForAgent } from "@/services/agents/channel-agents";

export function lockedSlugsFromBlob(blob: Record<string, unknown> | null | undefined): string[] {
  const raw = blob?.locked_channel_slugs;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((s): s is string => typeof s === "string" && isChannelSlug(s)))];
}

export async function readLockedChannelSlugs(): Promise<Set<string>> {
  try {
    const { data, error } = await globalClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) {
      console.warn(`[channels/lock] config read failed, treating nothing as locked: ${error.message}`);
      return new Set();
    }
    return new Set(lockedSlugsFromBlob(data?.blob));
  } catch (e) {
    console.warn(
      `[channels/lock] config read threw, treating nothing as locked: ${(e as Error).message}`,
    );
    return new Set();
  }
}

export async function isChannelLocked(slug: string): Promise<boolean> {
  return (await readLockedChannelSlugs()).has(slug);
}

export const CHANNEL_LOCK_UNREADABLE_MESSAGE = "Zavi could not check whether this channel is available. Try again in a minute.";

export async function isChannelLockedStrict(slug: string): Promise<boolean> {
  let data: { blob: Record<string, unknown> } | null = null;
  try {
    const read = await globalClient()
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (!read.error) data = read.data;
  } catch {
    data = null;
  }
  if (!data) throw new Error(CHANNEL_LOCK_UNREADABLE_MESSAGE);
  return lockedSlugsFromBlob(data.blob).includes(slug);
}

export async function lockedChannelMessageForAgent(agent_slug: string): Promise<string | null> {
  const channel = channelForAgent(agent_slug);
  if (!channel) return null;
  return (await isChannelLocked(channel.channel_slug)) ? comingSoonMessage(channel.name) : null;
}

export function comingSoonMessage(name: string): string {
  return `${name} is coming soon.`;
}

export async function assertSpendWritesOn(slug: string, label: string, codePrefix: string): Promise<void> {
  let locked: boolean;
  try {
    locked = await isChannelLockedStrict(slug);
  } catch {
    throw new ExpectedToolError(`${codePrefix}_write_disabled`, `Zavi could not confirm ${label} changes are switched on, so nothing was changed. Approve again in a minute.`);
  }
  if (locked) throw new ExpectedToolError(`${codePrefix}_write_disabled`, `${label} changes are switched off in Zavi right now, so nothing was changed.`);
}
