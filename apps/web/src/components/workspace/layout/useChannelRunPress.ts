"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { creditRefusalFrom, type CreditRefusal } from "@/lib/workspace/creditRefusal";
import { planRefusalTier, type ChannelPlanLock } from "../actions/channelPlanLock";

export const RUN_COST_UNKNOWN = "Uses credits from your plan";

export function runCostLabel(credits: number | null): string {
  return credits == null ? RUN_COST_UNKNOWN : `About ${credits.toLocaleString()} credits`;
}

const PRESS_ID_TTL_MS = 2 * 60 * 1000;

const RUN_ID_TTL_MS = 60 * 60 * 1000;

const heldInMemory = new Map<string, { id: string; at: number }>();

function pressId(slug: string): string {
  const key = `zavi.channel-run.${slug}`;
  const fresh = () => {
    const c = globalThis.crypto;
    return typeof c?.randomUUID === "function"
      ? c.randomUUID()
      : `press-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  };
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const held = JSON.parse(raw) as { id?: unknown; at?: unknown };
      if (
        typeof held.id === "string" &&
        held.id.length >= 8 &&
        typeof held.at === "number" &&
        Date.now() - held.at < PRESS_ID_TTL_MS
      ) {
        return held.id;
      }
    }
    const id = fresh();
    window.localStorage.setItem(key, JSON.stringify({ id, at: Date.now() }));
    return id;
  } catch {
    const held = heldInMemory.get(slug);
    if (held && Date.now() - held.at < PRESS_ID_TTL_MS) return held.id;
    const id = fresh();
    heldInMemory.set(slug, { id, at: Date.now() });
    return id;
  }
}

const CHANNEL_RUN_ENDED_EVENT = "zavi:channel-run-ended";

export type ChannelRunPressLatch = { current: Set<string> };
export const ChannelRunPressLatchContext = createContext<ChannelRunPressLatch | null>(null);

export function announceChannelRunEnded(slug: string): void {
  clearPressId(slug);
  window.dispatchEvent(new CustomEvent(CHANNEL_RUN_ENDED_EVENT, { detail: { slug } }));
}

function clearPressId(slug: string): void {
  heldInMemory.delete(slug);
  try {
    window.localStorage.removeItem(`zavi.channel-run.${slug}`);
  } catch {
  }
}

function rememberRunId(slug: string, id: string): void {
  try {
    window.localStorage.setItem(
      `zavi.channel-run-id.${slug}`,
      JSON.stringify({ id, at: Date.now() }),
    );
  } catch {
  }
}

export function recallRunId(slug: string): { id: string; at: number } | null {
  try {
    const raw = window.localStorage.getItem(`zavi.channel-run-id.${slug}`);
    if (!raw) return null;
    const held = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (
      typeof held.id === "string" &&
      held.id.length >= 8 &&
      typeof held.at === "number" &&
      Date.now() - held.at < RUN_ID_TTL_MS
    ) {
      return { id: held.id, at: held.at };
    }
  } catch {
  }
  return null;
}

export function useChannelRunPress({
  slug,
  running = false,
  onRan,
  onStart,
  onSettle,
  planLock = null,
}: {
  slug: string;
  running?: boolean;
  onRan: () => void;
  onStart?: () => void;
  onSettle?: () => void;
  planLock?: ChannelPlanLock | null;
}): {
  press: () => Promise<void>;
  busy: boolean;
  fired: boolean;
  blocked: boolean;
  error: string | null;
  credit: CreditRefusal | null;
} {
  const [busy, setBusy] = useState(false);
  const latch = useContext(ChannelRunPressLatchContext);
  const [fired, setFired] = useState(() => latch?.current.has(slug) ?? false);
  const [error, setError] = useState<string | null>(null);
  const [credit, setCredit] = useState<CreditRefusal | null>(null);
  const pressed = useRef(false);
  useEffect(() => {
    const ended = (e: Event) => {
      if ((e as CustomEvent<{ slug?: string }>).detail?.slug !== slug) return;
      pressed.current = false;
      latch?.current.delete(slug);
      setFired(false);
    };
    window.addEventListener(CHANNEL_RUN_ENDED_EVENT, ended);
    return () => window.removeEventListener(CHANNEL_RUN_ENDED_EVENT, ended);
  }, [slug, latch]);
  const blocked = running || busy || fired;

  async function press() {
    if (running || pressed.current || latch?.current.has(slug)) return;
    if (planLock?.tierName) {
      planLock.upgrade();
      return;
    }
    pressed.current = true;
    onStart?.();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/channels/${slug}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: pressId(slug) }),
      });
      const body = (await res.json().catch(() => null)) as
        | { run_id?: unknown; error?: { message?: string } }
        | null;
      if (!res.ok) {
        pressed.current = false;
        clearPressId(slug);
        const plan = planLock ? planRefusalTier(res.status, body) : null;
        if (planLock && plan) {
          planLock.upgrade(plan.tier);
          return;
        }
        const refusal = creditRefusalFrom(body, "channel");
        setCredit(refusal);
        setError(refusal?.headline ?? body?.error?.message ?? "Zavi could not start this run.");
        return;
      }
      if (typeof body?.run_id === "string" && body.run_id.length >= 8) {
        rememberRunId(slug, body.run_id);
      }
      latch?.current.add(slug);
      setFired(true);
      onRan();
    } catch (e) {
      pressed.current = false;
      setError((e as Error).message || "Zavi could not start this run.");
    } finally {
      setBusy(false);
      onSettle?.();
    }
  }

  return { press, busy, fired, blocked, error, credit };
}
