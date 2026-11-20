
export const ASK_MAX = 400;
export const COUNT_ASK_MAX = 800;
export const WHY_MAX = 200;

function squash(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export function clipKeepingLines(s: string, max: number): string {
  const t = s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return `${(at > 0 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

export function clipAtWord(s: string, max: number): string {
  const t = squash(s);
  if (t.length <= max) return t;
  const q = t.endsWith("?") ? "?" : "";
  const room = Math.max(1, max - 1 - q.length);
  let head = t.slice(0, room);
  if (t[room] !== " ") {
    const sp = head.lastIndexOf(" ");
    if (sp > 0) head = head.slice(0, sp);
  }
  head = head.replace(/[\s,;:.\-]+$/, "");
  return `${head}…${q}`;
}

export function cutKeepingQuestion(s: string, max: number): string {
  const t = squash(s);
  if (t.length <= max) return t;
  const m = /(?:^|[.!?]\s)([^.!?]*\?)[^?]*$/.exec(t);
  const q = m?.[1].trim();
  if (!q || q.length > max / 2) return clipAtWord(t, max);
  const context = t.slice(0, t.lastIndexOf(q)).trim();
  return `${clipAtWord(context, max - q.length - 1)} ${q}`;
}

export function clipAsk(text: string, max: number = ASK_MAX): string {
  const ask = squash(text);
  if (ask.length <= max) return ask;
  const sentences = ask.split(/(?<=[.!?])\s+/);
  const last = sentences[sentences.length - 1];
  const room = max - last.length - 2;
  if (sentences.length > 1 && room >= 80) {
    const head = clipAtWord(ask.slice(0, ask.length - last.length), room + 1).replace(/…\??$/, "");
    return `${head}… ${last}`;
  }
  return clipAtWord(ask, max);
}

export function normalizeAsk(
  ask: string,
  why: string | null | undefined,
  opts: { countRule?: boolean; required?: boolean; hypothesis?: boolean } = {},
): { ask: string; why: string } | null {
  const t = squash(ask ?? "");
  const w = squash(why ?? "");
  if (!t) return null;
  if (opts.countRule || opts.required || opts.hypothesis) {
    return { ask: clipAsk(t, opts.countRule || opts.hypothesis ? COUNT_ASK_MAX : ASK_MAX), why: w ? clipAtWord(w, WHY_MAX) : "" };
  }
  if (!t.includes("?")) return null;
  if (!t.endsWith("?")) return { ask: clipAsk(t, ASK_MAX), why: w ? clipAtWord(w, WHY_MAX) : "" };
  const sentences = t.split(/(?<=[.!?…])\s+/);
  let i = sentences.length;
  while (i > 0 && sentences[i - 1].endsWith("?")) i--;
  const question = sentences.slice(i).join(" ");
  const context = sentences.slice(0, i).join(" ");
  if (!context) return { ask: clipAsk(t, ASK_MAX), why: w ? clipAtWord(w, WHY_MAX) : "" };
  const outWhy = w || context;
  return { ask: clipAsk(question, ASK_MAX), why: clipAtWord(outWhy, WHY_MAX) };
}
