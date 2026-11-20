"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CHANNELS, RETIRED_CHANNEL_SLUGS, connectInfoFor, type Channel } from "@zavi/shared";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { planBadgeLabel } from "@/lib/workspace/planUpgrade";
import { launchConnect } from "@/app/connectors/connectStrategies";
import { SourceIcon } from "./layout/SourceIcon";
import { AgentMentionIcon } from "./composer/AgentMentionIcon";
import {
  connectSlugFor,
  isChannelConnected,
  type MentionSection,
  type MentionTarget,
} from "./composer/mentionTargets";

export function filterChannelMentions(query: string): Channel[] {
  const q = query.trim().toLowerCase();
  const all = CHANNELS.filter((c) => !RETIRED_CHANNEL_SLUGS.has(c.slug));
  if (!q) return all;
  return all.filter(
    (c) =>
      c.executor.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
  );
}

export function useConnectedSlugs(enabled: boolean): Set<string> | null {
  const [slugs, setSlugs] = useState<Set<string> | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    let cancelled = false;
    (async () => {
      try {
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled || !tenantId) return;
        const res = await sb
          .from("connector_metadata")
          .select("slug")
          .eq("tenant_id", tenantId);
        if (cancelled || res.error) return;
        setSlugs(new Set((res.data ?? []).map((r) => r.slug as string)));
      } catch { }
    })();
    return () => {
      cancelled = true;
      started.current = false;
    };
  }, [enabled]);
  return slugs;
}

function ConnectPill({ connector }: { connector: string }) {
  const [busy, setBusy] = useState(false);
  const info = connectInfoFor(connector);
  if (!info) return null;
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (busy) return;
        setBusy(true);
        void launchConnect(connector, info)
          .catch(() => { })
          .finally(() => setBusy(false));
      }}
      className="shrink-0 rounded-full border border-rule bg-cream px-2.5 py-[3px] text-[11px] font-normal text-inkMuted transition-colors hover:border-ink/25 hover:text-ink"
    >
      {busy ? "Opening…" : "Connect"}
    </button>
  );
}

export function MentionTargetIcon({ target }: { target: MentionTarget }) {
  return target.kind === "channel" ? (
    <SourceIcon channel={target.channel} size="sm" />
  ) : (
    <AgentMentionIcon slug={target.sendSlug} />
  );
}

const MENU_MAX_H = 320;
const MENU_GAP = 12;
const MENU_MIN_H = 140;

export function placementFor(box: {
  top: number;
  bottom: number;
  ceiling: number;
  floor: number;
}): { below: boolean; maxH: number } {
  const above = box.top - box.ceiling - MENU_GAP;
  const under = box.floor - box.bottom - MENU_GAP;
  const below = above < MENU_MIN_H && under > above;
  const space = below ? under : above;
  return { below, maxH: Math.max(0, Math.min(MENU_MAX_H, space)) };
}

function clipTop(anchor: HTMLElement): number {
  for (let el: HTMLElement | null = anchor.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowY !== "visible") return el.getBoundingClientRect().top;
  }
  return 0;
}

function useMenuPlacement(deps: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{ below: boolean; maxH: number }>({
    below: false,
    maxH: MENU_MAX_H,
  });
  useLayoutEffect(() => {
    const measure = () => {
      const anchor = ref.current?.parentElement;
      if (!anchor) return;
      const box = anchor.getBoundingClientRect();
      setPlacement(
        placementFor({
          top: box.top,
          bottom: box.bottom,
          ceiling: clipTop(anchor),
          floor: window.innerHeight,
        }),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [deps]);
  return { ref, placement };
}

export function MentionMenu({
  sections,
  cursor,
  onSelect,
  connected,
  hint,
}: {
  sections: MentionSection[];
  cursor: number;
  onSelect: (target: MentionTarget) => void;
  connected: ReadonlySet<string> | null;
  hint?: string;
}) {
  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  const { ref, placement } = useMenuPlacement(total);
  if (total === 0) return null;

  let index = -1;
  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="Who to ask"
      style={{ maxHeight: placement.maxH }}
      className={`absolute left-0 z-30 w-[340px] max-w-full overflow-y-auto overflow-x-hidden rounded-2xl border border-rule bg-white py-1.5 shadow-elev ${
        placement.below ? "top-full mt-2" : "bottom-full mb-2"
      }`}
    >
      {hint && (
        <div className="px-3.5 pb-1 pt-1 text-[11px] font-normal text-inkMuted">{hint}</div>
      )}
      {sections.map((section) => (
        <div key={section.id} role="group" aria-label={section.label ?? section.heading ?? "Your CGO"}>
          {section.heading && (
            <div className="px-3.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.06em] text-inkMuted">
              {section.heading}
            </div>
          )}
          {section.label && (
            <div className="px-3.5 pb-0.5 pt-1 text-[11px] font-normal text-inkLight">{section.label}</div>
          )}
          {section.rows.map((target) => {
            index += 1;
            const isActive = index === cursor;
            const connector =
              target.kind === "channel" &&
              connected !== null &&
              !isChannelConnected(target.channel, connected)
                ? connectSlugFor(target.channel)
                : null;
            const locked = target.kind === "agent" && target.lockedTier ? target.lockedTier : null;
            return (
              <div
                key={target.key}
                role="option"
                aria-selected={isActive}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(target);
                }}
                className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 ${isActive ? "bg-creamDeep" : "hover:bg-creamDeep/60"
                  }`}
              >
                <MentionTargetIcon target={target} />
                <span
                  className={`min-w-0 flex-1 truncate text-[13px] leading-[18px] text-ink ${
                    section.id === "cgo" ? "font-medium" : "font-normal"
                  } ${locked ? "opacity-60" : ""}`}
                >
                  {target.name}
                  {target.kind === "agent" && target.custom && (
                    <span className="ml-1.5 text-[11px] text-inkMuted">your agent</span>
                  )}
                </span>
                {target.kind === "agent" && target.subtitle && (
                  <span className="shrink-0 text-[11px] text-inkMuted">{target.subtitle}</span>
                )}
                {locked && (
                  <span className="shrink-0 rounded-full bg-creamDeep px-2 py-[2px] text-[11px] text-inkMuted">
                    {planBadgeLabel(locked)}
                  </span>
                )}
                {connector && <ConnectPill connector={connector} />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
