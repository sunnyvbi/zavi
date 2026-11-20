"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { apiFetch } from "@/lib/api";
import { dayKey, fullTimestamp } from "@/lib/workspace/dayLabels";
import { datetimeLocalToFutureIso, toDatetimeLocal } from "@/lib/datetimeLocal";
import { Banner } from "./settings/ConnectorTile";
import { SkeletonConnectorGrid } from "./Skeleton";
import { DayDivider } from "./DayDivider";
import { PostPreview } from "./PostPreview";
import { EmptyState, Pill } from "./agent/dashboard-ui";
import { IconButton, cx } from "./layout/shared";
import { socialPlatformLabel } from "./settings/socialConnectorRows";
import {
  bucketByDay,
  errorCopy,
  isEditable,
  statusTone,
  toCalendarPost,
  weekDays,
  type CalendarPost,
  type SocialPostRow,
} from "./socialPostRows";

const SELECT = "id, channel, status, scheduled_at, created_at, external_url, last_error, approved_payload_snapshot";

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function PostCard({ post, active, onClick }: { post: CalendarPost; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active || undefined}
      className={cx(
        "w-full rounded-cta border px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-bone",
        active ? "border-ink bg-bone" : "border-rule bg-white",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-ink">{socialPlatformLabel(post.channel)}</span>
        <span className="text-inkMuted">{timeOf(post.at)}</span>
        {(post.hasImage || post.hasVideo) && <span aria-label="has media">📎</span>}
      </div>
      <div className="mt-0.5 truncate text-inkMuted">{post.snippet || "(no text)"}</div>
      <div className="mt-1">
        <Pill tone={statusTone(post.status)}>{post.status}</Pill>
      </div>
    </button>
  );
}

function PostDetail({
  post,
  onChanged,
}: {
  post: CalendarPost;
  onChanged: () => void;
}) {
  const [when, setWhen] = useState(() => {
    const d = new Date(post.scheduledAt ?? "");
    return Number.isNaN(d.getTime()) ? "" : toDatetimeLocal(d);
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const d = new Date(post.scheduledAt ?? "");
    setWhen(Number.isNaN(d.getTime()) ? "" : toDatetimeLocal(d));
    setErr(null);
  }, [post.id, post.scheduledAt]);

  async function call(path: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(`/api/social/posts/${post.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setErr(data?.error?.message ?? `Request failed (${res.status}).`);
        return false;
      }
      return true;
    } catch {
      setErr("Network error. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const editable = isEditable(post.status);
  const failure = errorCopy(post.lastError);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={statusTone(post.status)}>{post.status}</Pill>
        <span className="text-[12px] text-inkMuted">{fullTimestamp(post.at)}</span>
        {post.externalUrl && (
          <a
            href={post.externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[12px] font-medium text-[#2e7d32] underline"
          >
            Posted ↗
          </a>
        )}
      </div>

      {post.status === "failed" && failure && (
        <Banner tone="error" title="This post didn't publish">
          {failure}
        </Banner>
      )}

      <PostPreview channel={post.channel} payload={post.payload} scheduledAt={post.scheduledAt} />

      {editable && (
        <div className="rounded-lg border border-ink/10 bg-bone/60 p-3">
          <div className="mb-2 text-[12px] font-semibold text-ink">Move or cancel</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="datetime-local"
              aria-label="New publish time"
              value={when}
              min={toDatetimeLocal(new Date())}
              onChange={(e) => {
                setWhen(e.target.value);
                setErr(null);
              }}
              disabled={busy}
              className="rounded-md border border-ink/15 bg-white px-2 py-1 text-[12px] text-ink outline-none disabled:opacity-50"
            />
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const parsed = datetimeLocalToFutureIso(when);
                if ("error" in parsed) {
                  setErr(parsed.error);
                  return;
                }
                if (await call("reschedule", { scheduled_at: parsed.iso })) onChanged();
              }}
              className="inline-flex items-center rounded-cta bg-ink px-3 py-1.5 text-[12px] font-medium text-white shadow-sm hover:bg-inkSoft disabled:opacity-50"
            >
              {busy ? "…" : "Reschedule"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm("Cancel this post? It won't be published.")) return;
                if (await call("cancel")) onChanged();
              }}
              className="text-[12px] text-rose-700 underline disabled:opacity-50"
            >
              Cancel post
            </button>
          </div>
          {err && (
            <div role="alert" className="mt-2 text-[11px] text-rose-700">
              {err}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CalendarTab() {
  const [rows, setRows] = useState<SocialPostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [anchor, setAnchor] = useState(() => new Date());
  const [view, setView] = useState<"week" | "list">("week");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadError(false);
        const sb = createBrowserSupabase();
        const tenantId = await getActiveTenantId(sb);
        if (cancelled) return;
        if (!tenantId) {
          setLoadError(true);
          setLoading(false);
          return;
        }
        const res = await sb
          .from("social_posts")
          .select(SELECT)
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(500);
        if (cancelled) return;
        if (res.error) {
          setLoadError(true);
          setLoading(false);
          return;
        }
        setRows((res.data ?? []) as SocialPostRow[]);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setLoadError(true);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  const posts = useMemo(() => rows.map(toCalendarPost), [rows]);
  const byDay = useMemo(() => bucketByDay(posts), [posts]);
  const days = useMemo(() => weekDays(anchor), [anchor]);
  const selected = posts.find((p) => p.id === selectedId) ?? null;
  const todayKey = dayKey(new Date().toISOString());
  const weekLabel = `${days[0].toLocaleDateString([], { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString([], { month: "short", day: "numeric" })}`;

  const shift = (weeks: number) =>
    setAnchor((a) => {
      const d = new Date(a);
      d.setDate(d.getDate() + weeks * 7);
      return d;
    });

  const listDays = [...byDay.keys()].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1100px] px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-2">
            <h2 className="text-[20px] font-semibold leading-[28px] tracking-tight text-[#0e0f11]">Calendar</h2>
            <p className="text-[16px] leading-[20px] text-[#595959]">
              Every approved post, when it goes out, and what happened to it. Move or cancel one before it publishes.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <IconButton label="Previous week" className="size-8" onClick={() => shift(-1)}>‹</IconButton>
            <button
              type="button"
              onClick={() => setAnchor(new Date())}
              className="inline-flex h-8 items-center rounded-cta px-2 text-[12px] font-medium text-ink hover:bg-bone"
            >
              Today
            </button>
            <IconButton label="Next week" className="size-8" onClick={() => shift(1)}>›</IconButton>
            <span className="ml-2 text-[12px] text-inkMuted">{weekLabel}</span>
            <div className="ml-3 inline-flex rounded-full border border-rule p-0.5">
              {(["week", "list"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  className={cx(
                    "rounded-full px-2 py-0.5 text-[12px] capitalize",
                    view === v ? "bg-ink text-white" : "text-inkMuted hover:bg-bone",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="mt-8">
            <SkeletonConnectorGrid />
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-6">
            {loadError && (
              <Banner tone="warning" title="Couldn’t load your calendar">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>Nothing is lost. This is a display hiccup.</span>
                  <button
                    type="button"
                    onClick={reload}
                    className="shrink-0 rounded-cta border border-amber-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-amber-800 hover:bg-amber-100"
                  >
                    Retry
                  </button>
                </div>
              </Banner>
            )}

            {!loadError && posts.length === 0 && (
              <EmptyState title="Nothing on the calendar">
                Approve a social post (from chat or the composer) and it lands here with its publish time.
              </EmptyState>
            )}

            {posts.length > 0 && (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div>
                  {view === "week" ? (
                    <div className="grid grid-cols-7 gap-2">
                      {days.map((d) => {
                        const k = dayKey(d.toISOString());
                        const dayPosts = byDay.get(k) ?? [];
                        const isToday = k === todayKey;
                        return (
                          <div key={k} className="min-w-0">
                            <div
                              className={cx(
                                "mb-1.5 text-[11px] font-medium",
                                isToday ? "text-ink" : "text-inkMuted",
                              )}
                            >
                              {d.toLocaleDateString([], { weekday: "short" })}{" "}
                              <span className={cx(isToday && "rounded-full bg-ink px-1.5 py-0.5 text-white")}>
                                {d.getDate()}
                              </span>
                            </div>
                            <div className="flex min-h-[120px] flex-col gap-2 rounded-lg border border-dashed border-rule p-1.5">
                              {dayPosts.map((p) => (
                                <PostCard key={p.id} post={p} active={p.id === selectedId} onClick={() => setSelectedId(p.id)} />
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {listDays.map((k) => (
                        <div key={k} className="flex flex-col gap-2">
                          <DayDivider iso={byDay.get(k)![0].at} />
                          {byDay.get(k)!.map((p) => (
                            <PostCard key={p.id} post={p} active={p.id === selectedId} onClick={() => setSelectedId(p.id)} />
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <aside>
                  {selected ? (
                    <PostDetail
                      post={selected}
                      onChanged={() => {
                        setSelectedId(null);
                        reload();
                      }}
                    />
                  ) : (
                    <div className="rounded-lg border border-dashed border-rule p-4 text-[12px] text-inkMuted">
                      Pick a post to see it in full, move it, or cancel it.
                    </div>
                  )}
                </aside>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

