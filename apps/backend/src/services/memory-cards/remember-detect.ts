
const PHRASE_RE =
  /\b(remember\s+this|remember\s+that|save\s+this|note\s+this|capture\s+this|add\s+to\s+(?:memory|brain)|remember\s+for\s+later|make\s+a\s+note)\b/i;

const PREFIX_RE =
  /^(?:<@[^>]+>[\s,:—-]*)*\s*(?:remember|note|fb|feedback|save|capture|memo)\s*:\s*(\S[\s\S]*)$/i;

export function detectRemember(rawText: string): boolean {
  const text = rawText ?? "";
  if (PHRASE_RE.test(text)) return true;

  const m = PREFIX_RE.exec(text.trim());
  if (!m) return false;
  return !m[1].trim().endsWith("?");
}
