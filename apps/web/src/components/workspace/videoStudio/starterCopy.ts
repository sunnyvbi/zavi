import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";
import { scriptOf } from "../actions/StartersPanel";

export function starterTitle(card: Pick<ChannelActionView, "title">): string {
  return card.title.replace(/^[^:]{1,40}:\s*/, "") || "Suggested ad";
}

export function splitScript(text: string): { hook: string | null; rest: string } {
  const t = text.trim();
  const m = t.match(/^(.+?[.!?])(\s+|$)([\s\S]*)$/);
  return m ? { hook: m[1], rest: m[3].trim() } : { hook: t || null, rest: "" };
}

export function hooksOf(main: string | null, alts: unknown): string[] {
  const out: string[] = [];
  for (const h of [main, ...(Array.isArray(alts) ? alts : [])]) {
    const t = typeof h === "string" ? h.trim() : "";
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

export function withoutHook(full: string, hook: string | null): string {
  return hook && full.startsWith(hook) ? full.slice(hook.length).trim() : full;
}

export function starterCopy(card: Pick<ChannelActionView, "title" | "body">): { title: string; hooks: string[]; script: string } {
  const full = scriptOf(card);
  const cardHooks = (card.body as { hooks?: unknown } | undefined)?.hooks;
  const first = Array.isArray(cardHooks) && typeof cardHooks[0] === "string" && full.startsWith(cardHooks[0].trim()) ? cardHooks[0].trim() : null;
  const split = first ? { hook: first, rest: withoutHook(full, first) } : splitScript(full);
  return { title: starterTitle(card), hooks: hooksOf(split.hook, first ? cardHooks : null), script: split.rest };
}

export function animateCopy(card: Pick<ChannelActionView, "title" | "body">): { title: string; hooks: string[]; script: string } {
  return { title: starterTitle(card), hooks: [], script: scriptOf(card) };
}
