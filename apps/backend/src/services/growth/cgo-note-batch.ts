
import type { NoteItem } from "./cgo-note-items";
import { parseNoteItems } from "./cgo-note-items";

export const NOTE_BATCH_PERIOD = "10m";
export const NOTE_BATCH_TIMEOUT = "15m";
export const NOTE_BATCH_LOOKBACK_MS = 24 * 3_600_000;
export const NOTE_BATCH_MAX = 20;

export type BatchNote = {
  id: string;
  run_id: string | null;
  kind: "scheduled" | "alarm" | "founder";
  saw: string[] | null;
  changed: string[] | null;
  would_change: string[] | null;
  need: string[] | null;
  next_review_at: string | null;
  items?: unknown[] | null;
  headline?: string | null;
  created_at: string;
};

export function primaryNote<T extends Pick<BatchNote, "run_id" | "created_at">>(notes: readonly T[]): T {
  if (notes.length === 0) throw new Error("primaryNote: no notes");
  const newest = (xs: readonly T[]) => xs.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  const reviews = notes.filter((n) => n.run_id);
  return reviews.length ? newest(reviews) : newest(notes);
}

function uniq(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const k = l.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

function legacyItems(n: BatchNote): NoteItem[] {
  return [
    ...(n.need ?? []).map((text) => ({ section: "needs_you" as const, text })),
    ...(n.changed ?? []).map((text) => ({ section: "changed" as const, text })),
  ];
}

export function mergeNotes(notes: readonly BatchNote[]): BatchNote {
  if (notes.length === 0) throw new Error("mergeNotes: no notes");
  if (notes.length === 1) return notes[0];
  const ordered = [...notes].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const primary = primaryNote(ordered);
  const anyItems = ordered.some((n) => (parseNoteItems(n.items) ?? []).length > 0);
  let items: NoteItem[] | null = null;
  if (anyItems) {
    const seen = new Set<string>();
    items = [];
    for (const n of ordered) {
      const own = parseNoteItems(n.items);
      for (const i of own && own.length ? own : legacyItems(n)) {
        const k = `${i.section}\u0000${i.text.trim()}`;
        if (seen.has(k)) continue;
        seen.add(k);
        items.push(i);
      }
    }
  }
  return {
    id: primary.id,
    run_id: primary.run_id,
    kind: primary.kind,
    saw: uniq(ordered.flatMap((n) => n.saw ?? [])),
    changed: uniq(ordered.flatMap((n) => n.changed ?? [])),
    would_change: uniq(ordered.flatMap((n) => n.would_change ?? [])),
    need: uniq(ordered.flatMap((n) => n.need ?? [])),
    next_review_at: primary.next_review_at,
    items,
    headline: null,
    created_at: primary.created_at,
  };
}
