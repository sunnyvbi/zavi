"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Pencil, Search, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { agentDisplayName } from "@/lib/agentRegistry";
import { memoryApi, type ConflictPair, type MemoryApi, type MemoryWriteItem } from "@/lib/memory/writesApi";
import { isChannelSlug } from "@zavi/shared";
import { dropCachedNote } from "@/lib/memory/useMemoryWrites";
import { smallBtn } from "./RememberedPill";
import { FORGET_NOTES, HIDDEN_MODES, UNDOABLE_MODES, useForgetWithUndo } from "./useForgetWithUndo";

export type MemoryNoteRow = {
  id: string;
  title: string;
  body_markdown: string;
  source: string;
  source_ref: string | null;
  tags: string[];
  note_type: string;
  slug: string | null;
  created_at: string;
  updated_at: string;
};

export type MemoryPageApi = MemoryApi & { listNotes(): Promise<MemoryNoteRow[]> };

export const memoryPageApi: MemoryPageApi = {
  ...memoryApi,
  async listNotes() {
    const res = await apiFetch("/api/memory/notes");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { notes?: MemoryNoteRow[] };
    return Array.isArray(body.notes) ? body.notes : [];
  },
};

const LAST_VISIT_KEY = "zavi.memory.lastVisitAt";
const FIRST_VISIT_WINDOW_MS = 7 * 86_400_000;
const UPDATE_LOOKUPS = 8;

const RUN_SOURCES = new Set(["auto_distill_chat", "auto_distill_agent_run", "agent_run", "episode_distill"]);

function readLastVisit(now: number): number {
  try {
    const v = Number(window.localStorage.getItem(LAST_VISIT_KEY));
    return Number.isFinite(v) && v > 0 ? v : now - FIRST_VISIT_WINDOW_MS;
  } catch {
    return now - FIRST_VISIT_WINDOW_MS;
  }
}

function writeLastVisit(now: number) {
  try {
    window.localStorage.setItem(LAST_VISIT_KEY, String(now));
  } catch {
  }
}

export function ago(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return "yesterday";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const tagValue = (tags: string[], prefix: string) =>
  tags.find((t) => t.startsWith(prefix))?.slice(prefix.length) || null;

export type SourceLine = { label: string; href?: string; linkLabel?: string };

export function sourceOf(n: MemoryNoteRow, now = Date.now()): SourceLine {
  const when = ago(n.created_at, now);
  const at = when ? `, ${when}` : "";
  const agent = tagValue(n.tags ?? [], "agent:");
  const thread = tagValue(n.tags ?? [], "thread:");
  switch (n.source) {
    case "auto_distill_chat":
      return thread
        ? { label: `From your chat${at}`, href: `/workspace/${encodeURIComponent(thread)}`, linkLabel: "Open the chat" }
        : { label: `From your chat${at}` };
    case "auto_distill_agent_run":
    case "agent_run":
    case "episode_distill": {
      if (!agent) return { label: `From a run${at}` };
      const name = agentDisplayName(agent);
      return isChannelSlug(agent)
        ? {
            label: `From the ${name} run${at}`,
            href: `/workspace?tab=channels&channel=${encodeURIComponent(agent)}`,
            linkLabel: "Open the channel",
          }
        : { label: `From a ${name} run${at}`, href: `/workspace?agent=${encodeURIComponent(agent)}`, linkLabel: "Open the chat" };
    }
    case "slack_distill":
    case "auto_distill_slack":
      return { label: `From Slack${at}` };
    case "email_distill":
      return { label: `From email${at}` };
    case "meeting_distill":
      return { label: `From a meeting${at}` };
    case "human":
    case "operator_feedback":
      return { label: `Added by you${at}` };
    default:
      return { label: `Saved by Zavi${at}` };
  }
}

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; notes: MemoryNoteRow[]; conflicts: ConflictPair[] };

export function MemoryPageClient({ api = memoryPageApi }: { api?: MemoryPageApi }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [since, setSince] = useState<number | null>(null);
  const sinceRef = useRef<number | null>(null);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [updates, setUpdates] = useState<Record<string, MemoryWriteItem>>({});
  const [kept, setKept] = useState<Record<string, string>>({});
  const [pairState, setPairState] = useState<Record<string, "busy" | "error">>({});
  const { modes, forget, undo } = useForgetWithUndo(api, dropCachedNote);

  const fetchAll = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const [notes, conflicts] = await Promise.all([api.listNotes(), api.listConflicts()]);
      setLoad({ state: "ready", notes: notes.filter((n) => !n.slug && n.note_type !== "anchor"), conflicts });
    } catch {
      setLoad({ state: "error" });
    }
  }, [api]);

  useEffect(() => {
    const now = Date.now();
    if (sinceRef.current === null) {
      sinceRef.current = readLastVisit(now);
      writeLastVisit(now);
    }
    setSince(sinceRef.current);
    setHighlight(new URLSearchParams(window.location.search).get("h")?.split(",").filter(Boolean) ?? []);
    void fetchAll();
  }, [fetchAll]);

  const notes = load.state === "ready" ? load.notes : [];
  const isNew = useCallback(
    (n: MemoryNoteRow) => highlight.includes(n.id) || (since !== null && Date.parse(n.created_at) > since),
    [highlight, since],
  );

  useEffect(() => {
    if (load.state !== "ready") return;
    const runs = [
      ...new Set(
        load.notes.filter((n) => isNew(n) && RUN_SOURCES.has(n.source) && n.source_ref).map((n) => n.source_ref!),
      ),
    ].slice(0, UPDATE_LOOKUPS);
    if (runs.length === 0) return;
    let cancelled = false;
    void Promise.all(runs.map((runId) => api.getWrites({ runId }).catch(() => null))).then((all) => {
      if (cancelled) return;
      const map: Record<string, MemoryWriteItem> = {};
      for (const w of all) for (const it of w?.items ?? []) if (it.kind === "updated") map[it.note_id] = it;
      setUpdates(map);
    });
    return () => {
      cancelled = true;
    };
  }, [load, isNew, api]);

  useEffect(() => {
    if (load.state !== "ready" || highlight.length === 0) return;
    const t = setTimeout(
      () => document.getElementById(`fact-${highlight[0]}`)?.scrollIntoView({ block: "center" }),
      50,
    );
    return () => clearTimeout(t);
  }, [load.state, highlight]);

  const q = query.trim().toLowerCase();
  const matches = (n: MemoryNoteRow) =>
    !q || n.title.toLowerCase().includes(q) || n.body_markdown.toLowerCase().includes(q);
  const live = notes.filter((n) => modes[n.id] !== "gone");
  const newRows = live.filter((n) => isNew(n) && matches(n));
  const earlier = live.filter((n) => !isNew(n) && matches(n));
  const conflicts = load.state === "ready" ? load.conflicts : [];

  const keep = async (pair: ConflictPair, noteId: string) => {
    setPairState((p) => ({ ...p, [pair.pair_id]: "busy" }));
    try {
      await api.keepConflict(pair.pair_id, noteId);
      for (const v of pair.values) dropCachedNote(v.note_id);
      setKept((k) => ({ ...k, [pair.pair_id]: noteId }));
      setPairState((p) => {
        const next = { ...p };
        delete next[pair.pair_id];
        return next;
      });
    } catch {
      setPairState((p) => ({ ...p, [pair.pair_id]: "error" }));
    }
  };

  return (
    <div>
      <h1 className="font-display text-[28px] font-semibold leading-[1.15] tracking-tight text-ink">Memory</h1>
      <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-inkMuted">
        Things Zavi picked up from your chats and channel runs. Zavi uses them in every reply. Edit anything that is
        wrong, and forget anything that is not a lasting fact.
      </p>

      <div className="relative mt-5 max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-inkMuted" aria-hidden="true" />
        <label htmlFor="memory-search" className="sr-only">
          Search memory
        </label>
        <input
          id="memory-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memory"
          className="h-10 w-full rounded-full border border-rule bg-white pl-9 pr-3 text-[14px] text-ink placeholder:text-inkMuted focus:outline-none focus:ring-2 focus:ring-ink/20"
        />
      </div>

      {load.state === "error" ? (
        <div role="alert" className="mt-6 flex items-center gap-3 rounded-2xl border border-rule bg-white px-4 py-4 text-[14px] text-ink">
          Could not load your memory.
          <button type="button" onClick={() => void fetchAll()} className={smallBtn}>
            Try again
          </button>
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <section aria-labelledby="conflicts-h" className="mt-6">
          <h2 id="conflicts-h" className="mb-2 text-[14px] font-semibold text-ink">
            Two values on record <span className="font-normal text-inkMuted">({conflicts.length})</span>
          </h2>
          <ul className="space-y-2">
            {conflicts.map((pair) => {
              const keptId = kept[pair.pair_id];
              const st = pairState[pair.pair_id];
              return (
                <li key={pair.pair_id} data-testid="conflict-pair" className="rounded-2xl border border-rule bg-white px-4 py-3">
                  {keptId ? (
                    <p className="text-[14px] text-ink">
                      Kept: {pair.values.find((v) => v.note_id === keptId)?.title}
                      <span className="mt-0.5 block text-[13px] text-inkMuted">The other value is marked out of date.</span>
                    </p>
                  ) : (
                    <>
                      <p className="text-[13px] text-inkMuted">
                        {st === "error"
                          ? "Could not save your answer. Try again."
                          : "Zavi has two values for this. Until you pick one, Zavi asks you before using either."}
                      </p>
                      <ul className="mt-2 divide-y divide-rule">
                        {pair.values.map((v) => (
                          <li key={v.note_id} className="flex items-center justify-between gap-3 py-2">
                            <div className="min-w-0">
                              <p className="text-[14px] text-ink">{v.title}</p>
                              {v.body_excerpt && v.body_excerpt !== v.title ? (
                                <p className="mt-0.5 line-clamp-2 text-[13px] text-inkMuted">{v.body_excerpt}</p>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              disabled={st === "busy"}
                              onClick={() => void keep(pair, v.note_id)}
                              className={smallBtn}
                            >
                              Keep this
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <h2 className="mb-2 mt-6 text-[14px] font-semibold text-ink">
        New since your last visit{" "}
        {load.state === "ready" ? <span className="font-normal text-inkMuted">({newRows.length})</span> : null}
      </h2>
      <Rows
        loading={load.state === "loading"}
        rows={newRows}
        markNew
        highlight={highlight}
        updates={updates}
        modes={modes}
        onForget={forget}
        onUndo={(id) => void undo(id)}
        empty={q ? "No new facts match your search." : "Nothing new since your last visit. New facts show up here a few seconds after a reply."}
      />

      <h2 className="mb-2 mt-8 text-[14px] font-semibold text-ink">
        Earlier {load.state === "ready" ? <span className="font-normal text-inkMuted">({earlier.length})</span> : null}
      </h2>
      <Rows
        loading={load.state === "loading"}
        rows={earlier}
        highlight={highlight}
        updates={updates}
        modes={modes}
        onForget={forget}
        onUndo={(id) => void undo(id)}
        empty={q ? "No earlier facts match your search." : "Nothing saved before your last visit."}
      />
    </div>
  );
}

const badge = "rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide";

function Rows({
  loading,
  rows,
  markNew = false,
  highlight,
  updates,
  modes,
  onForget,
  onUndo,
  empty,
}: {
  loading: boolean;
  rows: MemoryNoteRow[];
  markNew?: boolean;
  highlight: string[];
  updates: Record<string, MemoryWriteItem>;
  modes: Record<string, string>;
  onForget: (id: string) => void;
  onUndo: (id: string) => void;
  empty: string;
}) {
  if (loading) {
    return (
      <div aria-busy="true" className="space-y-2 rounded-2xl border border-rule bg-white px-4 py-4">
        <div className="h-4 w-2/3 animate-pulse rounded bg-bone" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-bone" />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-rule bg-white px-4 py-6 text-center text-[14px] text-inkMuted">{empty}</div>
    );
  }
  return (
    <ul className="divide-y divide-rule rounded-2xl border border-rule bg-white px-4">
      {rows.map((row) => {
        const mode = modes[row.id];
        const update = updates[row.id];
        const src = sourceOf(row);
        const lit = highlight.includes(row.id);
        return (
          <li
            key={row.id}
            id={`fact-${row.id}`}
            data-testid="memory-row"
            className={`-mx-4 scroll-mt-6 px-4 py-3 ${lit ? "bg-bone ring-2 ring-inset ring-ink/20" : markNew ? "bg-successBg/60" : ""}`}
          >
            {mode && HIDDEN_MODES.has(mode) ? (
              <div className="flex items-center gap-2 text-[14px] text-inkMuted">
                <span role={mode === "undo_failed" ? "alert" : undefined}>
                  {mode === "forgotten" ? "Forgotten. Zavi will not use this again." : FORGET_NOTES[mode]}
                </span>
                <button type="button" onClick={() => onUndo(row.id)} disabled={!UNDOABLE_MODES.has(mode)} className={smallBtn}>
                  Undo
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] text-ink">
                    {markNew ? <span className={`${badge} bg-successBg text-success`}>New</span> : null}
                    {update ? <span className={`${badge} bg-bone text-ink`}>Updated</span> : null}
                    <span>{row.title}</span>
                  </p>
                  {update?.previous?.title ? (
                    <p className="mt-0.5 text-[13px] text-inkMuted">
                      was: <span className="line-through">{update.previous.title}</span>
                    </p>
                  ) : null}
                  {mode === "error" ? (
                    <p role="alert" className="mt-0.5 text-[13px] text-danger">Could not forget this. Try again.</p>
                  ) : null}
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-inkMuted">
                    {src.label}
                    {src.href ? (
                      <Link href={src.href} className="inline-flex items-center gap-0.5 font-medium text-ink underline underline-offset-2">
                        {src.linkLabel}
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Link href={`/memory/${encodeURIComponent(row.id)}`} className={`${smallBtn} gap-1`}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Edit
                  </Link>
                  <button type="button" onClick={() => onForget(row.id)} className={`${smallBtn} gap-1`}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Forget
                  </button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
