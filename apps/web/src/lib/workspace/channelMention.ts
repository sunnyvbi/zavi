import { CHANNELS, type Channel } from "@zavi/shared";

const BY_EXECUTOR: Map<string, Channel> = (() => {
  const m = new Map<string, Channel>();
  for (const c of CHANNELS)
    if (!m.has(c.executor)) m.set(c.executor, c as Channel);
  return m;
})();

const MENTION_RE = /^@([a-z0-9_-]+)(?:[ \t]+([\s\S]*))?$/;

export type SplitChannelMention = {
  channel: Channel | null;
  body: string;
};

export function splitChannelMention(text: string): SplitChannelMention {
  const m = MENTION_RE.exec(text);
  if (!m) return { channel: null, body: text };
  const channel = BY_EXECUTOR.get(m[1]) ?? null;
  if (!channel) return { channel: null, body: text };
  return { channel, body: (m[2] ?? "").trim() };
}

const HANDOFF_RE =
  /^@([a-z0-9_-]+)\s*(?:→|->)\s*handed off from @([a-z0-9_-]+)\s*\n+/;

export type SplitHandoff = {
  channel: Channel | null;
  agentSlug: string | null;
  fromSlug: string | null;
  body: string;
};

export function splitHandoffHeader(text: string): SplitHandoff {
  const m = HANDOFF_RE.exec(text);
  if (!m) return { channel: null, agentSlug: null, fromSlug: null, body: text };
  return {
    channel: BY_EXECUTOR.get(m[1]) ?? null,
    agentSlug: m[1],
    fromSlug: m[2],
    body: text.slice(m[0].length),
  };
}

export function stripChannelMention(text: string | null): string {
  if (!text) return "";
  return splitChannelMention(text).body;
}
