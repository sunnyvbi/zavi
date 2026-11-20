"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Skeleton } from "../Skeleton";
import { ISSUE_COPY } from "../seo/issueCopy";
import { SITE_FUNCTIONS_TIMEOUT_MESSAGE, withDeadline } from "./SiteFunctionsSettings";
import { agoText } from "./siteDashboardFormat";

export const SITE_SEO_TIMEOUT_MS = 60_000;

type Severity = "blocker" | "high" | "medium" | "low";
export type SiteSeoFinding = { code: string; severity: Severity; summary: string; urls: string[] };
export type SiteSeoPayload =
  | { state: "not_live" }
  | {
      state: "ready" | "error";
      url: string;
      fetched_at: string;
      current: boolean;
      error_code: string | null;
      notes: string[];
      seo: {
        pages_analyzed: number;
        non_html_urls?: string[];
        findings: SiteSeoFinding[];
        pages: Array<{ url: string; status: number; title: string | null; meta_description: string | null; noindex: boolean; visible_words: number }>;
      } | null;
      geo: {
        score: { total: number };
        crawlers: Array<{ name: string; owner: string; state: "allowed" | "blocked" | "partial" | "unknown"; recommended: boolean }>;
        llms_txt: boolean | null;
        findings: SiteSeoFinding[];
        not_checked: string[];
      } | null;
      refresh_after: string | null;
    };

export const SEO_TITLE = "SEO & AI search";
export const SEO_INTRO = "What Google and AI assistants read when they visit your live site, and what to fix.";
export const SEO_NOT_LIVE = "Publish your site and Zavi checks what search engines and AI assistants can read on it.";
export const SEO_CHECKING = "Checking your live site. The first check takes up to half a minute.";
export const SEO_NO_ISSUES = "Nothing to fix. Search engines and AI crawlers can read every page we checked.";
export const SEO_STALE = "Your site changed since this check. Refresh to check the version that is live now.";

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_TEXT: Record<Severity, string> = { blocker: "Fix first", high: "Important", medium: "Worth fixing", low: "Minor" };
const SEVERITY_TONE: Record<Severity, string> = {
  blocker: "bg-[#fdf3f2] text-[#a8332c]",
  high: "bg-[#fdf3f2] text-[#a8332c]",
  medium: "bg-[#fdf7e8] text-[#8a5a00]",
  low: "bg-[#f4f4f4] text-[#595959]",
};

export type SeoIssue = { key: string; area: "Search" | "AI search"; severity: Severity; title: string; why: string | null; request: string };

export function seoIssues(data: Extract<SiteSeoPayload, { state: "ready" | "error" }>): SeoIssue[] {
  const out: SeoIssue[] = [];
  const other = new Set(data.seo?.non_html_urls ?? []);
  const add = (f: SiteSeoFinding, area: SeoIssue["area"]) => {
    const copy = ISSUE_COPY[f.code];
    const files = f.urls.filter((u) => other.has(u)).length;
    const pages = f.urls.length - files;
    const title = !copy
      ? f.summary
      : pages === 0 && files > 0
        ? copy.title(files).replace(/\bpages\b/g, "files").replace(/\bpage\b/g, "file")
        : files > 0
          ? `${copy.title(pages)}, plus ${files} other ${files === 1 ? "file" : "files"}`
          : copy.title(Math.max(1, pages));
    out.push({
      key: `${area}:${f.code}`,
      area,
      severity: f.severity,
      title,
      why: copy?.why ?? null,
      request: `Fix this on my site: ${title.replace(/\.$/, "")}.`,
    });
  };
  for (const f of data.seo?.findings ?? []) add(f, "Search");
  for (const f of data.geo?.findings ?? []) add(f, "AI search");
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

const card = "rounded-xl border border-[#f0f0f0] bg-white";
const btn = "inline-flex h-8 items-center gap-1.5 rounded-cta border border-[#e5e5e5] px-3 text-[13px] font-medium text-[#0e0f11] hover:bg-[#f9f9f9] disabled:opacity-50";

function Header({ right }: { right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[20px] font-semibold leading-7 text-[#0e0f11]">{SEO_TITLE}</h2>
        <p className="mt-0.5 max-w-[560px] text-[13px] text-[#8c8c8c]">{SEO_INTRO}</p>
      </div>
      {right}
    </div>
  );
}

export function SiteSeoSkeleton({ note }: { note?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading SEO & AI search" data-section-skeleton="seo" className="mx-auto flex max-w-[840px] flex-col gap-4 p-4 sm:p-6">
      <Header />
      {note && <p className="text-[13px] text-[#595959]">{note}</p>}
      <div aria-hidden className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} data-skeleton-row className={`${card} p-4`}>
            <Skeleton className="h-3 w-24" delayMs={i * 120} />
            <Skeleton className="mt-3 h-7 w-20" delayMs={i * 120} />
          </div>
        ))}
      </div>
      <div aria-hidden data-skeleton-row className={`${card} p-4`}>
        <Skeleton className="h-4 w-48" delayMs={240} />
        <Skeleton className="mt-3 h-4 w-full" delayMs={240} />
        <Skeleton className="mt-2 h-4 w-3/4" delayMs={240} />
      </div>
    </div>
  );
}

function CopyRequest({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={btn}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2500);
        } catch {
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? "Copied" : "Copy request"}
    </button>
  );
}

const CRAWLER_STATE: Record<"allowed" | "blocked" | "partial" | "unknown", string> = {
  allowed: "Allowed",
  partial: "Allowed",
  blocked: "Blocked",
  unknown: "Unknown",
};

export function SiteSeoReport({ data, nowMs }: { data: Extract<SiteSeoPayload, { state: "ready" | "error" }>; nowMs: number }) {
  if (data.state === "error") {
    return (
      <div className={`${card} p-6 text-center`} data-seo-empty="unreachable">
        <p className="text-[14px] font-semibold text-[#0e0f11]">We couldn&rsquo;t read your site</p>
        <p className="mx-auto mt-1 max-w-[440px] text-[13px] leading-5 text-[#595959]">
          {data.notes[0] ?? `Nothing answered at ${data.url} when we checked ${agoText(data.fetched_at, nowMs).toLowerCase()}.`} A paused site wakes when someone opens it; open it, then refresh this check in a minute.
        </p>
      </div>
    );
  }
  const issues = seoIssues(data);
  const crawlers = (data.geo?.crawlers ?? []).filter((c) => c.recommended);
  const open = crawlers.filter((c) => c.state === "allowed" || c.state === "partial").length;
  const pages = data.seo?.pages ?? [];
  return (
    <>
      {!data.current && <p className="rounded-xl border border-[#f0e2bf] bg-[#fdf7e8] px-4 py-3 text-[13px] text-[#8a5a00]">{SEO_STALE}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className={`${card} p-4`}>
          <p className="text-[12px] font-medium text-[#8c8c8c]">Issues to fix</p>
          <p className="mt-1 text-[28px] font-semibold leading-9 tabular-nums text-[#0e0f11]">{issues.length}</p>
          <p className="mt-0.5 text-[12px] text-[#595959]">
            {pagesCheckedWords(pages.length, data.seo?.pages_analyzed ?? 0)}
          </p>
        </div>
        <div className={`${card} p-4`}>
          <p className="text-[12px] font-medium text-[#8c8c8c]">AI search readiness</p>
          <p className="mt-1 text-[28px] font-semibold leading-9 tabular-nums text-[#0e0f11]">
            {data.geo?.score.total ?? 0}
            <span className="text-[15px] font-medium text-[#8c8c8c]"> / 100</span>
          </p>
          <p className="mt-0.5 text-[12px] text-[#595959]">
            {crawlers.length ? `${open} of ${crawlers.length} AI crawlers may read your site` : "No AI crawler rules found"}
          </p>
        </div>
      </div>

      <div className={card}>
        <p className="border-b border-[#f0f0f0] px-4 py-3 text-[13px] font-medium text-[#0e0f11]">What to fix</p>
        {issues.length === 0 ? (
          <p className="px-4 py-4 text-[13px] text-[#595959]">
            {pages.length === 0 && (data.seo?.pages_analyzed ?? 0) > 0 ? `${pagesCheckedWords(0, data.seo?.pages_analyzed ?? 0)}.` : SEO_NO_ISSUES}
          </p>
        ) : (
          <ul className="divide-y divide-[#f0f0f0]">
            {issues.map((i) => (
              <li key={i.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-1.5 py-[1px] text-[11px] font-semibold ${SEVERITY_TONE[i.severity]}`}>{SEVERITY_TEXT[i.severity]}</span>
                    <span className="text-[11px] font-medium text-[#8c8c8c]">{i.area}</span>
                  </div>
                  <p className="mt-1 text-[13px] font-medium text-[#0e0f11]">{i.title}</p>
                  {i.why && <p className="mt-0.5 text-[12px] leading-5 text-[#595959]">{i.why}</p>}
                </div>
                <CopyRequest text={i.request} />
              </li>
            ))}
          </ul>
        )}
        {issues.length > 0 && <p className="border-t border-[#f0f0f0] px-4 py-2.5 text-[12px] text-[#8c8c8c]">Paste a request into the chat and Zavi makes the change.</p>}
      </div>

      {pages.length > 0 && (
        <div className={card}>
          <p className="border-b border-[#f0f0f0] px-4 py-3 text-[13px] font-medium text-[#0e0f11]">How your pages show in search</p>
          <ul className="divide-y divide-[#f0f0f0]">
            {pages.map((p) => (
              <li key={p.url} className="px-4 py-3">
                <p className="truncate text-[12px] text-[#8c8c8c]">{pathOf(p.url)}{p.noindex ? " · hidden from search" : ""}</p>
                <p className="truncate text-[14px] font-medium text-[#1a0dab]">{p.title || "No title"}</p>
                <p className="line-clamp-2 text-[12px] leading-5 text-[#595959]">{p.meta_description || "No description: search engines pick their own snippet."}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {crawlers.length > 0 && (
        <div className={card}>
          <p className="border-b border-[#f0f0f0] px-4 py-3 text-[13px] font-medium text-[#0e0f11]">AI crawlers</p>
          <ul className="grid grid-cols-1 gap-x-6 px-4 py-2 sm:grid-cols-2">
            {crawlers.map((c) => (
              <li key={c.name} className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
                <span className="min-w-0 truncate text-[#0e0f11]">
                  {c.name} <span className="text-[#8c8c8c]">· {c.owner}</span>
                </span>
                <span className={c.state === "blocked" ? "text-[#a8332c]" : c.state === "unknown" ? "text-[#8c8c8c]" : "text-[#1a7f37]"}>{CRAWLER_STATE[c.state]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[12px] leading-5 text-[#8c8c8c]">
        Checked {agoText(data.fetched_at, nowMs).toLowerCase()} at {data.url}.
        {(data.geo?.not_checked ?? []).length > 0 ? ` Not checked: ${data.geo!.not_checked.join("; ")}.` : ""}
        {data.notes.length > 0 ? ` ${data.notes.join(" ")}` : ""}
      </p>
    </>
  );
}

export function SiteSeoView({
  buildSessionId,
  deployedUrl,
  canRefresh,
}: {
  buildSessionId: string;
  deployedUrl: string | null;
  canRefresh: boolean;
}) {
  const [data, setData] = useState<SiteSeoPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "refresh" | null>("load");
  const [nonce, setNonce] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const live = !!deployedUrl;

  const read = useCallback(
    async (refresh: boolean, signal: AbortSignal) => {
      const res = refresh
        ? await apiFetch("/api/website/site-seo/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ build_session_id: buildSessionId }),
            signal,
          })
        : await apiFetch(`/api/website/site-seo?build_session_id=${encodeURIComponent(buildSessionId)}`, { signal });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(typeof body?.error?.message === "string" ? body.error.message : "We couldn't check your site. Try again.");
      return body as SiteSeoPayload;
    },
    [buildSessionId],
  );

  const run = useCallback(
    (refresh: boolean) => {
      const deadline = withDeadline(SITE_SEO_TIMEOUT_MS);
      setBusy(refresh ? "refresh" : "load");
      setError(null);
      void read(refresh, deadline.signal)
        .then((d) => {
          setData(d);
          setNowMs(Date.now());
        })
        .catch((e: unknown) => setError(deadline.timedOut() ? SITE_FUNCTIONS_TIMEOUT_MESSAGE : (e as Error).message || "We couldn't check your site. Try again."))
        .finally(() => {
          deadline.dispose();
          setBusy(null);
        });
      return deadline;
    },
    [read],
  );

  useEffect(() => {
    if (!live) return;
    const d = run(false);
    return () => d.dispose();
  }, [live, run, nonce]);

  const refreshAfter = data && data.state !== "not_live" ? data.refresh_after : null;
  useEffect(() => {
    const at = refreshAfter ? Date.parse(refreshAfter) : NaN;
    if (!Number.isFinite(at)) return;
    const wait = at - Date.now();
    if (wait <= 0) return;
    const t = window.setTimeout(() => setNowMs(Date.now()), wait + 250);
    return () => window.clearTimeout(t);
  }, [refreshAfter]);

  if (!live) {
    return (
      <div className="mx-auto flex max-w-[840px] flex-col gap-4 p-4 sm:p-6">
        <Header />
        <div className={`${card} p-6 text-center`} data-seo-empty="not-live">
          <p className="text-[14px] font-semibold text-[#0e0f11]">Not live yet</p>
          <p className="mx-auto mt-1 max-w-[420px] text-[13px] leading-5 text-[#595959]">{SEO_NOT_LIVE}</p>
        </div>
      </div>
    );
  }
  if (busy === "load" && !data) return <SiteSeoSkeleton note={SEO_CHECKING} />;

  const report = data && data.state !== "not_live" ? data : null;
  const waitUntil = report?.refresh_after ? Date.parse(report.refresh_after) : 0;
  const cooling = waitUntil > nowMs;
  return (
    <div className="mx-auto flex max-w-[840px] flex-col gap-4 p-4 sm:p-6">
      <Header
        right={
          report && canRefresh ? (
            <button
              type="button"
              className={btn}
              disabled={busy !== null || cooling}
              title={cooling ? "Checked moments ago" : undefined}
              onClick={() => run(true)}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy === "refresh" ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden />
              {busy === "refresh" ? "Checking…" : "Check again"}
            </button>
          ) : undefined
        }
      />
      {error && (
        <div role="alert" className="rounded-xl border border-[#f5c2c0] bg-[#fdf3f2] p-4 text-[13px] text-[#a8332c]">
          <p>{error}</p>
          {!report && (
            <button type="button" className={`${btn} mt-3`} onClick={() => setNonce((n) => n + 1)}>
              Try again
            </button>
          )}
        </div>
      )}
      {data?.state === "not_live" && (
        <div className={`${card} p-6 text-center`} data-seo-empty="not-live">
          <p className="mx-auto max-w-[420px] text-[13px] leading-5 text-[#595959]">{SEO_NOT_LIVE}</p>
        </div>
      )}
      {report && <SiteSeoReport data={report} nowMs={nowMs} />}
    </div>
  );
}

function pagesCheckedWords(pages: number, filesRead: number): string {
  if (pages === 0 && filesRead > 0) return `Read ${filesRead} ${filesRead === 1 ? "file" : "files"}, none of them a web page`;
  return pages === 1 ? "On the 1 page we checked" : `Across the ${pages} pages we checked`;
}
