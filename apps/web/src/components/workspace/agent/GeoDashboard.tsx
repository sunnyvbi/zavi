"use client";

import { EyeOff } from "lucide-react";
import { cx, useOpenStatic } from "../layout/shared";
import {
  useAgentDashboard,
  useExternalRefresh,
  useRefreshingSignal,
  useContainerWidth,
  ago,
  DashboardShell,
  Kpi,
  KpiStrip,
  Pill,
  SectionTitle,
  EmptyState,
  num,
} from "./dashboard-ui";

type Severity = "blocker" | "high" | "medium";

type Finding = { code: string; severity: Severity; summary: string; urls: string[] };

type CrawlerState = "allowed" | "blocked" | "partial" | "unknown";

type Crawler = {
  name: string;
  owner: string;
  obeys_robots: boolean;
  recommended: boolean;
  caveat?: string;
  state: CrawlerState;
  directive: string | null;
  from_wildcard: boolean;
};

type Band = {
  key: string;
  label: string;
  weight: number;
  score: number;
  note: string;
};

type GeoPage = {
  url: string;
  visible_words: number;
  server_rendered: boolean;
  lead_passage_words: number | null;
  lead_in_band: boolean;
  question_headings: number;
  heading_count: number;
  figure_sentences: number;
  has_author: boolean;
  age_days: number | null;
  schema_types: string[];
};

type Geo = {
  status: "ok" | "error";
  site: string | null;
  error_code: string | null;
  fetched_at: string;
  stale: boolean;
  notes: string[];
  pages_analyzed: number;
  score: { total: number; bands: Band[] };
  crawlers: Crawler[];
  llms_txt: boolean | null;
  findings: Finding[];
  pages: GeoPage[];
  not_checked: string[];
};

type Payload = { generic?: boolean; geo?: Geo | null };

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, high: 1, medium: 2 };
const SEVERITY_TONE: Record<Severity, "bad" | "warn" | "neutral"> = {
  blocker: "bad",
  high: "warn",
  medium: "neutral",
};
const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "Blocker",
  high: "High",
  medium: "Medium",
};

const CRAWLER_TONE: Record<CrawlerState, "good" | "bad" | "warn" | "neutral"> = {
  allowed: "good",
  blocked: "bad",
  partial: "warn",
  unknown: "neutral",
};
const CRAWLER_LABEL: Record<CrawlerState, string> = {
  allowed: "Allowed",
  blocked: "Blocked",
  partial: "Partly blocked",
  unknown: "Unknown",
};

function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

const placeholder = (
  <EmptyState title="This area's dashboard is coming online">
    A read of how ready your site is to be cited by AI search will appear here. For
    now, use the chat on the right to direct the agent and review its runs.
  </EmptyState>
);

function SettingsCta({ label }: { label: string }) {
  const openStatic = useOpenStatic();
  return (
    <button
      type="button"
      onClick={() => openStatic("settings")}
      className="inline-flex h-10 items-center rounded-cta bg-[#0e0f11] px-4 text-[16px] font-semibold text-white hover:bg-[#1f1f1f]"
    >
      {label}
    </button>
  );
}

function bandTone(score: number): string {
  if (score >= 70) return "text-[#2e7d32]";
  return score >= 40 ? "text-[#9a7b1a]" : "text-[#c0392b]";
}

function bandLayout(containerWidth: number, count: number) {
  if (containerWidth === 0) return { cols: 0, tail: 1 };
  const cols = containerWidth >= 780 ? 3 : containerWidth >= 460 ? 2 : 1;
  const remainder = count % cols;
  return { cols, tail: remainder === 0 ? 1 : cols - remainder + 1 };
}

function hasCoverage(geo: Geo): boolean {
  return typeof geo.pages_analyzed === "number" && geo.pages_analyzed > 0;
}

const NOT_CHECKED_ID = "geo-not-checked";

function revealNotChecked(e: React.MouseEvent<HTMLAnchorElement>) {
  const el = document.getElementById(NOT_CHECKED_ID);
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.focus({ preventScroll: true });
}

function ScoreCard({ geo }: { geo: Geo }) {
  const measured = hasCoverage(geo);
  const [bandsRef, bandsWidth] = useContainerWidth<HTMLDivElement>();
  const { cols: bandCols, tail: bandTailSpan } = bandLayout(
    bandsWidth,
    geo.score.bands.length,
  );
  const tone = !measured
    ? "#8a8a8a"
    : geo.score.total >= 70
      ? "#2e7d32"
      : geo.score.total >= 40
        ? "#9a7b1a"
        : "#c0392b";
  return (
    <section className="rounded-xl border border-[#e5e7eb] bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-2">
            {measured ? (
              <>
                <span
                  className="text-[30px] font-semibold leading-none"
                  style={{ color: tone }}
                >
                  {geo.score.total}
                </span>
                <span className="text-[14px] font-medium text-[#a0a0a0]">/ 100</span>
              </>
            ) : (
              <span
                className="text-[22px] font-semibold leading-none"
                style={{ color: tone }}
              >
                Not measured
              </span>
            )}
          </div>
          <p className="mt-1 text-[16px] font-medium text-[#1f1f1f]">
            AI-search readiness
          </p>
          {measured ? (
            <>
              <p className="mt-1 text-[13px] font-medium leading-[1.5] text-[#595959]">
                Read {geo.pages_analyzed} page
                {geo.pages_analyzed === 1 ? "" : "s"}.{" "}
                <a
                  href={`#${NOT_CHECKED_ID}`}
                  onClick={revealNotChecked}
                  className="underline decoration-[#d8d2c4] underline-offset-2 hover:decoration-[#8a8a8a]"
                >
                  {geo.not_checked.length} thing
                  {geo.not_checked.length === 1 ? "" : "s"} this score does not
                  include
                </a>
                .
              </p>
              <p className="mt-0.5 max-w-md text-[13px] leading-[1.5] text-[#8a8a8a]">
                Our own heuristic, not a Google signal. Computed only from the pages
                we fetched. It says how citable this site is, never how often it is
                actually cited.
              </p>
            </>
          ) : (
            <p className="mt-1 max-w-md text-[13px] leading-[1.5] text-[#595959]">
              No page could be read, so there is nothing to score yet. A 0 here
              would say this site failed the checks; it did not take them.{" "}
              <a
                href={`#${NOT_CHECKED_ID}`}
                onClick={revealNotChecked}
                className="underline decoration-[#d8d2c4] underline-offset-2 hover:decoration-[#8a8a8a]"
              >
                What this can&apos;t see
              </a>
              .
            </p>
          )}
        </div>
        <span className="shrink-0 text-[13px] text-[#a0a0a0]">
          {geo.site ? `${geo.site} · ` : ""}checked {ago(geo.fetched_at)}
          {geo.stale ? " (couldn't re-check just now)" : ""}
        </span>
      </div>

      {measured ? (
      <div
        ref={bandsRef}
        className={cx(
          "mt-4 grid gap-3",
          bandCols === 0 && "grid-cols-[repeat(auto-fit,minmax(230px,1fr))]",
        )}
        style={
          bandCols === 0
            ? undefined
            : { gridTemplateColumns: `repeat(${bandCols}, minmax(0,1fr))` }
        }
      >
        {geo.score.bands.map((b, i) => (
          <div
            key={b.key}
            className="rounded-xl border border-[#e5e7eb] bg-[#faf9f7] px-3.5 py-3"
            style={
              i === geo.score.bands.length - 1 && bandTailSpan > 1
                ? { gridColumn: `span ${bandTailSpan}` }
                : undefined
            }
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-[14px] font-semibold text-[#1f1f1f]">
                {b.label}
              </span>
              <span className="shrink-0 text-[12px] font-medium tabular-nums text-[#a0a0a0]">
                ×{b.weight}%
              </span>
            </div>
            <div className={cx("mt-2 flex items-center gap-2.5", bandTone(b.score))}>
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#e9e6e0]">
                <div className="h-full rounded-full bg-current" style={{ width: `${b.score}%` }} />
              </div>
              <span className="w-[26px] shrink-0 text-right text-[16px] font-semibold leading-none tabular-nums">
                {b.score}
              </span>
            </div>
            <p className="mt-2 text-[13px] leading-[1.5] text-[#8a8a8a]">{b.note}</p>
          </div>
        ))}
      </div>
      ) : null}
    </section>
  );
}

function CrawlerTable({ crawlers }: { crawlers: Crawler[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#e5e7eb] bg-white">
      <table className="w-full min-w-[600px] text-[16px]">
        <thead>
          <tr className="border-b border-[#e5e7eb] text-left text-[13px] uppercase tracking-wide text-[#8a8a8a]">
            <th className="w-[176px] px-3 py-2 font-medium">Crawler</th>
            <th className="w-[124px] px-3 py-2 font-medium">Access</th>
            <th className="px-3 py-2 font-medium">Read from</th>
          </tr>
        </thead>
        <tbody>
          {crawlers.map((c) => (
            <tr key={c.name} className="border-b border-[#f0ede5] align-top last:border-0">
              <td className="px-3 py-2.5">
                <div className="font-medium text-[#1f1f1f]">{c.name}</div>
                <div className="text-[12px] text-[#a0a0a0]">{c.owner}</div>
              </td>
              <td className="px-3 py-2.5">
                <Pill tone={CRAWLER_TONE[c.state]}>{CRAWLER_LABEL[c.state]}</Pill>
              </td>
              <td className="px-3 py-2.5 text-[13px] leading-[1.55] text-[#8a8a8a]">
                {c.state === "unknown" ? (
                  "robots.txt couldn't be read"
                ) : c.directive ? (
                  <>
                    <code className="inline-block whitespace-nowrap rounded bg-[#f5f3ef] px-1 py-0.5 font-mono text-[12px] text-[#595959]">
                      {c.directive}
                    </code>
                    {c.from_wildcard ? <span className="ml-1.5">via User-agent: *</span> : null}
                  </>
                ) : (
                  "No rule names it, so robots.txt defaults to allow"
                )}
                {c.caveat ? (
                  <p className="mt-1 leading-[1.5] text-[#8a8a8a]">{c.caveat}</p>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  const shown = finding.urls.slice(0, 3);
  const rest = finding.urls.length - shown.length;
  return (
    <li className="flex gap-3 border-b border-[#f0ede5] px-3 py-3 last:border-0">
      <span className="mt-px w-[72px] shrink-0">
        <Pill tone={SEVERITY_TONE[finding.severity]}>{SEVERITY_LABEL[finding.severity]}</Pill>
      </span>
      <div className="min-w-0 flex-1">
        <p className="max-w-[92ch] text-[16px] leading-[1.45] text-[#1f1f1f]">
          {finding.summary}
        </p>
        {shown.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="text-[12px] uppercase tracking-[0.04em] text-[#a0a0a0]">On</span>
            {shown.map((u) => (
              <code
                key={u}
                title={u}
                className="max-w-[24ch] truncate rounded border border-[#e5e7eb] bg-[#faf9f7] px-1.5 py-px font-mono text-[12px] leading-[18px] text-[#595959]"
              >
                {u.startsWith("http") ? pagePath(u) : u}
              </code>
            ))}
            {rest > 0 ? (
              <span className="text-[12px] text-[#a0a0a0]">+{rest} more</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function PageTable({ pages }: { pages: GeoPage[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#e5e7eb] bg-white">
      <table className="w-full min-w-[700px] text-[14px]">
        <thead>
          <tr className="border-b border-[#e5e7eb] text-left text-[13px] uppercase tracking-wide text-[#8a8a8a]">
            <th className="w-[24%] min-w-[136px] px-3 py-2 font-medium">Page</th>
            <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Words (no JS)</th>
            <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Lead answer</th>
            <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Q-headings</th>
            <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Figures</th>
            <th className="w-[168px] px-3 py-2 font-medium">Signals</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.url} className="border-b border-[#f0ede5] last:border-0">
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-[#1f1f1f]" title={p.url}>
                    {pagePath(p.url)}
                  </span>
                  {!p.server_rendered ? (
                    <span className="shrink-0 [&_span]:text-[12px]">
                      <Pill tone="bad">JS-only</Pill>
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-[#8a8a8a]">
                {num(p.visible_words)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {p.lead_passage_words === null ? (
                  <span className="text-[#c0392b]">none</span>
                ) : (
                  <span className={p.lead_in_band ? "text-[#2e7d32]" : "text-[#8a8a8a]"}>
                    {p.lead_passage_words}w
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-[#8a8a8a]">
                {p.question_headings}/{p.heading_count}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-[#8a8a8a]">
                {p.figure_sentences}
              </td>
              <td className="px-3 py-2 [&_span]:text-[12px]">
                <div className="flex flex-wrap gap-1">
                  {p.has_author ? <Pill tone="good">author</Pill> : null}
                  {p.age_days !== null ? (
                    <Pill tone={p.age_days <= 180 ? "good" : "warn"}>{p.age_days}d old</Pill>
                  ) : (
                    <Pill tone="neutral">undated</Pill>
                  )}
                  {p.schema_types.length > 0 ? (
                    <Pill tone="good">{p.schema_types.length} schema</Pill>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GeoDashboard({
  refreshTick,
  active,
  onRefreshingChange,
}: {
  refreshTick?: number;
  active?: boolean;
  onRefreshingChange?: (refreshing: boolean) => void;
} = {}) {
  const state = useAgentDashboard<Payload>("seo-geo");
  useExternalRefresh(state, refreshTick, active);
  useRefreshingSignal(state.refreshing, onRefreshingChange);
  return (
    <DashboardShell
      state={state}
      genericFallback={placeholder}
      showRefresh={refreshTick === undefined}
      render={(d) => {
        const geo = d.geo ?? null;

        if (!geo || geo.status === "error") {
          return geo && geo.error_code !== "seo_site_unknown" ? (
            <EmptyState
              title="Couldn't read your site"
              action={<SettingsCta label="Check the URL in Settings" />}
            >
              Nothing responded at {geo.site ?? "the site on file"}. It may be down,
              blocking crawlers, or the URL on file may be wrong.{" "}
              <button
                type="button"
                onClick={state.refresh}
                className="cursor-pointer font-semibold text-[#1f1f1f] underline"
              >
                Retry
              </button>
            </EmptyState>
          ) : (
            <EmptyState
              title="No website on file yet"
              action={<SettingsCta label="Add your site URL" />}
            >
              Add your site URL and Zavi will read it the way an AI crawler does:
              which crawlers you admit, whether your content survives without
              JavaScript, and whether there is an answer worth quoting. No connector
              needed; there isn&apos;t one to connect.
            </EmptyState>
          );
        }

        const findings = [...geo.findings].sort(
          (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
        );
        const counts = findings.reduce<Record<Severity, number>>(
          (acc, f) => ({ ...acc, [f.severity]: acc[f.severity] + 1 }),
          { blocker: 0, high: 0, medium: 0 },
        );
        const blockedCount = geo.crawlers.filter(
          (c) => c.recommended && c.state === "blocked",
        ).length;
        const ssrPages = geo.pages.filter((p) => p.server_rendered).length;

        return (
          <div className="flex flex-col gap-5">
            <ScoreCard geo={geo} />

            <KpiStrip>
              <Kpi label="Pages checked" value={num(geo.pages_analyzed)} />
              <Kpi
                label="Readable without JS"
                value={`${ssrPages}/${geo.pages_analyzed}`}
              />
              <Kpi
                label="AI crawlers blocked"
                value={`${blockedCount}/${geo.crawlers.filter((c) => c.recommended).length}`}
              />
              <Kpi label="Issues found" value={num(findings.length)} />
            </KpiStrip>

            <section>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <SectionTitle>What to fix</SectionTitle>
                <div className="flex flex-wrap items-center gap-2">
                  {(["blocker", "high", "medium"] as const)
                    .filter((s) => counts[s] > 0)
                    .map((s) => (
                      <Pill key={s} tone={SEVERITY_TONE[s]}>
                        {counts[s]} {SEVERITY_LABEL[s].toLowerCase()}
                      </Pill>
                    ))}
                </div>
              </div>
              {findings.length === 0 && !hasCoverage(geo) ? (
                <EmptyState title="Nothing was checked yet">
                  No page could be read, so there is nothing to report. This is not
                  a clean bill of health.
                </EmptyState>
              ) : findings.length === 0 ? (
                <EmptyState title="Nothing blocking a citation">
                  The {geo.pages_analyzed} page(s) checked admit the AI crawlers,
                  render without JavaScript, and carry an extractable answer. That is
                  readiness, not proof of a citation. No one can measure the latter.
                </EmptyState>
              ) : (
                <ul className="overflow-hidden rounded-xl border border-[#e5e7eb] bg-white">
                  {findings.map((f) => (
                    <FindingRow key={f.code} finding={f} />
                  ))}
                </ul>
              )}
            </section>

            <section>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <SectionTitle>AI crawler access</SectionTitle>
                <span className="text-[13px] text-[#a0a0a0]">
                  {geo.llms_txt === null
                    ? "/llms.txt not checked"
                    : geo.llms_txt
                      ? "/llms.txt present: reported, not scored"
                      : "No /llms.txt. This does not affect citation"}
                </span>
              </div>
              <CrawlerTable crawlers={geo.crawlers} />
              <p className="mt-2 text-[13px] leading-[1.5] text-[#8a8a8a]">
                Read from the robots.txt on your site. Google&apos;s docs say Search
                ignores <code>llms.txt</code> entirely, so its presence carries no
                weight here and adding one is not a fix.
              </p>
            </section>

            {geo.pages.length > 0 ? (
              <section>
                <div className="mb-2">
                  <SectionTitle>Pages, as an AI crawler sees them</SectionTitle>
                </div>
                <PageTable pages={geo.pages} />
                <p className="mt-2 text-[16px] leading-[1.5] text-[#8a8a8a]">
                  Fetched without running JavaScript, because AI crawlers do not run
                  it either. &ldquo;Lead answer&rdquo; is the first self-contained
                  passage in the page&apos;s opening third: the block an AI answer
                  can lift.
                </p>
              </section>
            ) : null}

            {geo.notes.length > 0 ? (
              <ul className="space-y-0.5">
                {geo.notes.map((n) => (
                  <li key={n} className="text-[13px] leading-[1.5] text-[#8a8a8a]">
                    {n}
                  </li>
                ))}
              </ul>
            ) : null}

            {}
            <section
              id={NOT_CHECKED_ID}
              tabIndex={-1}
              aria-labelledby={`${NOT_CHECKED_ID}-title`}
              className="scroll-mt-4 rounded-xl border border-dashed border-[#d8d2c4] bg-white px-4 py-3.5"
            >
              <div className="flex items-center gap-2">
                <EyeOff className="h-4 w-4 shrink-0 text-[#a0a0a0]" aria-hidden />
                <h3
                  id={`${NOT_CHECKED_ID}-title`}
                  className="text-[16px] font-semibold text-[#1f1f1f]"
                >
                  What this can&apos;t see
                </h3>
              </div>
              <ul className="mt-2.5 space-y-2">
                {geo.not_checked.map((n) => (
                  <li key={n} className="flex gap-2.5">
                    <span
                      aria-hidden
                      className="mt-[9px] h-[4px] w-[4px] shrink-0 rounded-full bg-[#a0a0a0]"
                    />
                    <span className="max-w-[86ch] text-[13px] leading-[1.6] text-[#595959]">
                      {n}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        );
      }}
    />
  );
}
