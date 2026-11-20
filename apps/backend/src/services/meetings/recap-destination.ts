
import { ExpectedToolError } from "@/services/tools/types";

export const RECAP_DESTINATIONS = ["slack", "email", "off"] as const;
export type RecapDestination = (typeof RECAP_DESTINATIONS)[number];

export const MEETING_NOTES_RETENTION_DAYS = 30;

export function asRecapDestination(v: unknown): RecapDestination | null {
  return typeof v === "string" && (RECAP_DESTINATIONS as readonly string[]).includes(v) ? (v as RecapDestination) : null;
}

export type RecapPlan = {
  email: boolean;
  channel: { id: string; name: string | null } | null;
  thread: boolean;
  askOwner: boolean;
};

export function planRecapDelivery(args: {
  destination: unknown;
  slackChannelId: string | null | undefined;
  slackChannelName?: string | null;
  summonedFromThread: boolean;
}): RecapPlan {
  const destination = asRecapDestination(args.destination);
  if (destination === null) return { email: false, channel: null, thread: false, askOwner: true };
  if (destination === "off") return { email: false, channel: null, thread: false, askOwner: false };
  const channelId = (args.slackChannelId ?? "").trim();
  return {
    email: destination === "email",
    channel: destination === "slack" && channelId ? { id: channelId, name: args.slackChannelName ?? null } : null,
    thread: args.summonedFromThread,
    askOwner: false,
  };
}

export function normalizeChannelName(raw: string): string {
  return raw.trim().replace(/^#+/, "").trim().toLowerCase();
}

export function validChannelName(name: string): boolean {
  return name.length > 0 && name.length <= 80 && !/[\s#.,]/.test(name);
}

type ListedChannel = { id?: string; name?: string; is_private?: boolean; is_archived?: boolean; is_member?: boolean };
type ListResp = { channels?: ListedChannel[]; response_metadata?: { next_cursor?: string } };
export type SlackCall = <T>(method: string, body: Record<string, string | number | boolean | undefined>) => Promise<T>;

const PAGE_SIZE = 200;
const MAX_PAGES = 25;

export type ChannelLookup =
  | { ok: true; id: string; name: string; joined: boolean }
  | { ok: false; code: "slack_not_connected" | "bad_channel_name" | "channel_not_found" | "cannot_join" | "slack_error"; message: string };

export const channelNotFoundMessage = (name: string) =>
  `Couldn't find #${name} in your Slack. Check the spelling. If it's a private channel, invite @Zavi to #${name} first, then try again.`;
export const cannotJoinMessage = (name: string) => `Zavi couldn't join #${name}. Invite @Zavi to #${name}, then try again.`;

export async function findPostableChannel(rawName: string, call: SlackCall): Promise<ChannelLookup> {
  const name = normalizeChannelName(rawName);
  if (!validChannelName(name)) {
    return { ok: false, code: "bad_channel_name", message: "Type a Slack channel name, like #standups." };
  }
  let found: ListedChannel | null = null;
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES && !found; page++) {
      const resp = await call<ListResp>("conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: PAGE_SIZE,
        cursor,
      });
      found = (resp.channels ?? []).find((c) => !c.is_archived && (c.name ?? "").toLowerCase() === name && c.id) ?? null;
      cursor = resp.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "slack_not_connected") {
      return { ok: false, code: "slack_not_connected", message: "Connect Slack in Integrations first, then choose a channel." };
    }
    return { ok: false, code: "slack_error", message: "Couldn't reach Slack. Try again in a minute." };
  }
  if (!found || !found.id) return { ok: false, code: "channel_not_found", message: channelNotFoundMessage(name) };
  if (found.is_member) return { ok: true, id: found.id, name, joined: false };
  if (found.is_private) return { ok: false, code: "cannot_join", message: cannotJoinMessage(name) };
  try {
    await call("conversations.join", { channel: found.id });
  } catch {
    return { ok: false, code: "cannot_join", message: cannotJoinMessage(name) };
  }
  return { ok: true, id: found.id, name, joined: true };
}
