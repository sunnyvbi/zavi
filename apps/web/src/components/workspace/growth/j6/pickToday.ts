
import type { CardKind } from "./api";

export type Pickable = {
  id: string;
  kind: CardKind;
  channel_slug: string | null;
  tone: "danger" | "warn" | null;
  mins?: number | null;
};

export const READY: readonly CardKind[] = ["post", "copy", "message"];

const MINS: Partial<Record<CardKind, number>> = { question: 0.2, link: 1, post: 1, message: 1, connect: 2, reconnect: 2, check: 2, plan: 3, copy: 5, task: 10 };

export function pickToday<T extends Pickable>(open: readonly T[], n = 3): string[] {
  const out: T[] = [];
  const held = new Set(open.filter((c) => c.tone === "danger" && c.channel_slug).map((c) => c.channel_slug));
  const ok = open.filter((c) => c.tone === "danger" || !c.channel_slug || !held.has(c.channel_slug));
  const add = (c?: T) => {
    if (c && !out.includes(c) && out.length < n) out.push(c);
  };
  const fixes = [
    ok.find((c) => c.tone === "danger"),
    ok.find((c) => c.kind === "reconnect"),
    ok.find((c) => c.kind === "link"),
    ok.find((c) => c.kind === "spend"),
  ].filter((c): c is T => !!c);
  for (const c of fixes) if (out.length < Math.min(2, n)) add(c);
  add(ok.find((c) => READY.includes(c.kind) && !out.includes(c)));
  const mins = (c: T) => c.mins ?? MINS[c.kind] ?? 1;
  for (const c of [...ok].sort((a, b) => mins(a) - mins(b))) add(c);
  return out.map((c) => c.id);
}
