"use client";

import { useEffect, useState } from "react";
import { Terminal, type LucideIcon } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { CONNECTOR_ICON } from "./settings/connectorLogos";
import { useOpenStatic, type StaticKind } from "./layout/shared";
import { CHIP_CLASS, ChipIcon } from "./Chip";
import { MarqueeRow } from "./MarqueeRow";

type Tile = {
  slug: string;
  label: string;
  always?: boolean;
  icon?: LucideIcon;
  iconColor?: string;
};

type Row = {
  key: string;
  title: string;
  destination: StaticKind;
  tiles: Tile[];
};

const ROWS: Row[] = [
  {
    key: "messaging",
    title: "Talk to Zavi from here",
    destination: "messaging",
    tiles: [
      { slug: "whatsapp", label: "WhatsApp" },
      { slug: "imessage", label: "iMessage" },
      { slug: "slack", label: "Slack" },
      { slug: "telegram", label: "Telegram" },
      { slug: "discord", label: "Discord" },
      { slug: "teams", label: "Teams" },
      {
        slug: "mcp",
        label: "MCP",
        always: true,
        icon: Terminal,
        iconColor: "text-violet-500",
      },
    ],
  },
  {
    key: "data",
    title: "Connect your stack",
    destination: "brain",
    tiles: [
      { slug: "operator_db", label: "Your database" },
      { slug: "stripe", label: "Stripe" },
      { slug: "meta_ads", label: "Meta Ads" },
      { slug: "google_ads", label: "Google Ads" },
      { slug: "google_analytics", label: "Google Analytics" },
      { slug: "google_search_console", label: "Search Console" },
      { slug: "github", label: "GitHub" },
    ],
  },
];

const MIN_TILES_PER_ROW = 2;

const ALL_SLUGS = ROWS.flatMap((row) => row.tiles.map((tile) => tile.slug));

export function ConnectRows({
  hidden = false,
  onAvailability,
}: {
  hidden?: boolean;
  onAvailability?: (available: boolean) => void;
} = {}) {
  const openStatic = useOpenStatic();
  const [connected, setConnected] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled || !tenantId) return;
        const res = await sb
          .from("connector_metadata")
          .select("slug")
          .eq("tenant_id", tenantId)
          .in("slug", ALL_SLUGS);
        if (cancelled || res.error) return;
        setConnected(new Set((res.data ?? []).map((r) => r.slug as string)));
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = connected
    ? ROWS.map((row) => ({
        ...row,
        tiles: row.tiles.filter((tile) => tile.always || !connected.has(tile.slug)),
      })).filter((row) => row.tiles.length >= MIN_TILES_PER_ROW)
    : null;
  const available = rows !== null && rows.length > 0;

  useEffect(() => {
    if (rows !== null) onAvailability?.(available);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, rows === null]);

  if (!rows || rows.length === 0 || hidden) return null;

  return (
    <div className="flex w-full flex-col gap-2">
      {rows.map((row) => (
        <div key={row.key} className="flex w-full flex-col items-center gap-2">
          {}
          <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-inkLight compact:text-[12px]">
            {row.title}
          </span>
          {}
          <MarqueeRow>
            {row.tiles.map((tile) => {
              const logo = CONNECTOR_ICON[tile.slug];
            const Glyph = tile.icon;
              return (
                <button
                  key={tile.slug}
                  type="button"
                  onClick={() => openStatic(row.destination)}
                  aria-label={`Connect ${tile.label}`}
                  title={`Connect ${tile.label}`}
                  className={CHIP_CLASS}
                >
                  <ChipIcon>
                    {logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logo} alt="" aria-hidden="true" className="h-4 w-4 compact:h-[18px] compact:w-[18px]" />
                    ) : Glyph ? (
                      <Glyph
                        className={`h-4 w-4 compact:h-[18px] compact:w-[18px] ${tile.iconColor ?? "text-inkLight"}`}
                        aria-hidden="true"
                      />
                    ) : null}
                  </ChipIcon>
                  {tile.label}
                </button>
              );
            })}
          </MarqueeRow>
        </div>
      ))}
    </div>
  );
}
