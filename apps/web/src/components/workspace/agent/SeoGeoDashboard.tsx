"use client";

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChannelEmpty, useOpenStatic } from "../layout/shared";
import { SeoPerformanceSections } from "../seo/SeoPerformanceSections";
import type { SeoPerformanceReport } from "../seo/types";
import {
  useAgentDashboard,
  useExternalRefresh,
  useRefreshingSignal,
  ago,
  DashboardShell,
  DashboardMessage,
  Kpi,
  KpiStrip,
  Pill,
  SectionTitle,
  EmptyState,
  num,
} from "./dashboard-ui";

type SummaryRow = { key: string; clicks: number; impressions: number; ctr: number; position: number };

type Severity = "blocker" | "high" | "medium" | "low";

type Finding = {
  code: string;
  severity: Severity;
  summary: string;
  urls: string[];
};

type PageFact = {
  url: string;
  status: number;
  title: string | null;
  title_length: number | null;
  meta_description: string | null;
  canonical: string | null;
  h1_count: number;
  schema_types: string[];
  noindex: boolean;
  visible_words: number;
};

type SiteHealth = {
  status: "ok" | "error";
  site: string | null;
  error_code: string | null;
  fetched_at: string;
  stale: boolean;
  pages_analyzed: number;
  findings: Finding[];
  pages: PageFact[];
  notes: string[];
};

type Payload = {
  generic?: boolean;
  connected: boolean;
  load_error?: boolean;
  site_url?: string;
  start_date?: string;
  end_date?: string;
  totals?: { clicks: number; impressions: number; ctr: number; position: number };
  series?: Array<{ date: string; clicks: number; impressions: number }>;
  top_queries?: SummaryRow[];
  top_pages?: SummaryRow[];
  site_health?: SiteHealth | null;
  performance?: SeoPerformanceReport | null;
};

const CLICKS_COLOR = "#1f4e9c";
const IMPRESSIONS_COLOR = "#00857a";

function ctrPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  middot: "\u00b7",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "\ufffd";
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

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
    A live summary of organic search performance will appear here. For now, use
    the chat on the right to direct the agent and review its runs in the Run tab.
  </EmptyState>
);

function TrendTile({
  label,
  color,
  data,
  dataKey,
}: {
  label: string;
  color: string;
  data: Array<{ date: string; clicks: number; impressions: number }>;
  dataKey: "clicks" | "impressions";
}) {
  const latest = data[data.length - 1];
  return (
    <div className="rounded-xl border border-[#f0f0f0] bg-white px-3 pb-2 pt-2.5">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-medium text-[#595959]">
          <span aria-hidden className="inline-block size-[7px] rounded-full" style={{ backgroundColor: color }} />
          {label}
        </span>
        <span className="text-[14px] font-semibold text-[#0e0f11]">
          {latest ? num(latest[dataKey]) : "-"}
        </span>
      </div>
      <div className="h-[74px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <YAxis domain={[0, "auto"]} hide />
            <XAxis dataKey="date" hide />
            <Tooltip
              cursor={{ stroke: "#d8d8d8", strokeWidth: 1 }}
              content={({ active, payload, label: tipLabel }) =>
                active && payload?.length ? (
                  <div className="rounded-lg border border-[#e5e7eb] bg-white px-2.5 py-1.5 shadow-sm">
                    <p className="text-[12px] text-[#8a8a8a]">{fmtDay(String(tipLabel))}</p>
                    <p className="text-[16px] font-semibold tabular-nums text-[#1f1f1f]">
                      {num(payload[0].value as number)} {label.toLowerCase()}
                    </p>
                  </div>
                ) : null
              }
            />
            <Line
              type="monotone"
              dataKey={dataKey}
              name={label}
              stroke={color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between text-[12px] text-[#a0a0a0]">
        <span>{data.length ? fmtDay(data[0].date) : ""}</span>
        <span>{latest ? fmtDay(latest.date) : ""}</span>
      </div>
    </div>
  );
}

function RowsTable({
  header,
  rows,
  renderKey,
}: {
  header: string;
  rows: SummaryRow[];
  renderKey: (key: string) => React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#e5e7eb] bg-white">
      <table className="w-full text-[14px]">
        <thead>
          <tr className="border-b border-[#e5e7eb] text-left text-[13px] uppercase tracking-wide text-[#8a8a8a]">
            <th className="px-3 py-2 font-medium">{header}</th>
            <th className="px-3 py-2 text-right font-medium">Clicks</th>
            <th className="px-3 py-2 text-right font-medium">Impr.</th>
            <th className="px-3 py-2 text-right font-medium">CTR</th>
            <th className="px-3 py-2 text-right font-medium">Pos.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-[#f0ede5] last:border-0">
              <td className="max-w-0 px-3 py-2">
                <div className="truncate text-[#1f1f1f]">{renderKey(r.key)}</div>
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-[#1f1f1f]">{num(r.clicks)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-[#8a8a8a]">{num(r.impressions)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-[#8a8a8a]">{ctrPct(r.ctr)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-[#8a8a8a]">{r.position.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, high: 1, medium: 2, low: 3 };

const SEVERITY_TONE: Record<Severity, "bad" | "warn" | "neutral"> = {
  blocker: "bad",
  high: "warn",
  medium: "neutral",
  low: "neutral",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: "Blocker",
  high: "High",
  medium: "Medium",
  low: "Notice",
};

function CheckedMeta({ health }: { health: SiteHealth }) {
  return (
    <span className="min-w-0 truncate text-[13px] text-[#a0a0a0]">
      {health.site ? `${health.site} · ` : ""}
      checked {ago(health.fetched_at)}
      {health.stale ? " (couldn't re-check just now)" : ""}
    </span>
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
                {pagePath(u)}
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

function PageFactsTable({ pages }: { pages: PageFact[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#e5e7eb] bg-white">
      <table className="w-full min-w-[560px] text-[14px]">
        <thead>
          <tr className="border-b border-[#e5e7eb] text-left text-[13px] uppercase tracking-wide text-[#8a8a8a]">
            <th className="px-3 py-2 font-medium">Page</th>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 text-right font-medium">H1</th>
            <th className="px-3 py-2 font-medium">Schema</th>
            <th className="px-3 py-2 text-right font-medium">Words</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.url} className="border-b border-[#f0ede5] last:border-0">
              <td className="max-w-0 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[#1f1f1f]" title={p.url}>
                    {pagePath(p.url)}
                  </span>
                  {p.noindex ? <Pill tone="bad">noindex</Pill> : null}
                </div>
              </td>
              <td className="max-w-0 px-3 py-2">
                {p.title ? (
                  <span
                    className="block truncate text-[#595959]"
                    title={decodeEntities(p.title)}
                  >
                    {decodeEntities(p.title)}
                    {p.title_length !== null ? (
                      <span className="text-[#a0a0a0]"> · {p.title_length}ch</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-[#c0392b]">none</span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-[#8a8a8a]">{p.h1_count}</td>
              <td className="max-w-0 px-3 py-2">
                {p.schema_types.length > 0 ? (
                  <span
                    className="block truncate text-[#595959]"
                    title={p.schema_types.join(", ")}
                  >
                    {p.schema_types.join(", ")}
                  </span>
                ) : (
                  <span className="text-[#a0a0a0]">none</span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-[#8a8a8a]">
                {num(p.visible_words)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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

function SiteHealthSection({ health, onRetry }: { health: SiteHealth; onRetry: () => void }) {
  if (health.status === "error") {
    return (
      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <SectionTitle>Site health</SectionTitle>
          <CheckedMeta health={health} />
        </div>
        {health.error_code === "seo_site_unknown" ? (
          <EmptyState
            title="No website on file yet"
            action={<SettingsCta label="Add your site URL" />}
          >
            Add your site URL and Zavi will check it for the things that stop pages
            ranking (indexability, page titles, structured data) with no connector
            needed.
          </EmptyState>
        ) : (
          <EmptyState
            title="Couldn't read your site"
            action={<SettingsCta label="Check the URL in Settings" />}
          >
            {health.notes?.[0] ?? (
              <>
                Nothing responded at {health.site ?? "the site on file"}. It may be down,
                blocking crawlers, or the URL on file may be wrong.
              </>
            )}{" "}
            <button
              type="button"
              onClick={onRetry}
              className="cursor-pointer font-semibold text-[#1f1f1f] underline"
            >
              Retry
            </button>
          </EmptyState>
        )}
      </section>
    );
  }

  const findings = [...health.findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const counts = findings.reduce<Record<Severity, number>>(
    (acc, f) => ({ ...acc, [f.severity]: acc[f.severity] + 1 }),
    { blocker: 0, high: 0, medium: 0, low: 0 },
  );

  return (
    <section>
      <SectionTitle>Site health</SectionTitle>

      <div className="overflow-hidden rounded-xl border border-[#e5e7eb] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-[#e5e7eb] bg-[#faf9f7] px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {findings.length === 0 ? (
              <Pill tone="good">No issues</Pill>
            ) : (
              (["blocker", "high", "medium", "low"] as const)
                .filter((s) => counts[s] > 0)
                .map((s) => (
                  <Pill key={s} tone={SEVERITY_TONE[s]}>
                    {counts[s]} {SEVERITY_LABEL[s].toLowerCase()}
                    {s === "low" && counts[s] !== 1 ? "s" : ""}
                  </Pill>
                ))
            )}
            <span className="text-[13px] text-[#a0a0a0]">
              {(health.pages ?? []).length === 0 && health.pages_analyzed > 0
                ? `read ${health.pages_analyzed} file(s), none of them a web page`
                : `across ${(health.pages ?? []).length} page(s)`}
            </span>
          </div>
          <CheckedMeta health={health} />
        </div>
        {findings.length === 0 ? (
          <p className="px-3 py-3 text-[16px] leading-[1.45] text-[#595959]">
            {(health.pages ?? []).length === 0 && health.pages_analyzed > 0
              ? `The crawl read ${health.pages_analyzed} file(s), but none of them is a web page, so the page checks did not run.`
              : "Every page checked is indexable, claims its own title, and carries structured data. Nothing here is blocking you."}
          </p>
        ) : (
          <ul>
            {findings.map((f) => (
              <FindingRow key={f.code} finding={f} />
            ))}
          </ul>
        )}
      </div>

      {health.notes.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {health.notes.map((n) => (
            <li key={n} className="text-[13px] leading-[1.5] text-[#8a8a8a]">
              {n}
            </li>
          ))}
        </ul>
      ) : null}

      {health.pages.length > 0 ? (
        <div className="mt-3">
          <div className="mb-2">
            <SectionTitle>Pages checked</SectionTitle>
          </div>
          <PageFactsTable pages={health.pages} />
          {}
          <p className="mt-2 text-[13px] leading-[1.5] text-[#8a8a8a]">
            Read from your public site: how your pages are built, not how they
            perform. Clicks, impressions and positions come from Search Console.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function ConnectSearchConsoleNote() {
  const openStatic = useOpenStatic();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-[#d8d2c4] bg-white px-4 py-3">
      <p className="text-[16px] leading-[1.5] text-[#595959]">
        <span className="font-semibold text-[#1f1f1f]">
          Connect Google Search Console
        </span>{" "}
        to add what this can&apos;t see: real clicks, impressions, CTR and the
        queries you already rank for.
      </p>
      <button
        type="button"
        onClick={() => openStatic("settings")}
        className="inline-flex h-8 shrink-0 items-center rounded-cta bg-[#0e0f11] px-3 text-[16px] font-semibold text-white hover:bg-[#1f1f1f]"
      >
        Connect
      </button>
    </div>
  );
}

export function SeoGeoDashboard({
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
        const health = d.site_health ?? null;

        if (!d.connected && !health) {
          return (
            <div className="min-h-[420px]">
              <ChannelEmpty label="SEO" />
            </div>
          );
        }

        const searchLane = !d.connected ? null : d.load_error || !d.totals ? (
          <DashboardMessage>
            Couldn&apos;t reach Google Search Console.{" "}
            <button
              type="button"
              onClick={state.refresh}
              className="cursor-pointer font-semibold text-[#1f1f1f] underline"
            >
              Retry
            </button>
          </DashboardMessage>
        ) : (
          <SearchPerformance d={d} />
        );

        const healthLane = health ? (
          <SiteHealthSection health={health} onRetry={state.refresh} />
        ) : null;

        const performanceLane = <SeoPerformanceSections report={d.performance} />;

        return (
          <div className="flex flex-col gap-5">
            {d.connected ? (
              <>
                {searchLane}
                {performanceLane}
                {healthLane}
              </>
            ) : (
              <>
                {performanceLane}
                {healthLane}
                <ConnectSearchConsoleNote />
              </>
            )}
          </div>
        );
      }}
    />
  );
}

function SearchPerformance({ d }: { d: Payload }) {
  const totals = d.totals;
  if (!totals) return null;
  const series = d.series ?? [];
  const queries = d.top_queries ?? [];
  const pages = d.top_pages ?? [];
  const empty = totals.impressions === 0 && series.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <KpiStrip>
        <Kpi label="Clicks" value={num(totals.clicks)} />
        <Kpi label="Impressions" value={num(totals.impressions)} />
        <Kpi label="CTR" value={ctrPct(totals.ctr)} />
        <Kpi label="Avg position" value={totals.position > 0 ? totals.position.toFixed(1) : "-"} />
      </KpiStrip>

      {empty ? (
        <EmptyState title="No search data yet">
          Search Console has no impressions for {d.site_url} in this window.
          New properties can take a couple of days to report; check back soon.
        </EmptyState>
      ) : (
        <>
          <section>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <SectionTitle>28-day trend</SectionTitle>
              <span className="truncate text-[13px] text-[#a0a0a0]">{d.site_url}</span>
            </div>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
              <TrendTile label="Clicks" color={CLICKS_COLOR} data={series} dataKey="clicks" />
              <TrendTile label="Impressions" color={IMPRESSIONS_COLOR} data={series} dataKey="impressions" />
            </div>
          </section>

          <section>
            <SectionTitle>Top queries</SectionTitle>
            {queries.length === 0 ? (
              <EmptyState title="No queries in this window">
                Queries with very few impressions are hidden by Google.
              </EmptyState>
            ) : (
              <RowsTable header="Query" rows={queries} renderKey={(k) => k} />
            )}
          </section>

          <section>
            <SectionTitle>Top pages</SectionTitle>
            {pages.length === 0 ? (
              <EmptyState title="No pages in this window">
                Pages with very few impressions are hidden by Google.
              </EmptyState>
            ) : (
              <RowsTable
                header="Page"
                rows={pages}
                renderKey={(k) => <span title={k}>{pagePath(k)}</span>}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}
