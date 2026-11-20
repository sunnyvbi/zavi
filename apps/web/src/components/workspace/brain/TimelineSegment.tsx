"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  ChevronDown,
  Plus,
  Trash2,
  SquarePen,
  Zap,
  Play,
  User,
  Slack,
  Github,
  Mail,
  X,
  type LucideIcon,
} from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase";
import { toast } from "@/components/ui/toast";
import { scopeToTenant } from "./tenantScope";
import { useActiveTenant } from "./useActiveTenant";
import { apiFetch } from "@/lib/api";
import { useWorkspace } from "../WorkspaceShell";
import { NextChevron } from "@/components/ui/NextChevron";

type LedgerRow = {
  id: string;
  title: string | null;
  body_markdown: string | null;
  source: string | null;
  source_ref: string | null;
  note_type: string | null;
  trust_tier: number | null;
  created_at: string;
  superseded_by: string | null;
  slug: string | null;
};

const PAGE = 80;
const SHOW_CHANNEL_FILTER = false;

type ChannelMeta = { label: string; dot: string };

function channelMeta(source: string | null): ChannelMeta {
  const s = (source ?? "").toLowerCase();
  if (s === "human" || s === "operator" || s === "user") return { label: "You", dot: "bg-emerald-500" };
  if (s.includes("slack")) return { label: "Slack", dot: "bg-violet" };
  if (s.includes("github")) return { label: "GitHub", dot: "bg-ink" };
  if (s.includes("gmail") || s.includes("email")) return { label: "Email", dot: "bg-inkMuted" };
  if (s.includes("meta") || s.includes("ads") || s.includes("facebook")) return { label: "Meta Ads", dot: "bg-sky-500" };
  if (s.includes("stripe")) return { label: "Stripe", dot: "bg-indigo-500" };
  if (s.includes("operator_db") || s.includes("mongo") || s.includes("db")) return { label: "Your database", dot: "bg-teal-500" };
  if (s.includes("agent") || s.includes("distill") || s.includes("run") || s.includes("chat")) return { label: "Agent run", dot: "bg-teal-500" };
  if (s.includes("connector")) return { label: "Connector", dot: "bg-marigold" };
  if (!s) return { label: "Memory", dot: "bg-inkMuted" };
  return { label: s.charAt(0).toUpperCase() + s.slice(1).replace(/[_-]+/g, " "), dot: "bg-inkMuted" };
}

const CHANNEL_ICON: Record<string, LucideIcon> = {
  Slack,
  GitHub: Github,
  Email: Mail,
  You: User,
};

function isOperatorAuthored(r: LedgerRow): boolean {
  const s = (r.source ?? "").toLowerCase();
  return s === "human" || s === "user" || s.startsWith("operator");
}

function isAgentRun(r: LedgerRow): boolean {
  const ref = (r.source_ref ?? "").trim();
  if (/^[a-z][a-z0-9-]{2,40}$/.test(ref)) return true;
  const s = (r.source ?? "").toLowerCase();
  return s.includes("agent") || s.includes("run") || s.includes("distill") || s.includes("chat");
}

type DayGroup = { key: string; label: string; date: string; rows: LedgerRow[] };

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(iso: string): { key: string; label: string; date: string } {
  const d = new Date(iso);
  const today = startOfDay(new Date());
  const that = startOfDay(d);
  const diffDays = Math.round((today - that) / 86_400_000);
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const key = String(that);
  if (diffDays <= 0) return { key, label: "Today", date };
  if (diffDays === 1) return { key, label: "Yesterday", date };
  if (diffDays < 7) return { key, label: WEEKDAYS[d.getDay()], date };
  return { key, label: date, date: `${d.getFullYear()}` };
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

function cardText(r: LedgerRow): { title: string; body: string } {
  const rawTitle = (r.title ?? "").trim();
  const rawBody = (r.body_markdown ?? "").replace(/^#+\s*/gm, "").trim();
  if (rawTitle) return { title: rawTitle.replace(/\.md$/, ""), body: rawBody };
  const [first, ...rest] = rawBody.split("\n");
  return { title: (first || "").slice(0, 90) || "(empty note)", body: rest.join(" ").trim() };
}

function FilterSelect({
  value,
  onChange,
  options,
  ariaLabel,
  widthClass = "w-[153px]",
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ v: string; l: string }>;
  ariaLabel: string;
  widthClass?: string;
}) {
  return (
    <div className={`relative shrink-0 ${widthClass}`}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full appearance-none rounded-[10px] border border-[#f0f0f0] bg-white pl-2.5 pr-9 text-[14px] font-medium text-[#0e0f11] outline-none transition-colors hover:border-[#e0e0e0] focus:border-[#bfbfbf]"
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        strokeWidth={1.5}
        className="pointer-events-none absolute right-2.5 top-1/2 h-5 w-5 -translate-y-1/2 text-[#0e0f11]"
      />
    </div>
  );
}

function Badge({ icon: Icon, label, iconClass, dot }: { icon?: LucideIcon; label: string; iconClass?: string; dot?: string }) {
  return (
    <span className="inline-flex min-h-[32px] items-center gap-2 rounded-[16px] py-1.5 pl-2.5 pr-4 text-[13px] font-medium leading-[18px] tracking-[0.13px] text-[#1f1f1f]">
      {Icon ? (
        <Icon aria-hidden strokeWidth={1.5} className={`h-4 w-4 shrink-0 ${iconClass ?? "text-[#1f1f1f]"}`} />
      ) : (
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-sm ${dot ?? "bg-inkMuted"}`} />
      )}
      {label}
    </span>
  );
}

function BadgeDivider() {
  return <span aria-hidden className="h-[5px] w-[5px] shrink-0 rounded-full bg-[#d9d9d9]" />;
}

function CardAction({
  icon: Icon,
  label,
  onClick,
  tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  tone?: "neutral" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-[32px] shrink-0 items-center gap-2 rounded-cta border border-[#f0f0f0] bg-white py-1.5 pl-2.5 pr-4 text-[13px] font-semibold leading-5 transition-colors hover:bg-[#f9f9f9] ${tone === "danger" ? "text-[#cb2029]" : "text-[#1f1f1f]"
        }`}
    >
      <Icon aria-hidden strokeWidth={1.5} className="h-4 w-4 shrink-0" />
      {label}
    </button>
  );
}

export function TimelineSegment() {
  const { role } = useWorkspace();
  const canEdit = role !== "member";
  const tid = useActiveTenant();

  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [reloadKey, setReloadKey] = useState(0);

  const [query, setQuery] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [howFilter, setHowFilter] = useState<"" | "you" | "auto">("");
  const [dateFilter, setDateFilter] = useState<"" | "today" | "week" | "month">("");

  const [composeOpen, setComposeOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<LedgerRow | null>(null);
  const flash = useCallback((m: string) => {
    toast.add({ title: m, timeout: 2600 });
  }, []);

  useEffect(() => {
    if (tid === undefined) return;
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    if (tid === null) {
      setRows([]);
      setLoading(false);
      return;
    }
    const sb = createBrowserSupabase();
    scopeToTenant(
      sb
        .from("memory_note")
        .select(
          "id, title, body_markdown, source, source_ref, note_type, trust_tier, created_at, superseded_by, slug",
        ),
      tid,
    )
      .order("created_at", { ascending: false })
      .limit(limit)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setErrorMsg(error.message);
          setLoading(false);
          return;
        }
        setRows((data ?? []) as LedgerRow[]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tid, limit, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    const cutoff =
      dateFilter === "today"
        ? startOfDay(new Date())
        : dateFilter === "week"
          ? now - 7 * 86_400_000
          : dateFilter === "month"
            ? now - 30 * 86_400_000
            : 0;
    return rows.filter((r) => {
      if (q) {
        const hay = `${r.title ?? ""} ${r.body_markdown ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (channelFilter && channelMeta(r.source).label !== channelFilter) return false;
      if (howFilter === "you" && !isOperatorAuthored(r)) return false;
      if (howFilter === "auto" && isOperatorAuthored(r)) return false;
      if (cutoff && new Date(r.created_at).getTime() < cutoff) return false;
      return true;
    });
  }, [rows, query, channelFilter, howFilter, dateFilter]);

  const groups = useMemo<DayGroup[]>(() => {
    const map = new Map<string, DayGroup>();
    const order: string[] = [];
    for (const r of filtered) {
      const { key, label, date } = dayLabel(r.created_at);
      let g = map.get(key);
      if (!g) {
        g = { key, label, date, rows: [] };
        map.set(key, g);
        order.push(key);
      }
      g.rows.push(r);
    }
    return order.map((k) => map.get(k)!);
  }, [filtered]);

  const channelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(channelMeta(r.source).label);
    return Array.from(set).sort();
  }, [rows]);

  const closeModal = useCallback(() => {
    setComposeOpen(false);
    setDraft("");
    setEditingId(null);
    setEditText("");
  }, []);

  async function addMemory() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const res = await apiFetch("/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({ body_markdown: body, note_type: "tenant_reference" }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message ?? "add failed");
      closeModal();
      reload();
      flash("Added to brain. Every agent reads it on its next run");
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    const body = editText.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const res = await apiFetch("/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({ id, body_markdown: body }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message ?? "edit failed");
      closeModal();
      reload();
      flash("Memory updated. The fleet re-reads it next run");
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doDelete(row: LedgerRow) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/memory/notes/${row.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message ?? "remove failed");
      setConfirmDelete(null);
      reload();
      flash("Removed permanently. No agent will recall it");
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const modalOpen = composeOpen || editingId !== null;
  const modalIsEdit = editingId !== null;
  const modalText = modalIsEdit ? editText : draft;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const requestClose = useCallback(() => {
    if (busy) return;
    closeModal();
  }, [busy, closeModal]);

  useEffect(() => {
    if (!modalOpen) return;
    const opener = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        requestClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [modalOpen, requestClose]);

  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1084px] flex-1 flex-col px-6 pb-5 pt-6">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex h-10 min-w-[220px] flex-1 items-center gap-2 rounded-full border border-[#f0f0f0] bg-white px-3">
          <Search aria-hidden strokeWidth={1.5} className="h-5 w-5 shrink-0 text-[#bfbfbf]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search everything your fleet remembers…"
            aria-label="Search the timeline"
            className="w-full flex-1 bg-transparent text-[14px] text-[#0e0f11] outline-none placeholder:font-medium placeholder:text-[#bfbfbf]"
          />
        </label>
        {SHOW_CHANNEL_FILTER && (
          <FilterSelect
            ariaLabel="Filter by channel"
            value={channelFilter}
            onChange={setChannelFilter}
            options={[{ v: "", l: "All Channels" }, ...channelOptions.map((c) => ({ v: c, l: c }))]}
          />
        )}
        <FilterSelect
          ariaLabel="Filter by author"
          value={howFilter}
          onChange={(v) => setHowFilter(v as "" | "you" | "auto")}
          options={[
            { v: "", l: "Auto+yours" },
            { v: "you", l: "Added by you" },
            { v: "auto", l: "Auto-captured" },
          ]}
        />
        <FilterSelect
          ariaLabel="Filter by time"
          value={dateFilter}
          onChange={(v) => setDateFilter(v as "" | "today" | "week" | "month")}
          widthClass="w-[110px]"
          options={[
            { v: "", l: "All time" },
            { v: "today", l: "Today" },
            { v: "week", l: "Last 7 days" },
            { v: "month", l: "Last 30 days" },
          ]}
        />
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setDraft("");
              setComposeOpen(true);
            }}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-cta bg-[#0e0f11] py-1.5 pl-4 pr-5 text-[16px] font-semibold leading-5 text-white transition-colors hover:bg-[#2b2a28]"
          >
            <Plus aria-hidden strokeWidth={2} className="h-5 w-5" />
            Add Memory
          </button>
        )}
      </div>
      <div className="mt-[42px] flex-1">
        {loading && (
          <div className="space-y-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-[142px] animate-pulse rounded-[20px] bg-bone/60" />
            ))}
          </div>
        )}

        {!loading && errorMsg && (
          <div className="rounded-lg border border-coral/40 bg-coral/5 px-3 py-3 text-[13px] text-coral">
            Couldn&apos;t load your brain: {errorMsg}
          </div>
        )}

        {!loading && !errorMsg && filtered.length === 0 && (
          <div className="rounded-xl border border-dashed border-ink/15 px-4 py-10 text-center text-[13px] text-inkMuted">
            {rows.length === 0 ? (
              <>
                <div className="text-[14px] font-semibold text-ink">Your brain is empty so far.</div>
                Your agents haven&apos;t learned anything yet. As they work (or when you add a note), it lands
                here, day by day.
              </>
            ) : (
              <>Nothing matches those filters.</>
            )}
          </div>
        )}

        {!loading &&
          !errorMsg &&
          groups.map((g) => (
            <div key={g.key} className="mt-[21px] first:mt-0">
              <div className="mb-[21px] flex items-baseline gap-1">
                <h2 className="text-[16px] font-semibold leading-6 text-[#0e0f11]">
                  {g.label} {g.date} ·
                </h2>
                <span className="text-[16px] font-medium leading-5 text-[#0e0f11]">{g.rows.length} new</span>
              </div>

              <div className="space-y-4">
                {g.rows.map((r) => {
                  const ch = channelMeta(r.source);
                  const you = isOperatorAuthored(r);
                  const agentRun = isAgentRun(r);
                  const retired = r.superseded_by !== null;
                  const isAnchor = r.note_type === "anchor" || r.slug !== null;
                  const { title, body } = cardText(r);
                  const ChIcon = CHANNEL_ICON[ch.label];
                  return (
                    <div
                      key={r.id}
                      className={`group flex flex-col gap-2 rounded-[20px] border border-[#f0f0f0] bg-white p-4 transition-colors hover:bg-[#f9f9f9] ${retired ? "opacity-55" : ""
                        }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="block h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                        <div
                          className={`min-w-0 flex-1 text-[16px] font-semibold leading-6 text-[#0e0f11] ${retired ? "line-through" : ""
                            }`}
                        >
                          {title}
                        </div>
                        <span className="shrink-0 text-[16px] leading-5 tabular-nums text-[#8c8c8c]">
                          {timeLabel(r.created_at)}
                        </span>
                      </div>

                      <div className="flex flex-col gap-2 pl-4">
                        {body && (
                          <p className="line-clamp-2 text-[16px] leading-5 text-[#595959]">{body}</p>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-y-2">
                          <div className="flex flex-wrap items-center gap-y-1">
                            {you ? (
                              <Badge icon={User} label="You" iconClass="text-[#167f50]" />
                            ) : (
                              <>
                                <Badge icon={Zap} label="Auto" />
                                {ch.label !== "Agent run" && ch.label !== "Memory" && (
                                  <>
                                    <BadgeDivider />
                                    <Badge icon={ChIcon} dot={ch.dot} label={ch.label} />
                                  </>
                                )}
                                {agentRun && (
                                  <>
                                    <BadgeDivider />
                                    <Badge icon={Play} label="Agent Run" iconClass="text-[#167f50]" />
                                  </>
                                )}
                              </>
                            )}
                            {isAnchor && (
                              <span className="ml-1 rounded-full bg-ink/[0.06] px-2 py-[2px] text-[11px] font-medium uppercase tracking-wide text-inkSoft">
                                anchor
                              </span>
                            )}
                            {retired && (
                              <span className="ml-1 rounded-full bg-coral/12 px-2 py-[2px] text-[11px] font-medium uppercase tracking-wide text-coral">
                                retired
                              </span>
                            )}
                          </div>
                          {canEdit && !isAnchor && (
                            <div className="flex shrink-0 items-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                              <CardAction
                                icon={Trash2}
                                label="Delete"
                                tone="danger"
                                onClick={() => setConfirmDelete(r)}
                              />
                              <CardAction
                                icon={SquarePen}
                                label="Edit"
                                onClick={() => {
                                  setEditingId(r.id);
                                  setEditText((r.body_markdown ?? r.title ?? "").trim());
                                }}
                              />
                            </div>
                          )}
                          {canEdit && isAnchor && (
                            <span
                              className="shrink-0 text-[13px] text-[#8c8c8c]"
                              title="Anchors are rewritten from the Anchors view, not edited here."
                            >
                              rewrite via anchors
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

        {!loading && !errorMsg && rows.length >= limit && (
          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={() => setLimit((l) => l + PAGE)}
              className="rounded-cta border border-ink/15 px-3 py-1.5 text-[12px] text-inkSoft transition-colors hover:bg-bone"
            >
              Load earlier days <NextChevron />
            </button>
          </div>
        )}
      </div>
      {modalOpen && canEdit && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={requestClose}
          role="presentation"
        >
          <div
            ref={dialogRef}
            className="w-full max-w-[511px] rounded-[20px] bg-white p-4 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-label={modalIsEdit ? "Edit memory" : "Add memory"}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onDialogKeyDown}
          >
            <div className="flex items-start justify-between">
              <h2 className="font-display text-[20px] font-bold tracking-tight text-ink">
                {modalIsEdit ? "Edit Memory" : "Add Memory"}
              </h2>
              <button
                type="button"
                onClick={requestClose}
                aria-label="Close"
                className="rounded-full p-1 text-inkMuted transition-colors hover:bg-bone hover:text-ink"
              >
                <X aria-hidden strokeWidth={1.75} className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-0.5 text-[12px] text-inkMuted">Applies to all agents</p>

            <textarea
              value={modalText}
              autoFocus
              rows={5}
              onChange={(e) =>
                modalIsEdit ? setEditText(e.target.value) : setDraft(e.target.value)
              }
              placeholder="Teach your agents something. e.g. 'Weekend hosts get a 50% refund if cancelled inside 48 hours.'"
              className="mt-3 w-full resize-y rounded-xl border border-ink/12 bg-white p-3.5 text-[16px] leading-[1.5] text-ink outline-none transition-colors placeholder:text-inkMuted focus:border-ink/40"
            />

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={busy}
                className="rounded-cta border border-ink/15 bg-white px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-bone disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !modalText.trim()}
                onClick={() => (modalIsEdit ? saveEdit(editingId!) : addMemory())}
                className="rounded-cta bg-ink px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-inkSoft disabled:opacity-40"
              >
                {busy ? "Saving…" : modalIsEdit ? "Save" : "Add to Brain"}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-ink/15 bg-white p-4 shadow-xl">
            <div className="font-display text-[16px] font-semibold text-ink">Remove this memory permanently?</div>
            <p className="mt-2 text-[13px] leading-[1.5] text-inkSoft">
              This deletes it for good. There&apos;s no undo, and every agent stops recalling it on its next run.
            </p>
            <div className="mt-3 rounded-lg border border-ink/10 bg-bone/50 px-3 py-2 text-[13px] text-ink">
              {((confirmDelete.body_markdown ?? confirmDelete.title ?? "").trim().slice(0, 200)) || "(empty note)"}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="rounded-cta px-3 py-2 text-[12px] text-inkMuted transition-colors hover:bg-bone"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => doDelete(confirmDelete)}
                className="rounded-cta bg-coral px-3.5 py-2 text-[12px] font-semibold text-white transition-colors disabled:opacity-50"
              >
                Remove permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
