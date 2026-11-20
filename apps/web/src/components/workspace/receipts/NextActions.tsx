"use client";

import { useState } from "react";

export type NextAction = { title: string; moves: string };

export type ParsedNextActions = {
  before: string;
  actions: NextAction[];
  after: string;
};

const ITEM = /^\s{0,3}(\d{1,2})[.)]\s+(.+)$/;
const MOVES = /^(.*?)[\s.,;:(-]*\bMoves?:\s*(.+?)[.\s]*$/i;
const MAX_ACTIONS = 3;

function clean(s: string): string {
  return s
    .replace(/\*\*|__/g, "")
    .replace(/^[\s*_]+|[\s*_]+$/g, "")
    .replace(/[.:;,\s-]+$/, "")
    .trim();
}

export function parseNextActions(markdown: string): ParsedNextActions | null {
  if (!markdown) return null;
  const lines = markdown.split("\n");
  let inFence = false;
  const fenced = lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    return inFence || /^\s*(```|~~~)/.test(l);
  });
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!fenced[i] && ITEM.test(lines[i])) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  let first = last;
  for (let i = last - 1; i >= 0; i--) {
    const l = lines[i];
    if (fenced[i]) break;
    if (ITEM.test(l)) {
      first = i;
      continue;
    }
    if (l.trim() === "" || /^\s{2,}\S/.test(l)) continue;
    break;
  }
  let end = last;
  while (end + 1 < lines.length && /^\s{2,}\S/.test(lines[end + 1]) && !ITEM.test(lines[end + 1])) end++;

  const items: string[] = [];
  for (let i = first; i <= end; i++) {
    const m = ITEM.exec(lines[i]);
    if (m) items.push(m[2]);
    else if (lines[i].trim() && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
  }
  if (items.length === 0 || items.length > MAX_ACTIONS) return null;
  for (let i = first, n = 1; i <= end; i++) {
    const m = ITEM.exec(lines[i]);
    if (!m) continue;
    if (Number(m[1]) !== n) return null;
    n++;
  }
  const actions: NextAction[] = [];
  for (const item of items) {
    const m = MOVES.exec(item);
    if (!m) return null;
    const title = clean(m[1]);
    let moves = clean(m[2]);
    const opens = (moves.match(/\(/g) ?? []).length;
    const closes = (moves.match(/\)/g) ?? []).length;
    if (closes > opens && moves.endsWith(")")) moves = clean(moves.slice(0, -1));
    if (!title || !moves) return null;
    actions.push({ title, moves });
  }
  return {
    before: lines.slice(0, first).join("\n").trimEnd(),
    actions,
    after: lines.slice(end + 1).join("\n").trim(),
  };
}

export function NextActionsCard({
  actions,
  onAsk,
}: {
  actions: NextAction[];
  onAsk?: (title: string) => Promise<boolean>;
}) {
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const ask = async (title: string) => {
    if (!onAsk || busy || sent.has(title)) return;
    setBusy(title);
    setFailed(null);
    try {
      const ok = await onAsk(title);
      if (ok) setSent((prev) => new Set(prev).add(title));
      else setFailed(title);
    } catch {
      setFailed(title);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="not-prose mt-3 rounded-2xl border border-rule bg-white font-sans dark:bg-cream" data-testid="next-actions">
      <p className="border-b border-rule px-4 py-2.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-inkMuted">
        What to do next
      </p>
      <ol>
        {actions.map((a, i) => {
          const isSent = sent.has(a.title);
          return (
            <li key={a.title} className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-3 last:border-b-0">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-creamDeep text-[12px] font-bold text-inkMuted">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold leading-5 text-ink">{a.title}</p>
                <p className="mt-0.5 text-[13px] font-medium leading-5 text-inkMuted">Moves: {a.moves}</p>
                {failed === a.title && (
                  <p role="alert" className="mt-1 text-[13px] text-danger">
                    Could not send that. Try again, or type it below.
                  </p>
                )}
              </div>
              {onAsk && (
                <button
                  type="button"
                  disabled={isSent || busy !== null}
                  onClick={() => void ask(a.title)}
                  className="inline-flex h-10 items-center rounded-cta border border-rule bg-white px-3 text-[14px] font-semibold text-ink hover:bg-creamDeep disabled:cursor-default disabled:opacity-50 dark:bg-cream"
                >
                  {isSent ? "Sent" : busy === a.title ? "Sending..." : "Ask Zavi to do this"}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
