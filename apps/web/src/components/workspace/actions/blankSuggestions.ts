"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

export type BlankSuggestions = { loading: boolean; options: Record<string, string[]> };

const cache = new Map<string, Promise<Record<string, string[]>>>();

export function clearBlankSuggestionCache() {
  cache.clear();
}

async function load(slug: string, cardId: string, blanks: string[], labels: Record<string, string>): Promise<Record<string, string[]>> {
  const res = await apiFetch(`/api/channels/${encodeURIComponent(slug)}/actions/${encodeURIComponent(cardId)}/blank-suggestions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blanks: blanks.map((blank) => (labels[blank] ? { blank, label: labels[blank] } : { blank })) }),
  });
  if (!res.ok) return {};
  const body = (await res.json().catch(() => null)) as { suggestions?: Record<string, unknown> } | null;
  const out: Record<string, string[]> = {};
  blanks.forEach((blank, i) => {
    const list = body?.suggestions?.[String(i)];
    if (Array.isArray(list)) {
      const clean = list.filter((v): v is string => typeof v === "string" && !!v.trim()).slice(0, 3);
      if (clean.length) out[blank] = clean;
    }
  });
  return out;
}

export function useBlankSuggestions(slug: string | null | undefined, cardId: string | null | undefined, blanks: string[], labels: Record<string, string> = {}): BlankSuggestions {
  const list = blanks.slice(0, 12);
  const key = slug && cardId && list.length ? `${slug}:${cardId}:${list.join("\u0000")}` : null;
  const input = useRef({ slug, cardId, list, labels });
  input.current = { slug, cardId, list, labels };
  const [state, setState] = useState<{ key: string | null; options: Record<string, string[]> | null }>({ key: null, options: null });
  useEffect(() => {
    const { slug: s, cardId: id, list: l, labels: names } = input.current;
    if (!key || !s || !id) return;
    let live = true;
    let pending = cache.get(key);
    if (!pending) {
      pending = load(s, id, l, names).catch(() => ({}));
      cache.set(key, pending);
      void pending.then((r) => {
        if (!Object.keys(r).length) cache.delete(key);
      });
    }
    void pending.then((options) => {
      if (live) setState({ key, options });
    });
    return () => {
      live = false;
    };
  }, [key]);
  if (!key) return { loading: false, options: {} };
  return state.key === key && state.options ? { loading: false, options: state.options } : { loading: true, options: {} };
}
