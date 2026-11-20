"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { CreatorCardData } from "./types";

const CARD_FRESH_MS = 60_000;
type CardEntry = { card: CreatorCardData | null; at: number };
const cardCache = new Map<string, CardEntry>();
const inFlight = new Map<string, Promise<CreatorCardData | null>>();

export const INVITE_PREFIX = "invite:";
export const isInviteId = (id: string): boolean => id.startsWith(INVITE_PREFIX);
export const inviteIdOf = (id: string): string => id.slice(INVITE_PREFIX.length);

function cardPath(id: string): string {
  return isInviteId(id)
    ? `/api/humans/creators/invites/${encodeURIComponent(inviteIdOf(id))}/card`
    : `/api/humans/creators/${encodeURIComponent(id)}/card`;
}

export function primeCreatorCards(cards: CreatorCardData[]): void {
  const now = Date.now();
  for (const c of cards) if (c.human_member_id && !cardCache.has(c.human_member_id)) cardCache.set(c.human_member_id, { card: c, at: now });
}

function fetchCard(id: string): Promise<CreatorCardData | null> {
  const running = inFlight.get(id);
  if (running) return running;
  const p = apiFetch(cardPath(id))
    .then(async (res) => (res.ok ? (((await res.json()) as { creator: CreatorCardData }).creator ?? null) : null))
    .catch(() => null)
    .then((card) => {
      if (card) cardCache.set(id, { card, at: Date.now() });
      return card;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

export function resetCreatorCardCache(): void {
  cardCache.clear();
  inFlight.clear();
}

export function useCreatorCards(ids: string[]): Record<string, CreatorCardData | null> {
  const key = Array.from(new Set(ids.filter(Boolean))).sort().join(",");
  const [cards, setCards] = useState<Record<string, CreatorCardData | null>>(() => {
    const seed: Record<string, CreatorCardData | null> = {};
    for (const id of key ? key.split(",") : []) {
      const hit = cardCache.get(id);
      if (hit) seed[id] = hit.card;
    }
    return seed;
  });
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    mounted.current = true;
    if (!key) return;
    const now = Date.now();
    const cached: Record<string, CreatorCardData | null> = {};
    for (const id of key.split(",")) {
      const hit = cardCache.get(id);
      if (hit) cached[id] = hit.card;
      if (!hit || now - hit.at > CARD_FRESH_MS) {
        void fetchCard(id).then((card) => {
          if (!mounted.current) return;
          setCards((c) => {
            const next = card ?? cardCache.get(id)?.card ?? c[id] ?? null;
            return c[id] === next && id in c ? c : { ...c, [id]: next };
          });
        });
      }
    }
    if (Object.keys(cached).length) setCards((c) => ({ ...c, ...cached }));
  }, [key]);
  return cards;
}

export async function callJson<T>(
  path: string,
  init?: { method?: string; body?: unknown; idempotent?: boolean },
): Promise<{ ok: true; data: T } | { ok: false; message: string; status: number }> {
  try {
    const res = await apiFetch(path, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers: { "Content-Type": "application/json" },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      idempotent: init?.idempotent,
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (!res.ok) return { ok: false, status: res.status, message: body?.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, data: body as T };
  } catch (e) {
    return { ok: false, status: 0, message: (e as Error).message || "Network error" };
  }
}
