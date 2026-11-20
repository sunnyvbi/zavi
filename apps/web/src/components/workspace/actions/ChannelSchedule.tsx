"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { ApiError } from "@/lib/workspace/channelActionsApi";
import { isDraftActionType } from "@zavi/shared";
import { mediaOf, type ActionItem } from "./types";
import { btn } from "./ui";
import { useChannelPlanLock } from "./channelPlanLock";
import { localDay, parseDay, timeLabel } from "./scheduleTime";

export { localDay };

export function weekDays(today: Date, weeks = 1): string[] {
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  return Array.from({ length: 7 * weeks }, (_, i) =>
    localDay(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)),
  );
}

export function dayParts(day: string): { dow: string; date: string } {
  const d = parseDay(day);
  return {
    dow: d.toLocaleDateString("en-US", { weekday: "short" }),
    date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  };
}

function dayLabel(day: string): string {
  const p = dayParts(day);
  return `${p.dow} ${p.date}`;
}

export type MovePlanResult = {
  plan_day: string | null;
  plan_time?: string | null;
  plan_timezone?: string | null;
};

export async function movePlanDay(a: ActionItem, day: string | null, time?: string): Promise<MovePlanResult> {
  const res = await apiFetch(`/api/channels/actions/${encodeURIComponent(a.id)}/publish-on`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publish_on: day, ...(day && time ? { publish_time: time } : {}) }),
  });
  const data = (await res.json().catch(() => null)) as
    | { plan_day?: string | null; plan_time?: string | null; plan_timezone?: string | null; error?: { message?: string } }
    | null;
  if (!res.ok) throw new ApiError(data?.error?.message ?? `Could not move this post. (HTTP ${res.status})`, res.status, data);
  return {
    plan_day: data && "plan_day" in data ? (data.plan_day ?? null) : day,
    ...(data && "plan_time" in data ? { plan_time: data.plan_time ?? null } : {}),
    ...(data && "plan_timezone" in data ? { plan_timezone: data.plan_timezone ?? null } : {}),
  };
}

export function DayPicker({
  action,
  today,
  onMove,
  onDone,
}: {
  action: ActionItem;
  today: Date;
  onMove: (a: ActionItem, day: string | null) => Promise<string | null>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const todayKey = localDay(today);
  const pick = async (day: string | null) => {
    setBusy(true);
    setError(null);
    const err = await onMove(action, day);
    setBusy(false);
    if (err) setError(err);
    else onDone();
  };
  const days = weekDays(today, 2);
  return (
    <div data-testid="day-picker" className="mt-2 rounded-xl border border-ca-border bg-ca-subtle px-3 py-2.5">
      <p className="text-[13px] font-semibold text-ca-xdark">Pick a day</p>
      {[days.slice(0, 7), days.slice(7)].map((week, w) => (
        <div key={w} className="mt-1.5 flex flex-wrap gap-2">
          <span className="w-[68px] shrink-0 self-center text-[12px] text-ca-secondary">{w === 0 ? "This week" : "Next week"}</span>
          {week.map((d) => (
            <button
              key={d}
              type="button"
              disabled={busy || d < todayKey}
              aria-pressed={action.plan_day === d || undefined}
              onClick={() => void pick(d)}
              className={`rounded-cta border px-2 py-1 text-[12px] font-medium disabled:opacity-40 ${
                action.plan_day === d
                  ? "border-ca-action bg-ca-action text-ca-on-action"
                  : d === todayKey
                    ? "border-ca-action bg-ca-bg text-ca-xdark"
                    : "border-ca-border bg-ca-bg text-ca-dark hover:border-ca-action"
              }`}
            >
              {dayLabel(d)}
            </button>
          ))}
        </div>
      ))}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {action.plan_day && (
          <button type="button" disabled={busy} onClick={() => void pick(null)} className="text-[13px] font-medium text-ca-secondary underline-offset-2 hover:underline">
            Take off the calendar
          </button>
        )}
        <button type="button" disabled={busy} onClick={onDone} className="text-[13px] font-medium text-ca-secondary underline-offset-2 hover:underline">
          Cancel
        </button>
        {busy && <span role="status" className="text-[13px] text-ca-secondary">Moving…</span>}
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-[13px] leading-5 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function PlanDayLine({ action }: { action: ActionItem }) {
  if (!isDraftActionType(action.action_type) || action.status !== "pending" || !action.plan_day) return null;
  const queued = action.plan_day_source === "scheduled";
  return (
    <p data-testid="plan-day-line" className="mb-2 flex flex-wrap items-center gap-2 text-[13px] text-ca-secondary">
      <CalendarDays className="h-4 w-4 shrink-0" aria-hidden />
      <span>
        {queued ? "Goes out" : "Planned for"} <b className="font-semibold text-ca-xdark">{dayLabel(action.plan_day)}</b>
        {queued && action.plan_time ? ` at ${timeLabel(action.plan_time)}` : ""}
      </span>
    </p>
  );
}

type EventState = "queued" | "waiting" | "planned";

const EVENT_STATUS: Record<EventState, string> = {
  queued: "Scheduled to post",
  waiting: "Waiting for your OK",
  planned: "Planned",
};

const SECTION = "mt-5 rounded-2xl border border-ca-border bg-ca-bg px-4 py-4";

export function ThisWeekCalendar({
  cards,
  today = new Date(),
  needsOk,
  onOpen,
  onMove,
}: {
  cards: ActionItem[];
  today?: Date;
  needsOk: (a: ActionItem) => boolean;
  onOpen: (id: string) => void;
  onMove: (a: ActionItem, day: string | null) => Promise<string | null>;
}) {
  const [moving, setMoving] = useState<string | null>(null);
  const planLock = useChannelPlanLock();
  const toggleMoving = (id: string) =>
    planLock?.tierName ? planLock.upgrade() : setMoving((m) => (m === id ? null : id));
  const days = weekDays(today);
  const todayKey = localDay(today);
  const inWeek = cards.filter((c) => c.plan_day && days.includes(c.plan_day));
  const stateOf = (c: ActionItem): EventState =>
    c.plan_day_source === "scheduled" ? "queued" : needsOk(c) ? "waiting" : "planned";
  const waiting = inWeek.filter((c) => stateOf(c) === "waiting").length;
  const anySeries = cards.some((c) => c.series);
  const reelMode = inWeek.some((c) => mediaOf(c)?.kind === "video");
  const scroller = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el || !reelMode) return setEdges({ left: false, right: false });
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, [reelMode]);
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);
  const slide = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * 340, behavior: "smooth" });
  return (
    <section data-testid="this-week" aria-label="This week" className={SECTION}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[16px] font-semibold text-ca-xdark">This week</h3>
        {inWeek.length > 0 && (
          <p data-testid="week-count" className="text-[13px] text-ca-secondary">
            {inWeek.length} planned{waiting > 0 ? `, ${waiting} waiting for your OK` : ""}
          </p>
        )}
      </div>
      <div className="mt-3 [container-type:inline-size]">
        <div className="relative">
        {reelMode && edges.left && (
          <button
            type="button"
            aria-label="Earlier days"
            data-testid="week-prev"
            onClick={() => slide(-1)}
            className="absolute left-1 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white shadow-lg ring-1 ring-white/20 backdrop-blur-md hover:bg-black/80"
          >
            <ChevronLeft aria-hidden className="h-5 w-5" />
          </button>
        )}
        {reelMode && edges.right && (
          <button
            type="button"
            aria-label="Later days"
            data-testid="week-next"
            onClick={() => slide(1)}
            className="absolute right-1 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white shadow-lg ring-1 ring-white/20 backdrop-blur-md hover:bg-black/80"
          >
            <ChevronRight aria-hidden className="h-5 w-5" />
          </button>
        )}
        <div
          ref={scroller}
          onScroll={measure}
          data-testid="week-grid"
          data-reels={reelMode ? "true" : undefined}
          className={reelMode ? "flex snap-x gap-2 overflow-x-auto scroll-smooth pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "grid grid-cols-1 gap-2 [@container(min-width:720px)]:grid-cols-7"}
        >
          {days.map((d) => {
            const list = inWeek.filter((c) => c.plan_day === d);
            const isToday = d === todayKey;
            const p = dayParts(d);
            return (
              <div
                key={d}
                data-testid={`day-${d}`}
                data-today={isToday || undefined}
                className={`${
                  reelMode
                    ? "flex w-[160px] shrink-0 flex-col gap-2 min-h-[112px]"
                    : "flex min-w-0 gap-3 [@container(min-width:720px)]:min-h-[112px] [@container(min-width:720px)]:flex-col [@container(min-width:720px)]:gap-2"
                } rounded-xl border px-2.5 py-2 ${
                  isToday ? "border-ca-strong bg-ca-action/[0.07]" : list.length ? "border-ca-border bg-ca-bg" : "border-dashed border-ca-border bg-ca-subtle"
                }`}
              >
                <p className={`flex w-[74px] shrink-0 flex-wrap items-center gap-1.5 pt-0.5 text-[12px] font-semibold [@container(min-width:720px)]:w-auto [@container(min-width:720px)]:pt-0 ${isToday ? "text-ca-xdark" : "text-ca-secondary"}`}>
                  <span>
                    {p.dow} {p.date}
                  </span>
                  {isToday && (
                    <span data-testid="today-tag" className="rounded-md bg-ca-action px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-ca-on-action">
                      Today
                    </span>
                  )}
                </p>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {list.length === 0 && <p className="text-[12px] text-ca-secondary">Nothing planned</p>}
                  {list.map((c) => {
                    const st = stateOf(c);
                    const tone = c.series ? "bg-planSeriesBg text-planSeries" : "bg-planPostBg text-planPost";
                    const reel = mediaOf(c);
                    if (reel?.kind === "video") {
                      return (
                        <div
                          key={c.id}
                          data-testid={`event-${c.id}`}
                          data-kind={c.series ? "series" : "post"}
                          data-state={st}
                          className="relative mx-auto w-full max-w-[136px]"
                        >
                          <button
                            type="button"
                            onClick={() => onOpen(c.id)}
                            aria-label={`${c.title} · ${EVENT_STATUS[st]}`}
                            title={c.title}
                            data-testid={`event-video-${c.id}`}
                            className={`relative block aspect-[9/16] max-h-[242px] w-full overflow-hidden rounded-cta bg-black shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:shadow-[0_0_28px_rgba(255,255,255,0.35)] ${
                              st === "waiting" ? "outline-dashed outline-2 outline-offset-2 outline-planPost" : "ring-1 ring-planPost/40"
                            }`}
                          >
                            <video src={reel.url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                          </button>
                          <button
                            type="button"
                            aria-expanded={moving === c.id}
                            onClick={() => toggleMoving(c.id)}
                            className="absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm hover:bg-black/80"
                          >
                            Move
                          </button>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={c.id}
                        data-testid={`event-${c.id}`}
                        data-kind={c.series ? "series" : "post"}
                        data-state={st}
                        className={`min-w-0 rounded-lg border px-2 py-1.5 text-[12px] leading-snug ${tone} ${
                          st === "waiting" ? "border-dashed border-current" : "border-transparent"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => onOpen(c.id)}
                          className="block w-full text-left font-semibold [overflow-wrap:anywhere] hover:underline"
                        >
                          {c.title}
                        </button>
                        <p className="mt-0.5 text-[11px] font-semibold opacity-90">{EVENT_STATUS[st]}</p>
                        <button
                          type="button"
                          aria-expanded={moving === c.id}
                          onClick={() => toggleMoving(c.id)}
                          className="mt-1 rounded-cta border border-ca-border bg-ca-bg px-1.5 py-px text-[11px] font-semibold text-ca-xdark"
                        >
                          Move
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        </div>
      </div>
      {moving && cards.find((c) => c.id === moving) && (
        <DayPicker action={cards.find((c) => c.id === moving)!} today={today} onMove={onMove} onDone={() => setMoving(null)} />
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ca-secondary">
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-planPost" aria-hidden /> One-off post
        </span>
        {anySeries && (
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-[3px] bg-planSeries" aria-hidden /> Series episode
          </span>
        )}
        <span>Dashed = waiting for your OK</span>
      </div>
    </section>
  );
}

type Episode = { n: number; title: string; card: ActionItem | null };
type SeriesView = { id: string; name: string; format: string; episodes: Episode[] };

export function groupSeries(cards: ActionItem[]): SeriesView[] {
  const byId = new Map<string, ActionItem[]>();
  for (const c of cards) {
    if (!c.series?.id) continue;
    byId.set(c.series.id, [...(byId.get(c.series.id) ?? []), c]);
  }
  return Array.from(byId.values()).map((members) => {
    const sorted = [...members].sort((a, b) => (a.series!.episode ?? 0) - (b.series!.episode ?? 0));
    const latest = sorted[sorted.length - 1]!.series!;
    const taken = new Set(sorted.map((c) => c.series!.episode));
    const episodes: Episode[] = sorted.map((c) => ({ n: c.series!.episode, title: c.title, card: c }));
    (latest.next ?? []).forEach((title, i) => {
      const n = latest.episode + i + 1;
      if (!taken.has(n) && title.trim()) episodes.push({ n, title, card: null });
    });
    return { id: latest.id, name: latest.name, format: latest.format, episodes };
  });
}

export function SeriesSection({
  cards,
  channelName,
  onOpen,
  onWrite,
}: {
  cards: ActionItem[];
  channelName: string;
  onOpen: (id: string) => void;
  onWrite?: (
    series: { name: string; format: string },
    episode: { n: number; title: string },
    onStarted: () => void,
  ) => void;
}) {
  const [asked, setAsked] = useState<ReadonlySet<string>>(() => new Set());
  const series = groupSeries(cards);
  if (series.length === 0) return null;
  return (
    <section data-testid="series" aria-label="Series" className={SECTION}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[16px] font-semibold text-ca-xdark">Series</h3>
        <p className="text-[13px] text-ca-secondary">{series.length ? `${series.length} running` : `None on ${channelName}`}</p>
      </div>
      {series.length === 0 ? (
        <p data-testid="series-empty" className="mt-2 text-[13px] leading-5 text-ca-secondary">
          {channelName} posts are one-offs right now. When Zavi plans a repeating format here, its episodes show in this spot.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {series.map((s) => {
            const written = s.episodes.filter((e) => e.card).length;
            return (
              <div key={s.id} data-testid={`series-${s.id}`} className="rounded-xl border border-ca-border px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-[3px] bg-planSeries" aria-hidden />
                  <span className="text-[14px] font-semibold text-ca-xdark">{s.name}</span>
                  <span className="ml-auto text-[12px] text-ca-secondary">
                    {written} drafted, {s.episodes.length - written} planned
                  </span>
                </div>
                {s.format && (
                  <p className="mt-1 text-[13px] text-ca-dark">
                    <b className="font-semibold text-ca-xdark">Format:</b> {s.format}
                  </p>
                )}
                <ul className="mt-2 flex flex-col">
                  {s.episodes.map((e) => {
                    const key = `${s.id}:${e.n}`;
                    const status = e.card
                      ? e.card.plan_day
                        ? `Draft ready, planned ${dayParts(e.card.plan_day).dow}`
                        : "Draft ready"
                      : asked.has(key)
                        ? "Asked Zavi in chat"
                        : "Planned, not written yet";
                    return (
                      <li
                        key={key}
                        data-testid={`episode-${key}`}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ca-border py-2 first:border-t-0"
                      >
                        <span className="w-[44px] shrink-0 text-[12px] font-semibold text-ca-secondary">Ep {e.n}</span>
                        <span className="min-w-[160px] flex-1 text-[14px] text-ca-xdark [overflow-wrap:anywhere]">{e.title}</span>
                        <span className="text-[12px] text-ca-secondary">{status}</span>
                        {e.card ? (
                          <button type="button" className={btn.secondary} onClick={() => onOpen(e.card!.id)}>
                            Open draft
                          </button>
                        ) : onWrite && !asked.has(key) ? (
                          <button
                            type="button"
                            className={btn.secondary}
                            onClick={() =>
                              onWrite({ name: s.name, format: s.format }, { n: e.n, title: e.title }, () =>
                                setAsked((prev) => new Set(prev).add(key)),
                              )
                            }
                          >
                            Write it now
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function writeEpisodeRequest(series: { name: string; format: string }, ep: { n: number; title: string }): string {
  return `Write episode ${ep.n} of the "${series.name}" series now: ${ep.title}.${series.format ? ` Same format as the others (${series.format}).` : ""}`;
}
