"use client";

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Lock } from "lucide-react";
import { channelMark } from "../channelMark";
import { cx, FOCUS_RING, prefersReducedMotion } from "./shared";
import {
  actionsNoun,
  OPEN_SECTIONS,
  sectionOf,
  Spinner,
  waitingLabel,
  type ChannelEntry,
} from "./ChannelsPage";
import { canReadChannel, needYouTally, UPGRADE_TO_START, visibleWaiting } from "./channelTally";
import { NextChevron } from "@/components/ui/NextChevron";

const SIZE = 760;
const RADIUS = 300;
const CROWDED_SIZE = 960;
const CROWDED_RADIUS = 390;
const CENTRE = 380;
const SWAY_DEG = 6;
const SWAY_PERIOD_MS = 8000;
const DRAG_SLOP_PX = 4;
const CROWDED = 16;
const LOUD_COUNT = 10;
const LEAVE_GRACE_MS = 350;
const SECTION_ARCS = [
  { key: "creators", label: "Creators", tint: "rgba(219, 39, 119, 0.12)", ink: "#be185d" },
  { key: "paid", label: "Paid ads", tint: "rgba(245, 158, 11, 0.16)", ink: "#b45309" },
] as const;

export function ChannelsWheel({
  entries: rawEntries,
  onOpen,
  onUpgrade,
  onPeek,
  loading = false,
}: {
  entries: ChannelEntry[];
  loading?: boolean;
  onOpen: (slug: string) => void;
  onUpgrade: (entry: ChannelEntry) => void;
  onPeek?: (entry: ChannelEntry) => void;
}) {
  const sectionIndex = (e: ChannelEntry) =>
    OPEN_SECTIONS.findIndex((sec) => sec.key === sectionOf(e.channel));
  const entries = [...rawEntries].sort((a, b) => sectionIndex(a) - sectionIndex(b));
  const [active, setActive] = useState<string | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const cancelLeave = () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  const scheduleLeave = () => {
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      setActive(null);
    }, LEAVE_GRACE_MS);
  };
  useEffect(() => cancelLeave, []);
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;
  const ringRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const sizeRef = useRef(SIZE);

  const offsetRef = useRef(0);
  const dragRef = useRef<{ angle: number; x: number; y: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const swallowClickRef = useRef(false);

  useEffect(() => {
    const sway = prefersReducedMotion() ? 0 : SWAY_DEG;
    let raf = 0;
    let last: number | null = null;
    let t = 0;
    const tick = (now: number) => {
      const dt = last === null ? 0 : now - last;
      last = now;
      if (activeRef.current === null && dragRef.current === null) t += dt;
      const deg = offsetRef.current + sway * Math.sin((2 * Math.PI * t) / SWAY_PERIOD_MS);
      ringRef.current?.style.setProperty("--spin", `${deg}deg`);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const pointerAngle = (x: number, y: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return (Math.atan2(y - (r.top + r.height / 2), x - (r.left + r.width / 2)) * 180) / Math.PI;
  };

  const onDragStart = (e: ReactPointerEvent) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    if ((e.target as Element).closest?.("[data-wheel-centre]")) return;
    dragRef.current = { angle: pointerAngle(e.clientX, e.clientY), x: e.clientX, y: e.clientY, moved: false };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < DRAG_SLOP_PX) return;
      if (!d.moved) {
        d.moved = true;
        setDragging(true);
      }
      const a = pointerAngle(ev.clientX, ev.clientY);
      const delta = ((a - d.angle + 540) % 360) - 180;
      d.angle = a;
      offsetRef.current = (offsetRef.current + delta) % 360;
    };
    const up = () => {
      swallowClickRef.current = dragRef.current?.moved ?? false;
      setTimeout(() => {
        swallowClickRef.current = false;
      }, 0);
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const { width, height } = box.getBoundingClientRect();
      if (width > 0 && height > 0) setScale(Math.min(1, width / sizeRef.current, height / sizeRef.current));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [entries.length > CROWDED, loading]);

  const crowded = entries.length > CROWDED;
  const node = crowded ? 80 : 96;
  const size = crowded ? CROWDED_SIZE : SIZE;
  const radius = crowded ? CROWDED_RADIUS : RADIUS;
  const tally = needYouTally(entries);
  const open = entries.filter((e) => canReadChannel(e) && e.waiting > 0);
  const openItems = open.reduce((sum, e) => sum + e.waiting, 0);
  sizeRef.current = size;
  const shown = entries.find((e) => e.channel.slug === active) ?? null;
  const step = 360 / Math.max(1, entries.length);
  const arcs = SECTION_ARCS.flatMap((sec) => {
    const idx = entries.flatMap((e, i) => (sectionOf(e.channel) === sec.key ? [i] : []));
    return idx.length > 0 && idx.length < entries.length
      ? [{ ...sec, from: (idx[0]! - 0.5) * step, to: (idx[idx.length - 1]! + 0.5) * step }]
      : [];
  });

  if (loading) {
    return (
      <div role="status" className="flex min-h-[320px] flex-1 items-center justify-center text-[14px] text-inkMuted">
        <Spinner className="mr-2" />
        Loading channels
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      onMouseLeave={() => {
        cancelLeave();
        setActive(null);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(null);
      }}
      onPointerDown={onDragStart}
      onClickCapture={(e) => {
        if (!swallowClickRef.current) return;
        swallowClickRef.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      className={cx(
        "relative min-h-[320px] flex-1 select-none overflow-hidden",
        dragging ? "cursor-grabbing" : "cursor-grab",
      )}
    >
      {}
      <div
        className="absolute left-1/2 top-1/2"
        style={{
          width: size,
          height: size,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        <div
          aria-hidden
          className="absolute rounded-full border border-dashed border-rule"
          style={{
            left: size / 2 - radius,
            top: size / 2 - radius,
            width: radius * 2,
            height: radius * 2,
          }}
        />
        <div
          aria-live="polite"
          data-wheel-centre
          onPointerEnter={(e) => {
            if (e.pointerType !== "touch" && active !== null) cancelLeave();
          }}
          onPointerLeave={(e) => {
            if (e.pointerType !== "touch" && active !== null) scheduleLeave();
          }}
          className="absolute flex flex-col items-center justify-center rounded-full bg-cream text-center shadow-elev ring-1 ring-rule"
          style={{
            left: size / 2 - CENTRE / 2,
            top: size / 2 - CENTRE / 2,
            width: CENTRE,
            height: CENTRE,
          }}
        >
          {shown ? (
            <Centre entry={shown} onOpen={onOpen} onUpgrade={onUpgrade} />
          ) : tally.lockedOnly ? (
            <div className="px-10">
              <p data-wheel-upgrade className="text-[22px] font-extrabold leading-7 text-ink">
                {UPGRADE_TO_START}
              </p>
              <p className="mt-3 text-[14px] text-inkLight">
                Point at a channel to see what Zavi wants to do.
              </p>
            </div>
          ) : (
            <div className="px-10">
              <p className="text-[44px] font-extrabold leading-none text-ink [font-variant-numeric:tabular-nums]">
                {openItems}
              </p>
              <p className="mt-1 text-[16px] font-semibold text-inkMuted">
                {open.length > 0
                  ? `${openItems === 1 ? "action" : "actions"} across ${open.length} ${open.length === 1 ? "channel" : "channels"}`
                  : "actions waiting"}
              </p>
              <p className="mt-3 text-[14px] text-inkLight">
                Point at a channel to see what Zavi wants to do.
              </p>
            </div>
          )}
        </div>
        <div
          ref={ringRef}
          className="pointer-events-none absolute inset-0"
          style={{ transform: "rotate(var(--spin, 0deg))" }}
        >
          {arcs.map((a) => (
            <SectionArc key={a.key} arc={a} size={size} radius={radius} band={node + 28} />
          ))}
          {entries.map((entry, i) => {
            const angle = ((i / entries.length) * 360 - 90) * (Math.PI / 180);
            const x = size / 2 + radius * Math.cos(angle);
            const y = size / 2 + radius * Math.sin(angle);
            return (
              <WheelNode
                key={entry.channel.slug}
                entry={entry}
                x={x}
                y={y}
                size={node}
                compact={crowded}
                on={active === entry.channel.slug}
                dim={active !== null && active !== entry.channel.slug}
                onLeave={scheduleLeave}
                onActive={() => {
                  cancelLeave();
                  if (active !== entry.channel.slug && canReadChannel(entry)) onPeek?.(entry);
                  setActive(entry.channel.slug);
                }}
                onOpen={() => onOpen(entry.channel.slug)}
                onUpgrade={() => onUpgrade(entry)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SectionArc({
  arc,
  size,
  radius,
  band,
}: {
  arc: { from: number; to: number; label: string; tint: string; ink: string };
  size: number;
  radius: number;
  band: number;
}) {
  const c = size / 2;
  const at = (deg: number, r: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [c + r * Math.cos(rad), c + r * Math.sin(rad)] as const;
  };
  const [x1, y1] = at(arc.from, radius);
  const [x2, y2] = at(arc.to, radius);
  const large = arc.to - arc.from > 180 ? 1 : 0;
  const mid = (arc.from + arc.to) / 2;
  const [lx, ly] = at(mid, radius - band / 2 - 22);
  return (
    <>
      <svg aria-hidden className="absolute inset-0" width={size} height={size}>
        <path
          d={`M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`}
          fill="none"
          stroke={arc.tint}
          strokeWidth={band}
          strokeLinecap="round"
        />
      </svg>
      <span
        aria-hidden
        className="absolute whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12px] font-bold uppercase tracking-wide [html.dark_&]:brightness-150"
        style={{
          left: lx,
          top: ly,
          color: arc.ink,
          background: arc.tint,
          transform: "translate(-50%, -50%) rotate(calc(-1 * var(--spin, 0deg)))",
        }}
      >
        {arc.label}
      </span>
    </>
  );
}

function Mark({ slug, px }: { slug: string; px: number }) {
  const mark = channelMark(slug);
  const inner = Math.round(px * 0.52);
  return (
    <span
      className={cx("flex items-center justify-center overflow-hidden rounded-full", mark.bg)}
      style={{ width: px, height: px }}
    >
      {mark.kind === "glyph" ? (
        <mark.Icon className={mark.fg} style={{ width: inner, height: inner }} aria-hidden />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          draggable={false}
          src={mark.src}
          alt=""
          className={mark.fit === "cover" ? "h-full w-full object-cover" : "object-contain"}
          style={mark.fit === "cover" ? undefined : { width: inner, height: inner }}
        />
      )}
    </span>
  );
}

function WheelNode({
  entry,
  x,
  y,
  size,
  compact,
  on,
  dim,
  onActive,
  onLeave,
  onOpen,
  onUpgrade,
}: {
  entry: ChannelEntry;
  x: number;
  y: number;
  size: number;
  compact: boolean;
  on: boolean;
  dim: boolean;
  onActive: () => void;
  onLeave: () => void;
  onOpen: () => void;
  onUpgrade: () => void;
}) {
  const { channel, subtitle } = entry;
  const lock = canReadChannel(entry) ? null : entry.lock;
  const waiting = visibleWaiting(entry);
  const touch = useRef(false);
  const wasOn = useRef(false);
  const inert = lock?.kind === "soon";
  const label = lock
    ? lock.kind === "plan"
      ? `Needs ${lock.label}`
      : "Coming soon"
    : waiting > 0
      ? null
      : subtitle;
  return (
    <button
      type="button"
      data-channel-slug={channel.slug}
      aria-disabled={inert ? "true" : undefined}
      aria-label={`${channel.name}${waiting > 0 ? `, ${actionsNoun(waiting)} waiting` : ""}${lock ? `, ${label}` : ""}`}
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") onActive();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") onLeave();
      }}
      onFocus={onActive}
      onPointerDown={(e) => {
        touch.current = e.pointerType === "touch";
        wasOn.current = on;
      }}
      onClick={() => {
        const tapped = touch.current;
        touch.current = false;
        if (tapped && !wasOn.current) return onActive();
        if (inert) return;
        if (lock) onUpgrade();
        else onOpen();
      }}
      className={cx(
        "pointer-events-auto absolute flex flex-col items-center rounded-full",
        inert ? "cursor-default" : "cursor-pointer",
        FOCUS_RING,
      )}
      style={{
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        transform: `rotate(calc(-1 * var(--spin, 0deg))) scale(${on ? 1.28 : 1})`,
        opacity: dim ? 0.45 : 1,
        zIndex: on ? 10 : 1,
        transition: "opacity 180ms ease",
      }}
    >
      <span
        className={cx(
          "relative flex items-center justify-center rounded-full bg-cream shadow-lift ring-1",
          on ? "ring-ink" : "ring-rule",
        )}
        style={{ width: size, height: size }}
      >
        <span className={cx(lock?.kind === "soon" && "opacity-50 grayscale")}>
          <Mark slug={channel.slug} px={Math.round(size * 0.62)} />
        </span>
        {waiting > 0 && !lock && (
          <span
            data-wheel-badge
            className={cx(
              "absolute -right-1 -top-1 grid h-7 min-w-7 place-items-center rounded-full px-1.5 text-[13px] font-bold ring-2 ring-cream [font-variant-numeric:tabular-nums]",
              waiting >= LOUD_COUNT ? "text-white" : "bg-ink text-cream",
            )}
            style={waiting >= LOUD_COUNT ? { background: "#e5484d" } : undefined}
          >
            {waitingLabel(waiting)}
          </span>
        )}
        {lock && (
          <span className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-full border-2 border-cream bg-bone text-inkMuted">
            <Lock className="h-3 w-3" aria-hidden />
          </span>
        )}
      </span>
      <span
        className={cx(
          "mt-2 max-w-[112px] truncate text-[13px] font-semibold",
          on ? "text-ink" : "text-inkMuted",
        )}
      >
        {channel.name}
      </span>
      {label && !compact && (
        <span className="whitespace-nowrap text-[12px] text-inkLight">{label}</span>
      )}
    </button>
  );
}

function Centre({
  entry,
  onOpen,
  onUpgrade,
}: {
  entry: ChannelEntry;
  onOpen: (slug: string) => void;
  onUpgrade: (entry: ChannelEntry) => void;
}) {
  const { channel, topAction, subtitle } = entry;
  const lock = canReadChannel(entry) ? null : entry.lock;
  const waiting = visibleWaiting(entry);
  return (
    <div key={channel.slug} className="flex w-full flex-col items-center px-10">
      <Mark slug={channel.slug} px={64} />
      <p className="mt-3 text-[24px] font-bold leading-8 text-ink">{channel.name}</p>
      <p className="text-[14px] font-semibold text-inkMuted">
        {waiting > 0 ? `${waitingLabel(waiting)} ${waiting === 1 ? "action" : "actions"} waiting` : (subtitle ?? (entry.waiting > 0 ? "Open channel" : "Nothing waiting yet"))}
      </p>
      {lock?.kind === "soon" ? (
        <p className="mt-4 text-[14px] text-inkLight">Coming soon</p>
      ) : lock?.kind === "plan" ? (
        <button
          type="button"
          onClick={() => onUpgrade(entry)}
          className={cx(
            "mt-4 inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2.5 text-[14px] font-semibold text-cream hover:bg-black",
            FOCUS_RING,
          )}
        >
          <Lock className="h-4 w-4" aria-hidden />
          {`Upgrade to ${lock.label}`}
        </button>
      ) : (
        <>
          {topAction && (
            <div className="mt-4 w-full rounded-xl border border-rule bg-creamDeep px-4 py-3 text-left">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-inkLight">
                What Zavi wants to do
              </p>
              <p className="mt-1 line-clamp-3 text-[14px] font-semibold leading-snug text-ink">
                {topAction}
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={() => onOpen(channel.slug)}
            className={cx(
              "mt-4 inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2.5 text-[14px] font-semibold text-cream hover:bg-black",
              FOCUS_RING,
            )}
          >
            {`Open ${channel.name}`}
            <NextChevron />
          </button>
        </>
      )}
    </div>
  );
}
