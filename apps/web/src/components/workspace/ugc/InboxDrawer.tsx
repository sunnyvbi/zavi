"use client";

import { useCallback, useEffect, useState } from "react";
import { jobRow, TONE, type Row } from "../layout/ChannelHumanLane";
import type { CreatorJobSummary, CreatorJobsResponse } from "@/components/humans/creatorJobTypes";
import { firstName, useUgcDrawer } from "./hub";
import { drawerFromLink, noticeIdsFor, readNotices } from "./NotificationBell";
import { Avatar, BTN, Bone, DrawerNote, SideDrawer, stamp } from "./ui";
import { callJson, useCreatorCards } from "./useCards";
import type { BusinessThreadSummary } from "./types";

type Notice = { id: string; link_path: string | null; read_at: string | null };

export type InboxJob = { job: CreatorJobSummary; row: Row };

export type InboxEntry = {
  human_member_id: string;
  name: string;
  thread: BusinessThreadSummary | null;
  jobs: InboxJob[];
  unread: string[];
  needsYou: boolean;
  lastAt: string;
};

export function buildInbox(
  threads: BusinessThreadSummary[],
  jobs: CreatorJobSummary[],
  notices: Notice[],
): InboxEntry[] {
  const by = new Map<string, InboxEntry>();
  const entry = (id: string, name: string): InboxEntry => {
    let e = by.get(id);
    if (!e) {
      e = { human_member_id: id, name, thread: null, jobs: [], unread: [], needsYou: false, lastAt: "" };
      by.set(id, e);
    }
    if (!e.name && name) e.name = name;
    return e;
  };
  const later = (a: string, b: string | null | undefined) => (b && b > a ? b : a);

  for (const t of threads) {
    const e = entry(t.human_member_id, t.display_name);
    e.thread = t;
    e.lastAt = later(e.lastAt, t.last_message_at);
  }
  const jobCreator = new Map<string, string>();
  for (const j of jobs) {
    if (!j.human_member_id) continue;
    const row = jobRow(j);
    if (!row) continue;
    const e = entry(j.human_member_id, j.creator_display_name ?? "");
    e.jobs.push({ job: j, row });
    e.lastAt = later(e.lastAt, j.closed_at ?? j.created_at);
    jobCreator.set(j.id, j.human_member_id);
  }
  for (const n of notices) {
    if (n.read_at || !n.link_path) continue;
    const d = drawerFromLink(n.link_path);
    const id = d?.params.creator ?? (d?.params.job ? jobCreator.get(d.params.job) : undefined);
    const e = id ? by.get(id) : undefined;
    if (e) e.unread.push(n.id);
  }

  const out = [...by.values()];
  for (const e of out) {
    e.jobs.sort((a, b) => Number(!!a.row.done) - Number(!!b.row.done) || (b.job.created_at > a.job.created_at ? 1 : -1));
    e.needsYou = e.unread.length > 0 || e.jobs.some((j) => j.row.tone === "action" && !j.row.done);
    if (!e.name) e.name = "Creator";
  }
  return out.sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || (b.lastAt > a.lastAt ? 1 : -1));
}

type Filter = "all" | "needs_you" | "active" | "done";

const FILTERS: { key: Filter; label: string; test: (e: InboxEntry) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "needs_you", label: "Needs you", test: (e) => e.needsYou },
  { key: "active", label: "Working", test: (e) => e.jobs.some((j) => !j.row.done) },
  { key: "done", label: "Finished work", test: (e) => e.jobs.some((j) => j.row.done && j.job.status === "completed") },
];

export function InboxDrawer() {
  const drawer = useUgcDrawer();
  const [entries, setEntries] = useState<InboxEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [notices, setNotices] = useState<Notice[]>([]);

  const load = useCallback(async () => {
    const [t, j, n] = await Promise.all([
      callJson<{ threads: BusinessThreadSummary[] }>("/api/creators/threads"),
      callJson<CreatorJobsResponse>("/api/humans/orders"),
      callJson<{ notifications: Notice[] }>("/api/humans/notifications"),
    ]);
    if (!t.ok || !j.ok) {
      setError(!j.ok ? j.message : !t.ok ? t.message : null);
      setEntries((prev) => prev ?? []);
      return;
    }
    setError(null);
    const list = n.ok ? n.data.notifications : [];
    setNotices(list);
    setEntries(buildInbox(t.data.threads, j.data.jobs ?? [], list));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const go = (e: InboxEntry, name: Row["drawer"] | "thread", params: Record<string, string>) => {
    const ids = noticeIdsFor(notices, name, params).filter((id) => e.unread.includes(id));
    void readNotices(ids);
    drawer.open(name, params);
  };

  const shown = (entries ?? []).filter(FILTERS.find((f) => f.key === filter)!.test);
  const cards = useCreatorCards((entries ?? []).map((e) => e.human_member_id));

  return (
    <SideDrawer title="Creators" onClose={drawer.close}>
      <p className="text-[14px] leading-relaxed text-inkMuted">
        Everyone you have messaged or booked, with their jobs. Message, review and follow up from here.
      </p>
      {entries && entries.length > 0 ? (
        <div role="group" aria-label="Filter creators" className="mt-3 flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const n = entries.filter(f.test).length;
            const on = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(f.key)}
                className={`inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-colors ${
                  on ? "border-ink bg-ink text-cream" : "border-rule bg-cream text-ink hover:bg-bone"
                }`}
              >
                {f.label}
                <span className={`tabular-nums ${on ? "text-cream/80" : "text-inkMuted"}`}>{n}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-4 grid gap-3">
        {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">Some of this did not load: {error}</p> : null}
        {!entries ? (
          <InboxSkeleton />
        ) : entries.length === 0 && !error ? (
          <DrawerNote>No creators yet. Message or book one from Find creators and they show here.</DrawerNote>
        ) : shown.length === 0 && entries.length > 0 ? (
          <DrawerNote>Nobody in this view right now.</DrawerNote>
        ) : (
          shown.map((e) => (
            <InboxCard key={e.human_member_id} entry={e} photoUrl={cards[e.human_member_id]?.photo_url ?? null} go={go} />
          ))
        )}
      </div>
    </SideDrawer>
  );
}

function InboxSkeleton() {
  return (
    <div role="status" aria-live="polite" className="grid gap-3">
      <span className="sr-only">Loading your creators.</span>
      {[0, 1].map((i) => (
        <div key={i} aria-hidden="true" className="rounded-2xl border border-rule bg-cream p-4">
          <div className="flex items-start gap-3">
            <Bone className="size-10 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <Bone className="h-4 w-32 rounded-md" />
              <Bone className="mt-2 h-3 w-20 rounded-md" />
              <Bone className="mt-3 h-3.5 w-4/5 rounded-md" />
            </div>
          </div>
          <div className="mt-3 grid gap-3 border-t border-rule pt-3">
            {[0, 1].map((j) => (
              <div key={j} className="flex items-center justify-between gap-3 px-2">
                <div className="min-w-0 flex-1">
                  <Bone className="h-3.5 w-2/5 rounded-md" />
                  <Bone className="mt-1.5 h-3 w-20 rounded-md" />
                </div>
                <Bone className="h-5 w-20 shrink-0 rounded-md" />
              </div>
            ))}
          </div>
          <Bone className="mt-3 h-9 w-32 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function InboxCard({
  entry: e,
  photoUrl,
  go,
}: {
  entry: InboxEntry;
  photoUrl: string | null;
  go: (e: InboxEntry, name: Row["drawer"] | "thread", params: Record<string, string>) => void;
}) {
  const first = firstName(e.name);
  const last = e.thread?.last_message ?? null;
  const toReview = e.jobs.find((j) => !j.row.done && j.row.drawer === "review");
  const doneCount = e.jobs.filter((j) => j.row.done && j.job.status === "completed").length;
  return (
    <div className="rounded-2xl border border-rule bg-cream p-4">
      <div className="flex items-start gap-3">
        <Avatar name={e.name} photoUrl={photoUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 break-words text-[14px] font-semibold text-ink">{e.name}</p>
            {e.unread.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-danger">
                <span aria-hidden className="h-2 w-2 rounded-full bg-danger" />
                New
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[13px] text-inkMuted">
            {e.jobs.length === 0
              ? "No jobs yet"
              : `${e.jobs.length} ${e.jobs.length === 1 ? "job" : "jobs"}${doneCount ? ` · ${doneCount} finished` : ""}`}
          </p>
          {last ? (
            <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-ink/80">
              <span className="font-medium text-ink">{last.sender_kind === "tenant" ? "You" : first}:</span> {last.body}
              <span className="text-inkLight"> · {stamp(last.created_at)}</span>
            </p>
          ) : (
            <p className="mt-2 text-[13px] text-inkMuted">No messages yet.</p>
          )}
        </div>
      </div>

      {e.jobs.length > 0 ? (
        <ul
          tabIndex={e.jobs.length > 5 ? 0 : undefined}
          aria-label={e.jobs.length > 5 ? `Jobs with ${e.name}` : undefined}
          className={`mt-3 grid gap-2 border-t border-rule pt-3 ${e.jobs.length > 5 ? "max-h-[280px] scrollbar-visible overflow-y-auto overscroll-contain pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30" : ""}`}
        >
          {e.jobs.map(({ job, row }) => (
            <li key={job.id}>
              <button
                type="button"
                onClick={() => go(e, row.drawer, row.params as Record<string, string>)}
                className="flex w-full flex-wrap items-center justify-between gap-2 rounded-cta px-2 py-1.5 text-left hover:bg-bone"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{job.title}</span>
                  {row.line ? <span className="block text-[12px] text-inkMuted">{row.line}</span> : null}
                </span>
                <span className={`shrink-0 rounded-md px-2 py-0.5 text-[12px] font-semibold ${TONE[row.tone]}`}>{row.status}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {toReview ? (
          <button
            type="button"
            onClick={() => go(e, "review", toReview.row.params as Record<string, string>)}
            className={`${BTN} bg-ink text-cream hover:bg-ink/85`}
          >
            Review delivery
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => go(e, "thread", { creator: e.human_member_id })}
          className={`${BTN} border border-rule bg-cream text-ink hover:bg-bone`}
        >
          Message {first}
        </button>
      </div>
    </div>
  );
}
