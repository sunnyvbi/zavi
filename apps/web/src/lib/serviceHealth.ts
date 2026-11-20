"use client";

import { useSyncExternalStore } from "react";
import { apiUrl } from "@/lib/api";

export type ServiceHealth = "up" | "down" | "recovered";

export const POLL_UP_MS = 60_000;
export const POLL_TROUBLE_MS = 10_000;
export const RECOVERED_SHOW_MS = 20_000;
const CHECK_TIMEOUT_MS = 5_000;

let state: ServiceHealth = "up";
let failures = 0;
let subscribers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let recoveredTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
const listeners = new Set<() => void>();

function set(next: ServiceHealth) {
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
}

async function isReady(fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(apiUrl("/health/ready"), {
      cache: "no-store",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  if (subscribers === 0) return;
  timer = setTimeout(() => void check(), ms);
}

export async function check(fetchImpl: typeof fetch = fetch): Promise<ServiceHealth> {
  if (inFlight) return state;
  inFlight = true;
  try {
    const ok = await isReady(fetchImpl);
    if (ok) {
      failures = 0;
      if (state === "down") {
        set("recovered");
        if (recoveredTimer) clearTimeout(recoveredTimer);
        recoveredTimer = setTimeout(() => set("up"), RECOVERED_SHOW_MS);
      }
      schedule(POLL_UP_MS);
    } else {
      failures += 1;
      if (failures >= 2) {
        if (recoveredTimer) {
          clearTimeout(recoveredTimer);
          recoveredTimer = null;
        }
        set("down");
      }
      schedule(POLL_TROUBLE_MS);
    }
    return state;
  } finally {
    inFlight = false;
  }
}

export function reportTrouble(): void {
  void check();
}

function subscribe(listener: () => void) {
  if (subscribers === 0) {
    if (recoveredTimer) {
      clearTimeout(recoveredTimer);
      recoveredTimer = null;
    }
    state = "up";
    failures = 0;
  }
  listeners.add(listener);
  subscribers += 1;
  if (subscribers === 1) void check();
  return () => {
    listeners.delete(listener);
    subscribers -= 1;
    if (subscribers === 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (recoveredTimer) {
        clearTimeout(recoveredTimer);
        recoveredTimer = null;
      }
      state = "up";
      failures = 0;
    }
  };
}

export function useServiceHealth(): ServiceHealth {
  return useSyncExternalStore(subscribe, () => state, () => "up");
}

export function __resetServiceHealthForTests(): void {
  state = "up";
  failures = 0;
  inFlight = false;
  if (timer) clearTimeout(timer);
  if (recoveredTimer) clearTimeout(recoveredTimer);
  timer = null;
  recoveredTimer = null;
  listeners.clear();
  subscribers = 0;
}
