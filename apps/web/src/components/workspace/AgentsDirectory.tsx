"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, Check } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { agentDisplayName } from "@/lib/agentRegistry";
import { AgentAvatar } from "./AgentAvatar";
import { Skeleton } from "./Skeleton";

export const DEPARTMENTS = ["leadership", "product", "growth", "others"] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const DEPARTMENT_LABELS: Record<Department, string> = {
  leadership: "Leadership",
  product: "Product",
  growth: "Growth",
  others: "Others",
};

export type TabFilter = "all" | "active" | "disable";

export type ToggleLock = "none" | "always_on" | "staff";

export type AgentEffectiveRow = {
  slug: string;
  name?: string;
  department?: string;
  default_state: "enabled" | "disabled" | "always_on";
  effective_state: "visible" | "hidden";
  effective_reason: string;
  override_state: "hidden" | "visible" | null;
  override_source: "tenant" | "staff" | null;
  is_locked: boolean;
};

type ListResponse = { tenant_id: string; agents: AgentEffectiveRow[] };

export type DirectoryRow = {
  slug: string;
  display: string;
  department: Department;
  on: boolean;
  lock: ToggleLock;
};

export function coerceDepartment(value: string | undefined): Department {
  return (DEPARTMENTS as readonly string[]).includes(value ?? "")
    ? (value as Department)
    : "others";
}

export function toDirectoryRow(row: AgentEffectiveRow): DirectoryRow {
  return {
    slug: row.slug,
    display: agentDisplayName(row.slug),
    department: coerceDepartment(row.department),
    on: row.effective_state === "visible",
    lock: row.is_locked
      ? "always_on"
      : row.override_source === "staff"
        ? "staff"
        : "none",
  };
}

export function filterRows(
  rows: DirectoryRow[],
  tab: TabFilter,
  query: string,
): DirectoryRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (tab === "active" && !r.on) return false;
    if (tab === "disable" && r.on) return false;
    if (!q) return true;
    return r.display.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q);
  });
}

export type DepartmentGroup = { department: Department; label: string; rows: DirectoryRow[] };

export function groupByDepartment(rows: DirectoryRow[]): DepartmentGroup[] {
  return DEPARTMENTS.map((dept) => ({
    department: dept,
    label: DEPARTMENT_LABELS[dept],
    rows: rows
      .filter((r) => r.department === dept)
      .sort((a, b) => a.display.localeCompare(b.display)),
  })).filter((g) => g.rows.length > 0);
}

function CheckIcon({ className }: { className?: string }) {
  return <Check className={className} strokeWidth={3} aria-hidden />;
}

const SKELETON_GROUPS = [2, 4, 2] as const;
const NAME_WIDTHS = ["w-28", "w-36", "w-24", "w-32"];
function DirectorySkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="rounded-2xl border border-[#f0f0f0] bg-white px-6 pb-4 pt-6 shadow-[0px_1px_4px_0px_rgba(16,18,20,0.05),0px_1px_4px_0px_rgba(16,18,20,0.1)]"
    >
      {SKELETON_GROUPS.map((count, gi) => (
        <div key={gi}>
          <div className={cn("flex items-center justify-between pb-2 pr-4", gi === 0 ? "pt-0" : "pt-6")}>
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-3 w-3" rounded="rounded" />
          </div>
          <ul>
            {Array.from({ length: count }).map((_, i) => (
              <li key={i} className="flex items-center gap-2.5 px-3 py-2">
                <Skeleton className="h-6 w-6 shrink-0" rounded="rounded-md" />
                <Skeleton className={cn("h-3.5", NAME_WIDTHS[(gi + i) % NAME_WIDTHS.length])} />
                <span className="flex-1" />
                <Skeleton className="h-3.5 w-11" />
                <Skeleton className="h-7 w-11 shrink-0" rounded="rounded-full" />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <span className="sr-only">Loading agents…</span>
    </div>
  );
}

export function AgentsDirectory() {
  const [raw, setRaw] = useState<AgentEffectiveRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await apiFetch("/api/agents/visibility");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as ListResponse;
      setRaw(j.agents);
    } catch (e) {
      setErr((e as Error).message);
      setRaw([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const mapped = (raw ?? []).map(toDirectoryRow);
    if ((raw?.length ?? 0) > 0 && !mapped.some((r) => r.slug === "operator")) {
      mapped.unshift({
        slug: "operator",
        display: agentDisplayName("operator"),
        department: "leadership",
        on: true,
        lock: "always_on",
      });
    }
    return mapped;
  }, [raw]);
  const defaultStateBySlug = useMemo(
    () => new Map((raw ?? []).map((a) => [a.slug, a.default_state])),
    [raw],
  );
  const groups = useMemo(
    () => groupByDepartment(filterRows(rows, "all", query)),
    [rows, query],
  );
  const totalShown = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <section id="agents" className="mt-1">
      <h2 className="text-[20px] font-semibold leading-7 tracking-[-0.01em] text-[#0e0f11]">
        Agents
      </h2>
      <p className="mb-5 mt-1 max-w-[620px] text-[16px] leading-5 text-[#595959]">
        Your workspace&rsquo;s full agent team. Every agent is available. To
        manage which ones show in your sidebar&rsquo;s Main tab, use the
        &ldquo;⋮&rdquo; menu on an agent and choose Remove.
      </p>

      {}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
        <label className="flex h-10 flex-1 items-center gap-2 rounded-full border border-[#f0f0f0] bg-white px-3">
          <Search className="h-5 w-5 shrink-0 text-[#bfbfbf]" strokeWidth={1.5} aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Agents"
            aria-label="Search agents"
            className="w-full bg-transparent text-[14px] text-[#0e0f11] outline-none placeholder:font-medium placeholder:text-[#bfbfbf]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="shrink-0 text-[16px] leading-none text-[#bfbfbf] hover:text-[#595959]"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </label>
      </div>

      {err && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">
          {err}
        </div>
      )}

      {}
      {raw === null ? (
        <DirectorySkeleton />
      ) : (
        <div className="rounded-2xl border border-[#f0f0f0] bg-white px-6 pb-4 pt-6 shadow-[0px_1px_4px_0px_rgba(16,18,20,0.05),0px_1px_4px_0px_rgba(16,18,20,0.1)]">
          {totalShown === 0 ? (
            <div className="py-8 text-center text-[16px] text-[#595959]">
              {query.trim()
                ? "No agents match your search."
                : "No agents to show."}
            </div>
          ) : (
            groups.map((g, gi) => (
              <div key={g.department}>
                {}
                <div
                  className={cn(
                    "flex items-start gap-2 pb-2 pr-4",
                    gi === 0 ? "pt-0" : "pt-4",
                  )}
                >
                  <span className="flex-1 text-[11px] font-bold uppercase leading-none text-[#595959]">
                    {g.label}
                  </span>
                  <span className="text-[12px] font-medium leading-4 tabular-nums text-[#595959]">
                    {g.rows.length}
                  </span>
                </div>
                <ul>
                  {g.rows.map((r) => {
                    const locked = r.lock !== "none";
                    const lockHint =
                      r.lock === "always_on"
                        ? "Always on, can't be disabled"
                        : r.lock === "staff"
                          ? "Managed by Zavi"
                          : undefined;
                    return (
                      <li
                        key={r.slug}
                        className="flex items-center gap-2.5 px-3 py-2"
                      >
                        <span className={cn("shrink-0", !r.on && "opacity-50")}>
                          <AgentAvatar slug={r.slug} size="sm" shape="tile" />
                        </span>
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[16px] font-semibold tracking-[0.01em]",
                            r.on ? "text-[#0e0f11]" : "text-[#595959]",
                          )}
                        >
                          {r.display}
                        </span>
                        {}
                        <div className="flex shrink-0 items-center gap-2.5">
                          <span
                            className={cn(
                              "text-[16px] font-medium",
                              locked ? "text-[#595959]" : "text-[#0e0f11]",
                            )}
                            title={lockHint}
                          >
                            {r.lock === "always_on"
                              ? "Always on"
                              : r.lock === "staff"
                                ? "Managed"
                                : "Active"}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
