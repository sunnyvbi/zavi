
type TelegramEntity = { type?: string; offset?: number; length?: number };

function entitiesOf(entities: unknown): TelegramEntity[] {
  return Array.isArray(entities) ? (entities as TelegramEntity[]) : [];
}

function entityText(text: string, e: TelegramEntity): string {
  const off = typeof e.offset === "number" ? e.offset : -1;
  const len = typeof e.length === "number" ? e.length : 0;
  if (off < 0 || len <= 0 || off + len > text.length) return "";
  return text.slice(off, off + len);
}

export function mentionsBot(text: unknown, entities: unknown, botUsername: string): boolean {
  if (typeof text !== "string" || !text || !botUsername) return false;
  const want = `@${botUsername.toLowerCase()}`;
  return entitiesOf(entities).some(
    (e) => e.type === "mention" && entityText(text, e).toLowerCase() === want,
  );
}

export function stripBotMention(text: unknown, entities: unknown, botUsername: string): string {
  if (typeof text !== "string" || !text) return "";
  let out = text;
  if (botUsername) {
    const want = `@${botUsername.toLowerCase()}`;
    const spans = entitiesOf(entities)
      .filter((e) => e.type === "mention" && entityText(text, e).toLowerCase() === want)
      .sort((a, b) => (b.offset ?? 0) - (a.offset ?? 0));
    for (const e of spans) {
      const off = e.offset ?? 0;
      const len = e.length ?? 0;
      out = `${out.slice(0, off)} ${out.slice(off + len)}`;
    }
    const esc = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`@${esc}\\b`, "gi"), " ");
  }
  out = out.replace(/^\s*\/(\w+)@\w+/, "/$1");
  return out.replace(/\s+/g, " ").trim();
}
