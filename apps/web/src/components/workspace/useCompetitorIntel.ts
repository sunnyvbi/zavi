"use client";

import { creditRefusalFrom, CreditRefusalError } from "@/lib/workspace/creditRefusal";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export type CompetitorTableRow = {
  brand: string;
  price?: string;
  positioning: string;
  gap: string;
  citations?: unknown;
};

export type LandscapeReport = {
  kind: string;
  template?: string;
  title?: string;
  subtitle?: string;
  blocks?: unknown[];
  sources?: unknown[];
};

export type ReportSource = {
  n: number;
  title: string;
  url: string;
};

export type StatTile = {
  value: string;
  label: string;
  prior_value?: string | null;
  as_of?: string | null;
};

export type MaterialMove = {
  competitor: string;
  move: string;
  why_now: string;
  citations: number[];
};

export type RecStatus = "act" | "snooze" | "dismiss";
export type RecDecision = { status: RecStatus; title: string; updated_at: string };
export type RecDecisionMap = Record<string, RecDecision>;

export function recKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
}

function isRecStatus(v: unknown): v is RecStatus {
  return v === "act" || v === "snooze" || v === "dismiss";
}

export function coerceRecDecisions(v: unknown): RecDecisionMap {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: RecDecisionMap = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0) continue;
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (!isRecStatus(o.status)) continue;
    out[k] = {
      status: o.status,
      title: typeof o.title === "string" ? o.title : "",
      updated_at: typeof o.updated_at === "string" ? o.updated_at : "",
    };
  }
  return out;
}

export type ExecSummary = {
  prose_md: string;
  pull_quote: string | null;
  stat_tiles: StatTile[];
  citations: number[];
};

export type CompetitorDelta = {
  added_brands: string[];
  removed_brands: string[];
  narrative_md: string | null;
};

export type CompetitorSnapshot = {
  week_bucket: string;
  landscape: LandscapeReport;
  delta: CompetitorDelta | null;
  created_at: string;
};

export type CompetitorIntelPayload = {
  enabled: boolean;
  snapshots: CompetitorSnapshot[];
  custom_brands?: string[];
  rec_decisions?: RecDecisionMap;
  scan_in_progress?: boolean;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function blocksOf(landscape: LandscapeReport | null | undefined): Record<string, unknown>[] {
  if (!landscape || !Array.isArray(landscape.blocks)) return [];
  return landscape.blocks.filter(isRecord);
}

export function execSummaryProse(
  landscape: LandscapeReport | null | undefined,
): string | null {
  const b = blocksOf(landscape).find((x) => x.type === "exec_summary");
  return b && typeof b.prose_md === "string" && b.prose_md.trim().length > 0
    ? b.prose_md
    : null;
}

export function execSummaryBlock(
  landscape: LandscapeReport | null | undefined,
): ExecSummary | null {
  const b = blocksOf(landscape).find((x) => x.type === "exec_summary");
  if (!b) return null;
  const prose =
    typeof b.prose_md === "string" && b.prose_md.trim().length > 0
      ? b.prose_md
      : "";
  const pull =
    typeof b.pull_quote === "string" && b.pull_quote.trim().length > 0
      ? b.pull_quote
      : null;
  const tiles: StatTile[] = Array.isArray(b.stat_tiles)
    ? b.stat_tiles.filter(isRecord).flatMap((t) => {
        if (typeof t.value !== "string" || typeof t.label !== "string") return [];
        const prior =
          typeof t.prior_value === "string" && t.prior_value.trim().length > 0
            ? t.prior_value
            : null;
        const asOf =
          typeof t.as_of === "string" && t.as_of.trim().length > 0 ? t.as_of : null;
        return [
          {
            value: t.value,
            label: t.label,
            ...(prior !== null ? { prior_value: prior } : {}),
            ...(asOf !== null ? { as_of: asOf } : {}),
          },
        ];
      })
    : [];
  const citations = Array.isArray(b.citations)
    ? b.citations.filter(
        (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1,
      )
    : [];
  if (!prose && !pull && tiles.length === 0) return null;
  return { prose_md: prose, pull_quote: pull, stat_tiles: tiles, citations };
}

export function reportSources(
  landscape: LandscapeReport | null | undefined,
): ReportSource[] {
  const raw = landscape && Array.isArray(landscape.sources) ? landscape.sources : [];
  const out = raw.filter(isRecord).flatMap((s) => {
    const n = s.n;
    const url = s.url;
    const title = s.title;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return [];
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return [];
    return [
      {
        n,
        url,
        title: typeof title === "string" && title.trim() ? title : url,
      },
    ];
  });
  return out.sort((a, b) => a.n - b.n);
}

export function competitiveRows(
  landscape: LandscapeReport | null | undefined,
): CompetitorTableRow[] | null {
  const b = blocksOf(landscape).find((x) => x.type === "competitive_table");
  if (!b || !Array.isArray(b.rows)) return null;
  const rows = b.rows.filter(isRecord).flatMap((r) =>
    typeof r.brand === "string"
      ? [
          {
            brand: r.brand,
            price: typeof r.price === "string" ? r.price : undefined,
            positioning:
              typeof r.positioning === "string" ? r.positioning : "",
            gap: typeof r.gap === "string" ? r.gap : "",
          },
        ]
      : [],
  );
  return rows.length > 0 ? rows : null;
}

export function genericTable(
  landscape: LandscapeReport | null | undefined,
): { title?: string; columns: string[]; rows: string[][] } | null {
  const b = blocksOf(landscape).find((x) => x.type === "table");
  if (!b || !Array.isArray(b.columns) || !Array.isArray(b.rows)) return null;
  return {
    title: typeof b.title === "string" ? b.title : undefined,
    columns: b.columns.filter((c): c is string => typeof c === "string"),
    rows: b.rows
      .filter((r): r is unknown[] => Array.isArray(r))
      .map((r) => r.map((c) => (typeof c === "string" ? c : String(c ?? "")))),
  };
}

export function isSerializedReportLeak(body: string): boolean {
  const s = body.trim();
  if (!s) return false;
  const LEAK =
    /^\s*(?:[-*]\s+)?\**\s*(?:stat_tiles|rows|tiles|bars|persona_cards)\s*\**\s*:\s*\**\s*(?:\[\s*\{|\{)/im;
  if (LEAK.test(s)) return true;
  const afterTitle = s.replace(/^\*\*[^\n]+\*\*\s*\n+/, "").trim();
  if (/^[[{]/.test(afterTitle)) {
    try {
      JSON.parse(afterTitle);
      return true;
    } catch {
    }
  }
  return false;
}

export function markdownBodies(
  landscape: LandscapeReport | null | undefined,
): string[] {
  return blocksOf(landscape).flatMap((b) =>
    b.type === "markdown" &&
    typeof b.body_md === "string" &&
    !isSerializedReportLeak(b.body_md)
      ? [b.body_md]
      : [],
  );
}

export function recommendationItems(
  landscape: LandscapeReport | null | undefined,
): { title: string; body_md: string }[] | null {
  for (const b of blocksOf(landscape)) {
    if (b.type !== "recommendations" || !Array.isArray(b.items)) continue;
    const items = (b.items as unknown[]).flatMap((it) => {
      if (typeof it !== "object" || it === null) return [];
      const o = it as Record<string, unknown>;
      if (typeof o.title !== "string" || o.title.trim() === "") return [];
      return [
        {
          title: o.title,
          body_md: typeof o.body_md === "string" ? o.body_md : "",
        },
      ];
    });
    if (items.length > 0) return items;
  }
  return null;
}

export function materialMoves(
  landscape: LandscapeReport | null | undefined,
): MaterialMove[] | null {
  for (const b of blocksOf(landscape)) {
    if (b.type !== "material_moves" || !Array.isArray(b.items)) continue;
    const items = (b.items as unknown[]).flatMap((it) => {
      if (typeof it !== "object" || it === null) return [];
      const o = it as Record<string, unknown>;
      const move = typeof o.move === "string" ? o.move.trim() : "";
      const why = typeof o.why_now === "string" ? o.why_now.trim() : "";
      if (move === "" && why === "") return [];
      return [
        {
          competitor: typeof o.competitor === "string" ? o.competitor : "",
          move,
          why_now: why,
          citations: Array.isArray(o.citations)
            ? o.citations.filter(
                (n): n is number =>
                  typeof n === "number" && Number.isInteger(n) && n >= 1,
              )
            : [],
        },
      ];
    });
    if (items.length > 0) return items;
  }
  return null;
}

export function brandCount(
  landscape: LandscapeReport | null | undefined,
): number | null {
  const rows = competitiveRows(landscape);
  return rows ? rows.length : null;
}

let cached: CompetitorIntelPayload | null = null;
let lastError: string | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of Array.from(listeners)) l();
}

const POLL_MS = 20_000;
const MAX_POLLS = 45;

export function shouldPollScan(p: CompetitorIntelPayload | null): boolean {
  return !!p && p.scan_in_progress === true && (p.snapshots?.length ?? 0) === 0;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollCount = 0;

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollCount = 0;
}

function syncPolling(): void {
  if (!shouldPollScan(cached)) {
    stopPolling();
    return;
  }
  if (pollTimer !== null) return;
  pollCount = 0;
  pollTimer = setInterval(() => {
    if (pollCount >= MAX_POLLS) {
      stopPolling();
      return;
    }
    pollCount += 1;
    void load(true);
  }, POLL_MS);
}

function load(force: boolean): Promise<void> {
  if (cached && !force) return Promise.resolve();
  if (inflight) return inflight;
  if (force) {
    lastError = null;
    notify();
  }
  inflight = (async () => {
    try {
      const res = await apiFetch("/api/competitor-intel", {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Partial<CompetitorIntelPayload>;
      cached = {
        enabled: body.enabled === true,
        snapshots: Array.isArray(body.snapshots) ? body.snapshots : [],
        custom_brands: Array.isArray(body.custom_brands)
          ? body.custom_brands.filter((s): s is string => typeof s === "string")
          : [],
        rec_decisions: coerceRecDecisions(body.rec_decisions),
        scan_in_progress: body.scan_in_progress === true,
      };
      lastError = null;
    } catch (e) {
      lastError = e instanceof Error ? e.message : "Failed to load";
    } finally {
      inflight = null;
      notify();
      syncPolling();
    }
  })();
  return inflight;
}

export type UseCompetitorIntel = {
  data: CompetitorIntelPayload | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

export function useCompetitorIntel(): UseCompetitorIntel {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void load(false);
    syncPolling();
    return () => {
      listeners.delete(l);
      if (listeners.size === 0) stopPolling();
    };
  }, []);
  const refetch = useCallback(() => {
    void load(true);
  }, []);
  return {
    data: cached,
    loading: cached === null && lastError === null,
    error: lastError,
    refetch,
  };
}

export type SaveBrandsResult = { brands: string[]; dropped: number };

export async function saveCustomBrands(brands: string[]): Promise<SaveBrandsResult> {
  const res = await apiFetch("/api/competitor-intel/custom-brands", {
    method: "POST",
    body: JSON.stringify({ brands }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: { message?: string; code?: string } };
      msg = b?.error?.message || b?.error?.code || msg;
    } catch {
    }
    throw new Error(msg);
  }
  const body = (await res.json()) as { brands?: unknown; dropped?: unknown };
  const result: SaveBrandsResult = {
    brands: Array.isArray(body.brands)
      ? body.brands.filter((s): s is string => typeof s === "string")
      : [],
    dropped: typeof body.dropped === "number" ? body.dropped : 0,
  };
  if (cached) {
    cached = { ...cached, custom_brands: result.brands };
    notify();
  }
  return result;
}

export type FirstScanResult = { status: "started" | "already_running"; run_id?: string };

export async function startFirstScan(): Promise<FirstScanResult> {
  const res = await apiFetch("/api/competitor-intel/first-scan", { method: "POST" });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let b: { error?: { message?: string; code?: string } } | null = null;
    try {
      b = (await res.json()) as { error?: { message?: string; code?: string } };
      msg = b?.error?.message || b?.error?.code || msg;
    } catch {
    }
    const credit = creditRefusalFrom(b, "scan");
    if (credit) throw new CreditRefusalError(credit);
    throw new Error(msg);
  }
  const body = (await res.json()) as { status?: unknown; run_id?: unknown };
  const status = body.status === "started" ? "started" : "already_running";
  if (cached) {
    cached = { ...cached, scan_in_progress: true };
    notify();
    syncPolling();
  }
  return { status, run_id: typeof body.run_id === "string" ? body.run_id : undefined };
}

export function logRecEvent(
  event: "ask_agent" | "decision",
  opts: { agent_slug?: string; status?: string } = {},
): void {
  try {
    void apiFetch("/api/competitor-intel/rec-event", {
      method: "POST",
      body: JSON.stringify({ event, ...opts }),
    }).catch(() => {});
  } catch {
  }
}

export async function saveRecDecision(
  rec_key: string,
  title: string,
  status: RecStatus | "clear",
): Promise<RecDecisionMap> {
  const res = await apiFetch("/api/competitor-intel/rec-decisions", {
    method: "POST",
    body: JSON.stringify({ rec_key, title, status }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: { message?: string; code?: string } };
      msg = b?.error?.message || b?.error?.code || msg;
    } catch {
    }
    throw new Error(msg);
  }
  const body = (await res.json()) as { rec_decisions?: unknown };
  const decisions = coerceRecDecisions(body.rec_decisions);
  if (cached) {
    cached = { ...cached, rec_decisions: decisions };
    notify();
  }
  return decisions;
}
