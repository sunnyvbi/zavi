"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export type LearnedCard = { lines: string[]; quotes: Array<{ text: string; source_url: string }> };

export const LEARNED_POLL_MS = 10_000;
export const LEARNED_POLL_CAP_MS = 5 * 60_000;

function parseCard(body: unknown): { settled: boolean; card: LearnedCard | null } {
  const b = (body ?? {}) as { status?: unknown; card?: unknown };
  const settled = b.status === "ready" || b.status === "thin" || b.status === "failed";
  const c = b.card as { lines?: unknown; quotes?: unknown } | null | undefined;
  if (!c || typeof c !== "object") return { settled, card: null };
  const lines = Array.isArray(c.lines) ? c.lines.filter((l): l is string => typeof l === "string" && l.trim() !== "") : [];
  const quotes = Array.isArray(c.quotes)
    ? c.quotes
        .filter((q): q is { text: string; source_url: string } =>
          !!q && typeof (q as { text?: unknown }).text === "string" && typeof (q as { source_url?: unknown }).source_url === "string")
        .filter((q) => q.text.trim() !== "")
    : [];
  return { settled, card: lines.length || quotes.length ? { lines, quotes } : null };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function WhatZaviLearned({ active }: { active: boolean }) {
  const [card, setCard] = useState<LearnedCard | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!active || settled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const started = Date.now();
    const read = async () => {
      let done = false;
      try {
        const res = await apiFetch("/api/workspace/growth-intake/learned");
        if (res.ok && !stopped) {
          const parsed = parseCard(await res.json());
          if (stopped) return;
          if (parsed.card) setCard(parsed.card);
          done = parsed.settled;
          if (done) setSettled(true);
        }
      } catch {
        done = false;
      }
      if (stopped || done || Date.now() - started >= LEARNED_POLL_CAP_MS) return;
      timer = setTimeout(() => void read(), LEARNED_POLL_MS);
    };
    void read();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, settled]);

  if (!active || !card) return null;
  return (
    <section data-testid="what-zavi-learned" aria-label="What Zavi learned" className="mb-3 rounded-xl border border-rule bg-bone px-4 py-3">
      <h2 className="text-sm font-semibold text-ink">What Zavi learned so far</h2>
      <p className="mt-0.5 text-xs text-inkMuted">While your plan is written, here is what Zavi found about your business.</p>
      {card.lines.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
          {card.lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
      {card.quotes.length > 0 && (
        <ul className="mt-2 space-y-1.5 text-sm text-ink">
          {card.quotes.map((q) => (
            <li key={q.text}>
              <span>“{q.text}”</span>
              {hostOf(q.source_url) && <span className="ml-1 text-xs text-inkMuted">from {hostOf(q.source_url)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
