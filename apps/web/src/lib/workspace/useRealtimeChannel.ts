
import { useEffect, useRef } from "react";
import { getBrowserSupabaseSingleton, realtimeAuthReady } from "@/lib/realtimeAuth";
import type { RealtimeChannel } from "@supabase/supabase-js";

type ChannelSpec = {
  name: string;
  table: string;
  event: "INSERT" | "UPDATE" | "*";
  filter?: string;
};

type ChannelEntry = {
  spec: ChannelSpec;
  channel: RealtimeChannel;
  refCount: number;
  attempts: number;
  joined: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

const channels = new Map<string, ChannelEntry>();

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
const retryDelay = (attempts: number) => RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)];

function openChannel(spec: ChannelSpec): RealtimeChannel {
  return getBrowserSupabaseSingleton()
    .channel(spec.name)
    .on(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "postgres_changes" as any,
      {
        event: spec.event,
        schema: "public",
        table: spec.table,
        ...(spec.filter ? { filter: spec.filter } : {}),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: any) => {
        for (const fn of listenersByChannel.get(spec.name) ?? []) fn(payload.new);
      },
    );
}

const isLive = (entry: ChannelEntry) => channels.get(entry.spec.name) === entry && entry.refCount > 0;

const retired = new WeakSet<RealtimeChannel>();
const isCurrent = (entry: ChannelEntry, channel: RealtimeChannel) =>
  isLive(entry) && entry.channel === channel && !retired.has(channel);

function scheduleReplace(entry: ChannelEntry, why: string, delay = retryDelay(entry.attempts)): void {
  if (entry.timer) return;
  entry.attempts += 1;
  console.warn(`[useRealtimeChannel] ${entry.spec.name} ${why} — rejoining in ${delay}ms (attempt ${entry.attempts})`);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (!isLive(entry)) return;
    const old = entry.channel;
    entry.joined = false;
    retired.add(old);
    void getBrowserSupabaseSingleton().removeChannel(old);
    entry.channel = openChannel(entry.spec);
    join(entry);
  }, delay);
}

function join(entry: ChannelEntry): void {
  const channel = entry.channel;
  void realtimeAuthReady().then(() => {
    if (!isCurrent(entry, channel)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realtime = (getBrowserSupabaseSingleton() as any).realtime;
    const joinedWith = realtime?.accessTokenValue ?? null;
    channel.subscribe((status: string, err?: Error) => {
      if (!isCurrent(entry, channel)) return;
      if (status === "SUBSCRIBED") {
        if ((realtime?.accessTokenValue ?? null) !== joinedWith) {
          scheduleReplace(entry, "token changed during join", 0);
          return;
        }
        entry.joined = true;
        entry.attempts = 0;
        for (const listener of subscribedByChannel.get(entry.spec.name) ?? []) listener();
        return;
      }
      if (status === "CLOSED") {
        entry.joined = false;
        scheduleReplace(entry, `CLOSED${err ? `: ${err.message}` : ""}`);
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        entry.joined = false;
        const delay = retryDelay(entry.attempts);
        console.warn(`[useRealtimeChannel] ${entry.spec.name} ${status}${err ? `: ${err.message}` : ""}`);
        setTimeout(() => {
          if (isCurrent(entry, channel) && !entry.joined) {
            scheduleReplace(entry, `${status} not recovered`, 0);
          }
        }, delay);
      }
    });
  });
}

type UseRealtimeChannelOpts<Row> = {
  table: string;
  scopeKey: string;
  filter?: string;
  onInsert: (row: Row) => void;
  event?: "INSERT" | "UPDATE" | "*";
  onSubscribed?: () => void;
  enabled?: boolean;
};

export function useRealtimeChannel<Row>(opts: UseRealtimeChannelOpts<Row>): void {
  const {
    table,
    scopeKey,
    filter,
    onInsert,
    onSubscribed,
    event = "INSERT",
    enabled = true,
  } = opts;

  const onInsertRef = useRef(onInsert);
  const onSubscribedRef = useRef(onSubscribed);
  useEffect(() => {
    onInsertRef.current = onInsert;
    onSubscribedRef.current = onSubscribed;
  }, [onInsert, onSubscribed]);

  useEffect(() => {
    if (!enabled) return;

    const channelName =
      event === "INSERT"
        ? `${table}:${scopeKey}`
        : `${table}:${scopeKey}:${event}`;

    const listeners = listenersByChannel.get(channelName) ?? [];
    const wrapped = (row: unknown) => onInsertRef.current(row as Row);
    listeners.push(wrapped);
    listenersByChannel.set(channelName, listeners);
    const joined = () => onSubscribedRef.current?.();
    const joinListeners = subscribedByChannel.get(channelName) ?? new Set<() => void>();
    joinListeners.add(joined);
    subscribedByChannel.set(channelName, joinListeners);

    let entry = channels.get(channelName);
    if (entry) {
      entry.refCount += 1;
      if (entry.joined) joined();
    } else {
      const spec: ChannelSpec = { name: channelName, table, event, filter };
      entry = { spec, channel: openChannel(spec), refCount: 1, attempts: 0, joined: false, timer: null };
      channels.set(channelName, entry);
      join(entry);
    }

    return () => {
      const e = channels.get(channelName);
      if (!e) return;
      const ls = listenersByChannel.get(channelName) ?? [];
      const idx = ls.indexOf(wrapped);
      if (idx >= 0) ls.splice(idx, 1);
      listenersByChannel.set(channelName, ls);
      subscribedByChannel.get(channelName)?.delete(joined);
      e.refCount -= 1;
      if (e.refCount <= 0) {
        if (e.timer) clearTimeout(e.timer);
        e.timer = null;
        retired.add(e.channel);
        void getBrowserSupabaseSingleton().removeChannel(e.channel);
        channels.delete(channelName);
        listenersByChannel.delete(channelName);
        subscribedByChannel.delete(channelName);
      }
    };
  }, [table, scopeKey, filter, event, enabled]);
}

const subscribedByChannel = new Map<string, Set<() => void>>();
const listenersByChannel = new Map<string, Array<(row: unknown) => void>>();

export function auditRealtimeChannels(): { count: number; channels: string[] } {
  return {
    count: channels.size,
    channels: Array.from(channels.keys()),
  };
}
