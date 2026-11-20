"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Code2, FileText, Globe, type LucideIcon } from "lucide-react";
import { cx, FOCUS_RING } from "../layout/shared";

export type BuildSurfaceTab = "preview" | "files" | "code";

export const BUILD_SURFACE_TABS: ReadonlyArray<{
  id: BuildSurfaceTab;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "preview", label: "Preview", icon: Globe },
  { id: "files", label: "Files", icon: FileText },
  { id: "code", label: "Code", icon: Code2 },
];

const IDLE_PX = 30;
const DIVIDER_PX = 5;
const CHROME_PX = 6;
const LABEL_CHROME_PX = 12 + 16 + 6 + 12;

export const FALLBACK_LABEL_PX: Record<BuildSurfaceTab, number> = {
  preview: 52,
  files: 30,
  code: 34,
};

export function selectedTabWidth(labelPx: number): number {
  return Math.ceil(LABEL_CHROME_PX + labelPx);
}

export const BUILD_SURFACE_TABS_WIDTH =
  selectedTabWidth(Math.max(...Object.values(FALLBACK_LABEL_PX))) +
  IDLE_PX * (BUILD_SURFACE_TABS.length - 1) +
  DIVIDER_PX * (BUILD_SURFACE_TABS.length - 1) +
  CHROME_PX;

const EASE = "cubic-bezier(0.32,0.72,0,1)";
export const SLIDE_MS = 380;

export function indicatorOffset(index: number): number {
  return index * (IDLE_PX + DIVIDER_PX);
}

let pendingFocus: BuildSurfaceTab | null = null;

export function buildSurfacePanelId(tab: BuildSurfaceTab): string {
  return `build-surface-${tab}`;
}

export function BuildSurfaceTabs({
  active,
  onChange,
  mountedPanels,
}: {
  active: BuildSurfaceTab | null;
  onChange: (tab: BuildSurfaceTab) => void;
  mountedPanels?: ReadonlySet<BuildSurfaceTab>;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const labelRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [labelPx, setLabelPx] = useState<Record<BuildSurfaceTab, number>>(FALLBACK_LABEL_PX);
  useLayoutEffect(() => {
    let live = true;
    const measure = () => {
      if (!live) return;
      const next = { ...FALLBACK_LABEL_PX };
      BUILD_SURFACE_TABS.forEach((tab, i) => {
        const width = labelRefs.current[i]?.offsetWidth ?? 0;
        if (width > 0) next[tab.id] = width;
      });
      setLabelPx((prev) =>
        BUILD_SURFACE_TABS.every((tab) => prev[tab.id] === next[tab.id]) ? prev : next,
      );
    };
    measure();
    void (typeof document !== "undefined" ? document.fonts?.ready : undefined)?.then(measure);
    return () => {
      live = false;
    };
  }, []);
  const widthOf = (tab: BuildSurfaceTab | null, selected: boolean) =>
    selected && tab ? selectedTabWidth(labelPx[tab]) : IDLE_PX;
  const activeIndex = Math.max(0, BUILD_SURFACE_TABS.findIndex((tab) => tab.id === active));
  const focusIndex = active === null ? 0 : activeIndex;
  const transition = `width ${SLIDE_MS}ms ${EASE}, padding ${SLIDE_MS}ms ${EASE}, color 200ms ease-out`;
  useEffect(() => {
    if (pendingFocus !== active) return;
    pendingFocus = null;
    refs.current[BUILD_SURFACE_TABS.findIndex((tab) => tab.id === active)]?.focus();
  }, [active]);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = BUILD_SURFACE_TABS.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last ? 0 : index + 1
        : event.key === "ArrowLeft"
          ? index === 0 ? last : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    pendingFocus = BUILD_SURFACE_TABS[next]!.id;
    onChange(pendingFocus);
  };

  return (
    <div
      role="tablist"
      aria-label="App workspace"
      className="relative inline-flex h-9 w-max shrink-0 items-center rounded-full border border-rule bg-white p-0.5"
    >
      <span
        aria-hidden
        data-testid="tab-indicator"
        data-hidden={active === null}
        className="pointer-events-none absolute left-0.5 top-0.5 h-[30px] rounded-full bg-bone ring-1 ring-inset ring-ink/10 motion-reduce:!transition-none"
        style={{
          width: widthOf(active, true),
          opacity: active === null ? 0 : 1,
          transform: `translateX(${indicatorOffset(activeIndex)}px)`,
          transition: `transform ${SLIDE_MS}ms ${EASE}, width ${SLIDE_MS}ms ${EASE}, opacity 200ms ease-out`,
        }}
      />
      {BUILD_SURFACE_TABS.map((tab, index) => {
        const selected = tab.id === active;
        const Icon = tab.icon;
        const next = BUILD_SURFACE_TABS[index + 1];
        const dividerVisible = !!next && !selected && next.id !== active;
        return (
          <div key={tab.id} className="flex items-center">
            <button
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`${buildSurfacePanelId(tab.id)}-tab`}
              aria-selected={selected}
              aria-controls={
                selected || mountedPanels?.has(tab.id) ? buildSurfacePanelId(tab.id) : undefined
              }
              aria-label={tab.label}
              tabIndex={index === focusIndex ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => move(event, index)}
              style={{ width: widthOf(tab.id, selected), transition }}
              className={cx(
                "relative z-10 inline-flex h-[30px] items-center gap-2 overflow-hidden whitespace-nowrap rounded-full text-[13px] font-medium motion-reduce:!transition-none",
                selected ? "pl-3 text-ink" : "pl-[7px] text-inkMuted hover:text-ink",
                FOCUS_RING,
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              <span
                ref={(el) => {
                  labelRefs.current[index] = el;
                }}
                aria-hidden
                data-shown={selected}
                className={cx(
                  "inline-block transition-[opacity,transform] motion-reduce:!transition-none",
                  selected
                    ? "translate-x-0 opacity-100 duration-[260ms] delay-[120ms] ease-out"
                    : "-translate-x-1 opacity-0 duration-100 ease-in",
                )}
              >
                {tab.label}
              </span>
            </button>
            {next && (
              <span
                aria-hidden
                className={cx(
                  "mx-0.5 h-4 w-px transition-colors duration-200",
                  dividerVisible ? "bg-rule" : "bg-transparent",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
