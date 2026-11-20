"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { apiFetch } from "@/lib/api";
import { agentDisplayName } from "@/lib/agentRegistry";
import { TileState, type TileTone } from "../settings/ConnectorTile";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { cx, FOCUS_RING } from "./shared";

export type AccessRow = {
  id: string;
  created_at: string;
  finished_at: string | null;
  caller_kind: "agent" | "background" | "person";
  agent_slug: string | null;
  feature: string | null;
  run_id: string | null;
  mode: "direct" | "connector";
  operation: string;
  query_text: string;
  tables: string[] | null;
  row_count: number;
  sent_to_ai: boolean;
  result: "pending" | "allowed" | "refused" | "failed";
  refused_by: "zavi" | "connector" | null;
  reason: string | null;
  totals_only: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNFINISHED_AFTER_MS = 60_000;
const COLUMNS = ["Time", "Agent", "Mode", "Query", "Rows", "Sent to AI", "Result"];
const PAGE = 50;

export function whoLabel(r: AccessRow): string {
  if (r.caller_kind === "agent") return r.agent_slug ? agentDisplayName(r.agent_slug) : "Agent";
  if (r.caller_kind === "background") return `Zavi (background) · ${r.feature || "Background job"}`;
  return r.feature || "Your team";
}

export function modeLabel(mode: AccessRow["mode"]): string {
  return mode === "connector" ? "Your server" : "Quick setup";
}

export function resultLabel(r: AccessRow, now = Date.now()): { tone: TileTone; text: string } {
  if (r.result === "allowed") return { tone: "connected", text: "Allowed" };
  if (r.result === "failed") return { tone: "warning", text: "Failed" };
  if (r.result === "refused") {
    return {
      tone: "danger",
      text: r.refused_by === "connector" ? "Refused by your connector" : "Refused by a data-access rule",
    };
  }
  const age = now - Date.parse(r.created_at);
  return { tone: "idle", text: age > UNFINISHED_AFTER_MS ? "Unfinished" : "Running" };
}

function timeLabel(isoTime: string, now = new Date()): string {
  const d = new Date(isoTime);
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (that === day) return `Today ${hm}`;
  if (that === day - 86_400_000) return `Yesterday ${hm}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${hm}`;
}

type Filters = { agent: string; mode: string; result: string; days: string; q: string };
const DEFAULT_FILTERS: Filters = { agent: "", mode: "", result: "", days: "30", q: "" };

function listPath(f: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  p.set("days", f.days);
  p.set("limit", String(PAGE));
  if (f.agent) p.set("agent", f.agent);
  if (f.mode) p.set("mode", f.mode);
  if (f.result) p.set("result", f.result);
  if (f.q.trim()) p.set("q", f.q.trim());
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return `/api/connectors/operator-db/access-log?${p.toString()}`;
}

type Cursor = { before: string; before_id: string | null };
type Page = { rows: AccessRow[]; next: Cursor | null };

function entryPath(id: string): string {
  return `/api/connectors/operator-db/access-log?id=${encodeURIComponent(id)}&limit=1`;
}

async function fetchPage(path: string): Promise<Page | "forbidden" | "error"> {
  try {
    const res = await apiFetch(path);
    if (res.status === 403) return "forbidden";
    if (!res.ok) return "error";
    const body = (await res.json()) as { rows?: AccessRow[]; next_before?: string | null; next_before_id?: string | null };
    return {
      rows: Array.isArray(body.rows) ? body.rows : [],
      next: body.next_before ? { before: body.next_before, before_id: body.next_before_id ?? null } : null,
    };
  } catch {
    return "error";
  }
}

function TextSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="relative inline-flex items-center text-[13px] font-medium text-inkMuted hover:text-ink">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx("cursor-pointer appearance-none bg-transparent pr-4 outline-none", FOCUS_RING)}
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-0 text-inkLight">
        ▾
      </span>
    </label>
  );
}

function QueryBlock({ row }: { row: AccessRow }) {
  const ws = useWorkspaceOptional();
  const [copied, setCopied] = useState(false);
  const tables = (row.tables ?? []).join(", ");
  const runHref = row.run_id ? `/workspace?tab=run&run=${encodeURIComponent(row.run_id)}` : null;
  const openRun = (e: MouseEvent) => {
    if (!ws || !row.run_id) return;
    e.preventDefault();
    ws.openTab({
      kind: "run",
      title: `Run ${row.run_id.slice(0, 8)}…`,
      payload: { kind: "run", runId: row.run_id },
      dirty: false,
      pinned: false,
    });
  };
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(row.query_text);
    } catch {
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div data-testid="data-access-detail" className="overflow-hidden rounded-[12px] bg-[#0e0f11]">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3.5 py-1.5">
        <span className="min-w-0 truncate text-[12px] text-[#a3a3a3]">
          Full query
          {runHref && (
            <>
              {" · "}
              <a href={runHref} onClick={openRun} className="text-[#e5e5e5] underline underline-offset-2">
                Open run
              </a>
            </>
          )}
          {tables && ` · ${tables}`}
          {row.totals_only && " · totals only"}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md px-2 text-[12px] font-semibold text-[#e5e5e5] hover:bg-white/10"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-[12.5px] leading-[1.6] text-[#e5e5e5]">
        {row.query_text}
      </pre>
    </div>
  );
}

export function DataAccessTab({ entryId = null }: { entryId?: string | null }) {
  const deepLink = entryId && UUID_RE.test(entryId) ? entryId : null;
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [nextBefore, setNextBefore] = useState<Cursor | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "forbidden" | "error">("loading");
  const [open, setOpen] = useState<string | null>(deepLink);
  const [agents, setAgents] = useState<string[]>([]);
  const highlightRef = useRef<HTMLTableRowElement | null>(null);
  const scrolledFor = useRef<string | null>(null);

  useEffect(() => {
    if (deepLink) setOpen(deepLink);
  }, [deepLink]);

  useEffect(() => {
    const t = window.setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const load = useCallback(
    async (f: Filters) => {
      setState("loading");
      const [list, linked] = await Promise.all([
        fetchPage(listPath(f)),
        deepLink ? fetchPage(entryPath(deepLink)) : Promise.resolve(null),
      ]);
      if (list === "forbidden" || linked === "forbidden") return setState("forbidden");
      if (list === "error") return setState("error");
      let merged = list.rows;
      if (linked && linked !== "error") {
        const extra = linked.rows.filter((r) => !merged.some((m) => m.id === r.id));
        merged = [...extra, ...merged];
      }
      setRows(merged);
      setNextBefore(list.next);
      setAgents((prev) => {
        const seen = new Set(prev);
        for (const r of merged) if (r.caller_kind === "agent" && r.agent_slug) seen.add(r.agent_slug);
        return [...seen].sort();
      });
      setState("ready");
    },
    [deepLink],
  );

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  useEffect(() => {
    if (!deepLink || scrolledFor.current === deepLink || !highlightRef.current) return;
    scrolledFor.current = deepLink;
    highlightRef.current.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [deepLink, rows]);

  const loadMore = async () => {
    if (!nextBefore) return;
    const cursor: Record<string, string> = { before: nextBefore.before };
    if (nextBefore.before_id) cursor.before_id = nextBefore.before_id;
    const page = await fetchPage(listPath(filters, cursor));
    if (page === "forbidden" || page === "error") return;
    setRows((prev) => [...prev, ...page.rows.filter((r) => !prev.some((p) => p.id === r.id))]);
    setNextBefore(page.next);
  };

  const set = (k: keyof Filters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const now = Date.now();

  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 py-6 compact:px-4">
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-[20px] font-semibold leading-[28px] tracking-tight text-ink">Data access</h2>
          <p className="mt-1 text-[14px] text-inkMuted">
            Every query any Zavi agent ran on your database. Click a row to see the full query.
          </p>
        </div>
        <div className="flex h-10 items-center gap-2 rounded-full border border-rule bg-white px-3">
          <svg className="h-5 w-5 shrink-0 text-inkLight" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={search}
            maxLength={200}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search queries"
            aria-label="Search queries"
            className="w-full bg-transparent text-[14px] font-medium leading-[22px] text-ink outline-none placeholder:font-medium placeholder:text-inkLight"
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <TextSelect
            label="Agent"
            value={filters.agent}
            onChange={set("agent")}
            options={[
              ["", "All agents"],
              ...agents.map((s): [string, string] => [s, agentDisplayName(s)]),
              ["background", "Zavi (background)"],
              ["person", "Contact import and table browser"],
            ]}
          />
          <TextSelect
            label="Setup"
            value={filters.mode}
            onChange={set("mode")}
            options={[
              ["", "Both setups"],
              ["direct", "Quick setup"],
              ["connector", "Your server"],
            ]}
          />
          <TextSelect
            label="Result"
            value={filters.result}
            onChange={set("result")}
            options={[
              ["", "All results"],
              ["allowed", "Allowed"],
              ["refused", "Refused"],
              ["failed", "Failed"],
              ["pending", "Unfinished"],
            ]}
          />
          <TextSelect
            label="Date"
            value={filters.days}
            onChange={set("days")}
            options={[
              ["1", "Last 24 hours"],
              ["7", "Last 7 days"],
              ["30", "Last 30 days"],
              ["90", "Last 90 days"],
              ["365", "Last year"],
            ]}
          />
        </div>
        {state === "forbidden" ? (
          <p className="text-[14px] text-inkMuted">Only owners and admins can see the data access log.</p>
        ) : (
          <div className="overflow-x-auto rounded-[16px] border border-rule">
            <table className="w-full min-w-[760px] text-[14px]">
              <thead className="text-left text-[13px] text-inkMuted">
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c} scope="col" className="px-4 py-3 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr className="border-t border-rule">
                    <td colSpan={COLUMNS.length} className="px-4 py-6 text-center text-inkMuted">
                      {state === "loading" ? "Loading…" : state === "error" ? "Could not load the data access log. Try again in a moment." : "No queries yet"}
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const result = resultLabel(r, now);
                  const isOpen = open === r.id;
                  const linked = deepLink === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr
                        ref={linked ? highlightRef : undefined}
                        aria-expanded={isOpen}
                        tabIndex={0}
                        onClick={() => setOpen(isOpen ? null : r.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setOpen(isOpen ? null : r.id);
                          }
                        }}
                        className={cx(
                          "cursor-pointer border-t border-rule align-top hover:bg-[#fafafa]",
                          (isOpen || linked) && "bg-[#fafafa]",
                          linked && "outline outline-2 -outline-offset-2 outline-[#d9d9d9]",
                          FOCUS_RING,
                        )}
                      >
                        <td className="whitespace-nowrap px-4 py-3 text-inkMuted">{timeLabel(r.created_at)}</td>
                        <td className="px-4 py-3 font-medium text-ink">{whoLabel(r)}</td>
                        <td className="px-4 py-3 text-inkMuted">{modeLabel(r.mode)}</td>
                        <td className="max-w-[260px] truncate px-4 py-3 font-mono text-[12.5px] text-ink">
                          {r.query_text.split("\n")[0]}
                        </td>
                        <td className="px-4 py-3 text-inkMuted">{r.row_count}</td>
                        <td className="px-4 py-3 text-inkMuted">{r.sent_to_ai ? "Yes" : "No"}</td>
                        <td className="px-4 py-3">
                          <TileState tone={result.tone} text={result.text} />
                          {r.reason && <p className="mt-1 text-[12px] text-inkLight">{r.reason}</p>}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-[#fafafa]">
                          <td colSpan={COLUMNS.length} className="px-4 pb-4">
                            <QueryBlock row={r} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {state === "ready" && nextBefore && (
          <div>
            <button
              type="button"
              onClick={() => void loadMore()}
              className={cx("h-8 rounded-[10px] border border-rule px-3 text-[13px] font-semibold text-ink hover:bg-[#fafafa]", FOCUS_RING)}
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
