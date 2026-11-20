
export function encodeOutboxBody(text: string, blocks?: unknown[]): string {
  return blocks && blocks.length > 0 ? JSON.stringify({ text, blocks }) : text;
}

export function decodeOutboxBody(body: string): { text: string; blocks: unknown[] | null } {
  if (body.startsWith('{"text":')) {
    try {
      const v = JSON.parse(body) as { text?: unknown; blocks?: unknown };
      if (typeof v.text === "string") return { text: v.text, blocks: Array.isArray(v.blocks) ? v.blocks : null };
    } catch {
    }
  }
  return { text: body, blocks: null };
}
