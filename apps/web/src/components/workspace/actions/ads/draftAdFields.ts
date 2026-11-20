export type DraftAdFields = { intro: string; headline: string; description: string; cta: string };

const KEYS: Record<string, keyof DraftAdFields> = {
  "intro text": "intro",
  "introductory text": "intro",
  "primary text": "intro",
  text: "intro",
  body: "intro",
  headline: "headline",
  title: "headline",
  description: "description",
  cta: "cta",
  "call to action": "cta",
  button: "cta",
};

const LINE = /^\s*[-*•]?\s*([A-Za-z][A-Za-z ]{1,24}?)\s*(?:\(\s*\d+\s*\/\s*\d+\s*\))?\s*:\s*(.*)$/;

export function draftAdFields(body: string | null | undefined): DraftAdFields | null {
  if (!body) return null;
  const fields: DraftAdFields = { intro: "", headline: "", description: "", cta: "" };
  let current: keyof DraftAdFields | null = null;
  let labelled = 0;
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(LINE);
    const key = match ? KEYS[match[1].trim().toLowerCase()] : undefined;
    if (match && key) {
      current = key;
      labelled += 1;
      fields[key] = match[2].trim();
    } else if (current && line.trim()) {
      fields[current] = `${fields[current]}\n${line.trim()}`.trim();
    } else if (!current && line.trim()) {
      return null;
    }
  }
  return labelled >= 2 && (fields.intro || fields.headline) ? fields : null;
}
