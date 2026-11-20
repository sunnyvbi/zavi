"use client";

import { useEffect, useState } from "react";
import {
  Compass,
  Megaphone,
  MessageCircleQuestion,
  MessageSquare,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { DEFAULT_NEXT_TILES, type NextTile, type NextTileKind } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { trackEvent } from "@/lib/analytics/events";
import { useIsCompact } from "@/lib/responsive";
import { Skeleton } from "@/components/ui/Skeleton";
import { useWorkspaceOptional } from "./WorkspaceShell";
import { HoverScrollTitle, useOpenStatic } from "./layout/shared";
import { ChipIcon } from "./Chip";

const KIND_ICON: Record<NextTileKind, { icon: LucideIcon; color: string }> = {
  plan: { icon: Compass, color: "text-blue-400" },
  channel: { icon: Megaphone, color: "text-orange-400" },
  ask: { icon: MessageCircleQuestion, color: "text-purple-400" },
  talk: { icon: MessageSquare, color: "text-emerald-400" },
  make: { icon: Sparkles, color: "text-fuchsia-400" },
};

const TILE_BASE =
  "group flex items-center gap-2.5 rounded-2xl border border-rule bg-cream text-left transition-colors hover:border-inkLight/40 hover:bg-creamDeep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink/40";

export function NextTiles({
  onPrompt,
  onFirstRunDone,
}: {
  onPrompt: (prompt: string) => void;
  onFirstRunDone?: (done: boolean) => void;
}) {
  const openStatic = useOpenStatic();
  const compact = useIsCompact();
  const workspace = useWorkspaceOptional();
  const initialTiles = workspace?.initialNextTiles;
  const [tiles, setTiles] = useState<NextTile[] | null>(
    initialTiles?.tiles ?? null,
  );

  useEffect(() => {
    if (initialTiles) {
      onFirstRunDone?.(initialTiles.first_run_done);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/workspace/next-tiles");
        if (!res.ok) throw new Error(`next-tiles ${res.status}`);
        const body = (await res.json()) as { tiles?: NextTile[]; first_run_done?: boolean };
        if (!Array.isArray(body.tiles) || body.tiles.length === 0) {
          throw new Error("next-tiles empty");
        }
        if (!cancelled) {
          setTiles(body.tiles.slice(0, 3));
          onFirstRunDone?.(body.first_run_done === true);
        }
      } catch {
        if (!cancelled) {
          setTiles(DEFAULT_NEXT_TILES);
          onFirstRunDone?.(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onClick = (tile: NextTile, position: number) => {
    trackEvent("home_next_tile_clicked", { kind: tile.kind, state: tile.state, position });
    switch (tile.kind) {
      case "plan":
        openStatic("autopilot");
        return;
      case "channel":
        openStatic("channels", { channel: tile.key });
        return;
      case "talk":
        openStatic("messaging");
        return;
      case "ask":
      case "make":
        onPrompt(tile.key);
        return;
    }
  };

  return (
    <div
      className="mb-3 flex w-full flex-col gap-2"
      data-testid="next-tiles"
      aria-busy={tiles === null}
    >
      <div
        data-testid="next-tiles-row"
        className={
          compact
            ? "-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto px-4 scrollbar-none"
            : "grid grid-cols-3 gap-2"
        }
      >
        {tiles === null
          ? Array.from({ length: 3 }, (_, index) => (
              <div
                key={index}
                data-testid="next-tile-skeleton"
                className={
                  compact
                    ? "flex min-h-[44px] w-3/4 shrink-0 snap-start items-center gap-2.5 rounded-2xl border border-rule bg-cream px-2.5 py-1.5"
                    : "flex min-w-0 items-center gap-2.5 rounded-2xl border border-rule bg-cream px-2.5 py-2.5"
                }
              >
                <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ))
          : tiles.map((tile, i) => {
          const { icon: Icon, color } = KIND_ICON[tile.kind] ?? KIND_ICON.ask;
          return (
            <button
              key={`${tile.kind}:${tile.key}`}
              type="button"
              onClick={() => onClick(tile, i + 1)}
              title={tile.label}
              className={
                compact
                  ? `${TILE_BASE} min-h-[44px] w-[72%] max-w-[260px] shrink-0 snap-start py-1.5 pl-1.5 pr-4`
                  : `${TILE_BASE} min-w-0 px-2.5 py-2.5`
              }
            >
              <ChipIcon>
                <Icon className={`h-4 w-4 compact:h-[18px] compact:w-[18px] ${color}`} aria-hidden="true" />
              </ChipIcon>
              {compact ? (
                <span
                  data-testid="next-tile-label"
                  className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold tracking-[-0.012em] text-ink"
                >
                  {tile.label}
                </span>
              ) : (
                <HoverScrollTitle
                  text={tile.label}
                  className="text-[14px] font-semibold leading-[1.25] tracking-[-0.012em] text-ink"
                />
              )}
            </button>
          );
            })}
      </div>
    </div>
  );
}
