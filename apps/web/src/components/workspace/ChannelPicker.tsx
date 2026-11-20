"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Plus, Search } from "lucide-react";
import { CHANNELS, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { SourceIcon } from "./layout/SourceIcon";
import { Skeleton } from "@/components/ui/Skeleton";

type TenantChannelState = { channel_slug: string; connected?: boolean };

type RegistryChannel = (typeof CHANNELS)[number];

export type ChannelOption = {
  slug: string;
  name: string;
  category: string;
  connected: boolean;
  channel: RegistryChannel;
};

export function channelConnectHref(option: ChannelOption): string {
  return `/workspace?tab=brain&q=${encodeURIComponent(option.name)}#integrations`;
}

const CATEGORY_ORDER = ["paid", "organic", "owned"] as const;

export function useChannelOptions(): { options: ChannelOption[]; loading: boolean } {
  const [connected, setConnected] = useState<Set<string> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await apiFetch("/api/channels", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setConnected(new Set());
          return;
        }
        const json = (await res.json()) as { channels?: TenantChannelState[] };
        if (controller.signal.aborted) return;
        setConnected(
          new Set((json.channels ?? []).filter((c) => c.connected).map((c) => c.channel_slug)),
        );
      } catch {
        if (controller.signal.aborted) return;
        setConnected(new Set());
      }
    })();
    return () => controller.abort();
  }, []);

  const options = useMemo(
    () =>
      CHANNELS.filter((c) => !RETIRED_CHANNEL_SLUGS.has(c.slug)).map((c) => ({
        slug: c.slug as string,
        name: c.name as string,
        category: c.category as string,
        connected: connected?.has(c.slug as string) ?? false,
        channel: c,
      })),
    [connected],
  );

  return { options, loading: connected === null };
}

export function channelNameFor(slug: string): string {
  return (CHANNELS.find((c) => c.slug === slug)?.name as string | undefined) ?? slug;
}

function channelFor(slug: string): RegistryChannel | undefined {
  return CHANNELS.find((c) => c.slug === slug);
}

export function ChannelTags({
  selected,
  onRemove,
}: {
  selected: string[];
  onRemove: (slug: string) => void;
}) {
  if (selected.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {selected.map((slug) => {
        const channel = channelFor(slug);
        return (
        <span
          key={slug}
          className="inline-flex h-7 items-center gap-2 rounded-full bg-ink/[0.06] pl-2 pr-1 text-[13px] text-inkMuted"
        >
          {channel && <SourceIcon channel={channel} size="sm" />}
          <span className="max-w-[140px] truncate">{channelNameFor(slug)}</span>
          <button
            type="button"
            onClick={() => onRemove(slug)}
            aria-label={`Remove ${channelNameFor(slug)}`}
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full transition-colors hover:bg-ink/10 hover:text-ink"
          >
            <svg aria-hidden viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </span>
        );
      })}
    </div>
  );
}

export function ChannelPickerPanel({
  selected,
  onToggle,
  onConnect,
}: {
  selected: string[];
  onToggle: (slug: string) => void;
  onConnect: (option: ChannelOption) => void;
}) {
  const { options, loading } = useChannelOptions();
  const picked = useMemo(() => new Set(selected), [selected]);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CATEGORY_ORDER.flatMap((category) =>
      options.filter(
        (o) => o.category === category && (!q || o.name.toLowerCase().includes(q)),
      ),
    );
  }, [options, query]);

  return (
    <div>
      <label className="flex items-center gap-2 border-b border-rule px-3 py-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-inkLight" aria-hidden />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search socials & ads"
          aria-label="Search socials and ads"
          autoFocus
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-ink outline-none placeholder:text-inkLight"
        />
      </label>
      {!loading && visible.length === 0 ? (
        <div className="px-3 py-3 text-[13px] text-inkMuted">No matches.</div>
      ) : (
        <div className="max-h-[260px] overflow-y-auto py-1">
          {visible.map((o) => {
            const isPicked = picked.has(o.slug);
            const action = o.connected
              ? {
                  onClick: () => onToggle(o.slug),
                  label: `${isPicked ? "Remove" : "Add"} ${o.name}`,
                }
              : { onClick: () => onConnect(o), label: `Connect ${o.name}` };
            return (
              <button
                key={o.slug}
                type="button"
                role={loading || !o.connected ? "menuitem" : "menuitemcheckbox"}
                aria-checked={!loading && o.connected ? isPicked : undefined}
                aria-label={loading ? o.name : action.label}
                title={loading || o.connected ? undefined : `${o.name} is not connected yet`}
                onClick={loading ? undefined : action.onClick}
                disabled={loading}
                aria-busy={loading || undefined}
                className="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] leading-[18px] text-ink transition-colors hover:bg-ink/[0.05] disabled:cursor-default disabled:hover:bg-transparent"
              >
                <SourceIcon channel={o.channel} size="sm" />
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                {loading ? (
                  <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-[4px]" />
                ) : isPicked ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-ink" aria-hidden />
                ) : !o.connected ? (
                  <Plus
                    className="h-3.5 w-3.5 shrink-0 text-inkLight transition-colors group-hover:text-ink"
                    aria-hidden
                  />
                ) : (
                  <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
