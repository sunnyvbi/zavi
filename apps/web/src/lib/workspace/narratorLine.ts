
import type { ChatRow } from "./useChatThread";

export type NarratorLine =
  | { kind: "prose"; text: string }
  | { kind: "verb"; label: string; detail: string };

const MAX_PROSE = 180;

function field(row: ChatRow, key: string): string {
  return String((row.body as Record<string, unknown>)[key] ?? "");
}

function clamp(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_PROSE) return flat;
  const cut = flat.slice(0, MAX_PROSE);
  const sp = cut.lastIndexOf(" ");
  return (sp > MAX_PROSE * 0.6 ? cut.slice(0, sp) : cut) + "…";
}

export function pickNarratorLine(
  rows: ChatRow[],
  describeTool: (row: ChatRow) => { label: string; detail: string },
): NarratorLine | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (field(r, "teKind") !== "reasoning") continue;
    const text = clamp(field(r, "text"));
    if (text) return { kind: "prose", text };
  }
  let fallback: NarratorLine | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const kind = field(r, "teKind");
    if (kind === "reasoning" || kind === "plan") continue;
    const { label, detail } = describeTool(r);
    if (!label) continue;
    const clamped = clamp(detail);
    if (clamped) return { kind: "verb", label, detail: clamped };
    if (!fallback) fallback = { kind: "verb", label, detail: "" };
  }
  return fallback;
}
