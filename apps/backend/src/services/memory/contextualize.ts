
export const CHUNK_CONTEXT_MAX_CHARS = 600;
const CONTEXT_TITLE_MAX_CHARS = 220;

export type ChunkContextInput = {
  note_type?: string | null;
  title?: string | null;
};

export type ContextualChunk = { body: string; contextualized: string };

export function buildChunkContextPrefix(input: ChunkContextInput): string {
  const noteType = (input.note_type ?? "").trim() || "untyped";
  const rawTitle = (input.title ?? "").replace(/\s+/g, " ").trim();
  const title =
    rawTitle.length > CONTEXT_TITLE_MAX_CHARS
      ? rawTitle.slice(0, CONTEXT_TITLE_MAX_CHARS).trimEnd()
      : rawTitle;
  const prefix = title ? `[${noteType}] ${title} — ` : `[${noteType}] — `;
  return prefix.length > CHUNK_CONTEXT_MAX_CHARS
    ? prefix.slice(0, CHUNK_CONTEXT_MAX_CHARS)
    : prefix;
}

export function contextualizeChunks(
  chunks: string[],
  ctx: ChunkContextInput,
): ContextualChunk[] {
  const prefix = buildChunkContextPrefix(ctx);
  return chunks.map((body) => ({
    body,
    contextualized: prefix ? `${prefix}${body}` : body,
  }));
}
