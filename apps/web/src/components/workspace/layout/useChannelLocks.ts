"use client";

import { useEffect, useState } from "react";
import { sharedJson } from "@/lib/workspace/sharedRead";

export type ChannelLocks = Record<string, unknown>;

const FAILED_RETRY_MS = 3_000;
const FAILED_RETRIES = 3;

let cached: ChannelLocks | null = null;
let inflight: Promise<ChannelLocks> | null = null;
let started = 0;

async function fetchLocks(fresh: boolean): Promise<ChannelLocks> {
  const next: ChannelLocks = {};
  try {
    const body = await sharedJson<{
      channel_locks?: ChannelLocks;
      channel_locks_known?: boolean;
      channels?: Array<{ channel_slug: string; locked_tier?: unknown }>;
    }>("/api/channels", { fresh });
    if (!body) return next;
    if (body.channel_locks_known === false) return next;
    if (body.channel_locks) return { ...body.channel_locks };
    for (const c of body.channels ?? []) next[c.channel_slug] = c.locked_tier;
  } catch {
    return {};
  }
  return next;
}

function readLocks(fresh: boolean): Promise<ChannelLocks> {
  if (inflight && !fresh) return inflight;
  const seq = ++started;
  const p: Promise<ChannelLocks> = fetchLocks(fresh)
    .then((next) => {
      if (seq === started && Object.keys(next).length > 0) cached = next;
      return next;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

export function prefetchChannelLocks(): void {
  if (cached) return;
  void readLocks(false);
}

export function resetChannelLocksCache(): void {
  cached = null;
  inflight = null;
  started = 0;
}

export function useChannelLocks(): ChannelLocks | null {
  const [locks, setLocks] = useState<ChannelLocks | null>(() => cached);
  useEffect(() => {
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (retriesLeft: number, fresh: boolean) => {
      const seq = ++latest;
      const next = await readLocks(fresh);
      if (seq !== latest) return;
      const failed = Object.keys(next).length === 0;
      setLocks((prev) => (failed && prev ? prev : next));
      if (failed && retriesLeft > 0) {
        timer = setTimeout(() => void load(retriesLeft - 1, true), FAILED_RETRY_MS);
      }
    };
    void load(FAILED_RETRIES, false);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void load(FAILED_RETRIES, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      latest = -1;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return locks;
}
