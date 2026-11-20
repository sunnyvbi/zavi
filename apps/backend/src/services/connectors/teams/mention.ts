
/* eslint-disable @typescript-eslint/no-explicit-any */

export function stripBotMention(text: unknown, entities: unknown): string {
  if (typeof text !== "string" || !text) return "";
  let out = text;
  if (Array.isArray(entities)) {
    for (const e of entities as any[]) {
      if (e && e.type === "mention" && typeof e.text === "string" && e.text) {
        out = out.split(e.text).join(" ");
      }
    }
  }
  out = out.replace(/<at\b[^>]*>.*?<\/at>/gis, " ");
  return out.replace(/\s+/g, " ").trim();
}
