
import { getChannel, type DecisionHomeKind } from "@zavi/shared";
import type { TenantClient } from "@/services/tenant-client";
import { OPEN_CHANNEL_ACTIONS_VIEW } from "@/services/channels/open-actions-count";

export const CHAT_CARDS_MAX = 5;
const PENDING_VIEW = "customer_visible_pending_decisions";
const CHAT_HOMES: DecisionHomeKind[] = ["growth", "needs_you"];
const READ_CAP = 200;

export const NEEDS_YOU_LINK = "/workspace?tab=needs-you";
export const GROWTH_LINK = "/workspace?tab=growth-strategy";
export const channelLink = (slug: string) => `/workspace?tab=channels&channel=${encodeURIComponent(slug)}`;

export class UnknownChannelError extends Error {
  constructor(readonly channel: string) {
    super(`unknown channel "${channel}"`);
  }
}

export type ChatCard = { id: string; decision_class: string; home: "growth" | "needs_you"; emitted_at: string };
export type ChannelPage = { channel: string; name: string; open: number; link: string };
export type ChatCardsPick = {
  cards: ChatCard[];
  more: { growth: number; needs_you: number };
  not_shown: string[];
  other_channel: string[];
  channel_pages: ChannelPage[];
  channel_unread: boolean;
};

type Row = { id: string; decision_class: string; home: string | null; home_channel: string | null; emitted_at: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function inChannel(r: Pick<Row, "decision_class" | "home_channel">, channel: string): boolean {
  return r.home_channel === channel || r.decision_class.startsWith(`${channel}.`);
}

export function rankCards(rows: ChatCard[]): ChatCard[] {
  return [...rows].sort((a, b) =>
    a.home !== b.home ? (a.home === "growth" ? -1 : 1) : a.emitted_at < b.emitted_at ? -1 : a.emitted_at > b.emitted_at ? 1 : 0,
  );
}

function asCard(r: Row): ChatCard | null {
  return r.home === "growth" || r.home === "needs_you"
    ? { id: r.id, decision_class: r.decision_class, home: r.home, emitted_at: r.emitted_at }
    : null;
}

export async function pickChatCards(
  db: TenantClient,
  opts: { decision_ids?: string[]; channel?: string },
): Promise<ChatCardsPick> {
  if (opts.channel !== undefined && !getChannel(opts.channel)) throw new UnknownChannelError(opts.channel);
  const channel = opts.channel;
  const namedMode = (opts.decision_ids ?? []).length > 0;
  const named = (opts.decision_ids ?? []).slice(0, CHAT_CARDS_MAX);

  const pendingQ = db
    .from(PENDING_VIEW)
    .select("id, decision_class, home, home_channel, emitted_at")
    .order("emitted_at", { ascending: true })
    .limit(READ_CAP);
  const [pending, channelRows] = await Promise.all([
    pendingQ,
    db.from(OPEN_CHANNEL_ACTIONS_VIEW).select("channel_slug").limit(READ_CAP),
  ]);
  if (pending.error) throw new Error(`pending decisions read failed: ${pending.error.message}`);

  const allWaiting = ((pending.data ?? []) as Row[]).filter((r) => asCard(r) !== null);
  const rows = ((pending.data ?? []) as Row[]).filter((r) => !channel || inChannel(r, channel));
  const waiting = rankCards(rows.map(asCard).filter((c): c is ChatCard => c !== null));

  let cards: ChatCard[];
  let not_shown: string[] = [];
  let other_channel: string[] = [];
  if (namedMode) {
    const byId = new Map(waiting.map((c) => [c.id, c]));
    const anyChannel = new Set(allWaiting.map((r) => r.id));
    cards = named.map((id) => (UUID_RE.test(id) ? byId.get(id) : undefined)).filter((c): c is ChatCard => !!c);
    const missing = named.filter((id) => !UUID_RE.test(id) || !byId.has(id));
    other_channel = missing.filter((id) => anyChannel.has(id));
    not_shown = missing.filter((id) => !anyChannel.has(id));
  } else {
    cards = waiting.slice(0, CHAT_CARDS_MAX);
  }
  const shown = new Set(cards.map((c) => c.id));
  const more = { growth: 0, needs_you: 0 };
  for (const c of waiting) if (!shown.has(c.id)) more[c.home] += 1;

  const open = new Map<string, number>();
  const bump = (slug: string | null | undefined) => {
    if (!slug || (channel && slug !== channel)) return;
    open.set(slug, (open.get(slug) ?? 0) + 1);
  };
  for (const r of (channelRows.error ? [] : channelRows.data ?? []) as Array<{ channel_slug: string | null }>) bump(r.channel_slug);
  for (const r of (pending.data ?? []) as Row[]) if (r.home === "channel") bump(r.home_channel);
  const channel_pages = [...open]
    .map(([slug, n]) => ({ channel: slug, name: getChannel(slug)?.name ?? slug, open: n, link: channelLink(slug) }))
    .sort((a, b) => b.open - a.open);

  return { cards, more, not_shown, other_channel, channel_pages, channel_unread: !!channelRows.error };
}

export function chatCardsReply(p: ChatCardsPick, askerRole: string | null = null): string {
  const lines: string[] = [];
  const memberAsks = askerRole !== null && askerRole !== "owner" && askerRole !== "admin";
  const onChannelPages = p.channel_pages.reduce((n, c) => n + c.open, 0);
  if (p.cards.length > 0) {
    lines.push(
      `Showed ${p.cards.length} live approval card${p.cards.length === 1 ? "" : "s"} under your reply. ` +
        (memberAsks ? "An owner or admin approves or rejects right on them" : "The founder approves or rejects right on them") +
        " (a yes typed in chat approves nothing); do not list them again in prose or send them to another page to approve. " +
        `Their ids (to show one again later): ${p.cards.map((c) => `${c.id} (${c.decision_class})`).join(", ")}.`,
    );
  } else if (onChannelPages > 0 && !p.not_shown.length && !p.other_channel.length) {
    lines.push(`${onChannelPages} card(s) are waiting on the channel pages linked below, not in this chat. Say they are waiting there; never say no card is waiting.`);
  } else {
    lines.push("No growth or Needs-you card is waiting on the founder" + (p.not_shown.length || p.other_channel.length ? " among the ids you named" : "") + ". Say so in one line.");
  }
  if (memberAsks) {
    lines.push(
      `The person asking is a ${askerRole}, not an owner or admin: they cannot approve any card, here or on a page. Tell them an owner or admin has to approve it; never say they can.` +
        (askerRole === "member" && p.channel_pages.some((c) => c.channel === "email_marketing") ? " On an email card they can send themselves a test of any version." : ""),
    );
  }
  if (p.not_shown.length > 0) lines.push(`Not shown (already decided, gone, or on a channel page): ${p.not_shown.join(", ")}.`);
  if (p.other_channel.length > 0) lines.push(`Still waiting, but not on this channel (not shown): ${p.other_channel.join(", ")}.`);
  if (p.channel_unread) lines.push("Cards on channel pages could not be counted just now: do not say the channel pages are empty.");
  if (p.more.growth > 0) lines.push(`${p.more.growth} more growth card(s) wait: link [Growth page](${GROWTH_LINK}).`);
  if (p.more.needs_you > 0) lines.push(`${p.more.needs_you} more wait: link [Needs you](${NEEDS_YOU_LINK}).`);
  if (p.channel_pages.length > 0) {
    lines.push(
      "Cards on channel pages (approved there, not here). End with one line of links: " +
        p.channel_pages.map((c) => `[${c.name} · ${c.open}](${c.link})`).join(" "),
    );
  }
  return lines.join("\n");
}
