"use client";

import { useState, type ReactNode } from "react";
import {
  useAgentDashboard,
  DashboardShell,
  Kpi,
  KpiStrip,
  EmptyState,
  num,
  ago,
} from "./dashboard-ui";
import { apiFetch } from "@/lib/api";

type ArtifactChip = { id: string; filename: string };

type ValidationMix = {
  validated: number;
  inferred: number;
  assumption: number;
  high_risk: number;
  total: number;
};

type Source = {
  n?: number;
  title?: string;
  url?: string;
  accessed_at?: string;
  source_type?: string;
  capture_status?: string;
};

type Lens = {
  lens?: string;
  label?: string;
  state?: string;
  takeaways?: string[];
  disconfirm?: boolean;
  provenance?: {
    fetched_urls?: string[];
    fetch_errors?: number;
    poisoned?: boolean;
    reason?: string;
  };
};

type Block = Record<string, unknown> & { type?: string };

type ParsedReport = {
  title?: string;
  template?: string;
  subtitle?: string | null;
  query?: string | null;
  blocks?: Block[];
  lenses?: Lens[];
  sources?: Source[];
  validation?: Array<{ tier?: string; text?: string }>;
  failed_lenses?: string[];
  generated_at?: string | null;
};

type ClarificationQuestion = { question: string; why: string };

type RequestRow = {
  run_id: string;
  status: "answered" | "running" | "needs_you";
  query: string;
  template: string;
  generated_at: string | null;
  sources_count: number;
  validation_mix: ValidationMix;
  has_pdf: boolean;
  artifact: ArtifactChip | null;
  report: ParsedReport | null;
  questions: ClarificationQuestion[] | null;
};

type Payload = {
  generic?: boolean;
  kpis: {
    reports_produced: number;
    sources_cited: number;
    pdfs_generated: number;
    last_researched: string | null;
  };
  requests: RequestRow[];
};

const TEMPLATE_LABELS: Record<string, string> = {
  "customer-intel": "Customer intel",
  "competitor-teardown": "Competitor teardown",
  landscape: "Landscape",
  freeform: "Freeform",
};

function templateLabel(t: string): string {
  return TEMPLATE_LABELS[t] ?? t.replace(/[-_]/g, " ");
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const emptyState = (
  <EmptyState title="No research yet - ask a research question to get a cited report.">
    Ask the agent anything in the chat on the right - a competitor teardown, a
    market landscape, who your customers are - and it returns a structured,
    source-cited report. Your research requests appear here as an inbox: answered
    reports expand inline, clarifications wait for your answer, running scans show
    their progress.
  </EmptyState>
);

async function openArtifact(id: string) {
  try {
    const res = await apiFetch(`/api/run-artifacts/${id}/url`);
    if (!res.ok) return;
    const { signed_url } = (await res.json()) as { signed_url?: string };
    if (signed_url) window.open(signed_url, "_blank", "noopener,noreferrer");
  } catch {
  }
}

const MIX_TIERS = [
  { key: "validated", label: "Validated", color: "#167f50" },
  { key: "inferred", label: "Inferred", color: "#3b6fb0" },
  { key: "assumption", label: "Assumption", color: "#8a6d00" },
  { key: "high_risk", label: "High-risk", color: "#cb2029" },
] as const;

function mixPercents(segs: Array<{ count: number }>, total: number): number[] {
  if (total <= 0) return segs.map(() => 0);
  const raw = segs.map((s) => (s.count / total) * 100);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] += 1;
    remainder -= 1;
  }
  return out;
}

function mixSegments(mix: ValidationMix) {
  const present = MIX_TIERS.map((t) => ({ ...t, count: mix[t.key] })).filter(
    (s) => s.count > 0,
  );
  if (present.length === 0) return [];
  const pcts = mixPercents(present, mix.total);
  return present.map((s, i) => ({ ...s, pct: pcts[i] }));
}

function MixMiniBar({ mix }: { mix?: ValidationMix | null }) {
  if (!mix || mix.total <= 0) return null;
  const segs = mixSegments(mix);
  if (segs.length === 0) return null;
  const ariaLabel =
    "Validation mix: " + segs.map((s) => `${s.pct}% ${s.label}`).join(", ");
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className="inline-flex h-2 w-[88px] overflow-hidden rounded-full bg-[#f0f0f0] align-middle"
    >
      {segs.map((s) => (
        <span
          key={s.key}
          aria-hidden
          className="h-full"
          style={{ width: `${s.pct}%`, backgroundColor: s.color }}
        />
      ))}
    </span>
  );
}

function EvidenceCell({ mix }: { mix?: ValidationMix | null }) {
  if (!mix || mix.total <= 0) {
    return <span className="text-[12px] text-[#8a8a8a]">No validation data</span>;
  }
  const segs = mixSegments(mix);
  if (segs.length === 0) {
    return <span className="text-[12px] text-[#8a8a8a]">No validation data</span>;
  }
  const ariaLabel =
    "Validation mix: " + segs.map((s) => `${s.pct}% ${s.label}`).join(", ");
  return (
    <div className="min-w-[160px]">
      <div
        role="img"
        aria-label={ariaLabel}
        className="flex h-2 w-full overflow-hidden rounded-full bg-[#f0f0f0]"
      >
        {segs.map((s) => (
          <span
            key={s.key}
            aria-hidden
            className="h-full"
            style={{ width: `${s.pct}%`, backgroundColor: s.color }}
          />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-[#595959]">
        {segs.map((s) => (
          <span key={s.key} className="tabular-nums">
            {s.label} {s.pct}%
          </span>
        ))}
      </div>
    </div>
  );
}

function isStale(report: ParsedReport | null, generatedAt: string | null): boolean {
  const t = report?.template ?? "";
  if (t !== "competitor-teardown" && t !== "landscape") return false;
  const iso = report?.generated_at ?? generatedAt;
  if (!iso) return false;
  const ms = new Date(iso).getTime();
  return !Number.isNaN(ms) && Date.now() - ms > THIRTY_DAYS_MS;
}

export function trustLine(
  mix: ValidationMix,
  failedLenses: string[],
  stale: boolean,
): string {
  let lead: string;
  if (mix.total <= 0) {
    lead = "No validation breakdown was recorded for this report";
  } else {
    const validatedPct = Math.round((mix.validated / mix.total) * 100);
    const weakPct = Math.round(
      ((mix.assumption + mix.high_risk) / mix.total) * 100,
    );
    if (weakPct > 50) {
      lead = `Read with caution: ${weakPct}% of claims are assumption or high-risk`;
    } else if (mix.validated / mix.total >= 0.5) {
      lead = `Mostly validated: ${validatedPct}% of claims are well-sourced`;
    } else if (validatedPct === 0) {
      lead = "Lightly sourced: no claims are directly validated";
    } else {
      lead = `Lightly sourced: only ${validatedPct}% of claims are directly validated`;
    }
  }
  const caveats: string[] = [];
  if (mix.high_risk > 0) {
    caveats.push(
      `${mix.high_risk} claim${mix.high_risk === 1 ? "" : "s"} ${
        mix.high_risk === 1 ? "is" : "are"
      } high-risk`,
    );
  }
  if (failedLenses.length > 0) {
    caveats.push(
      `${failedLenses.length} research angle${
        failedLenses.length === 1 ? "" : "s"
      } failed (${failedLenses.join(", ")})`,
    );
  }
  if (stale) {
    caveats.push("figures are over a month old");
  }
  return caveats.length ? `${lead}, but ${caveats.join("; ")}.` : `${lead}.`;
}

function TrustStrip({ row }: { row: RequestRow }) {
  const report = row.report;
  const mix = row.validation_mix;
  const failedLenses = report?.failed_lenses ?? [];
  const stale = isStale(report, row.generated_at);
  const line = trustLine(mix, failedLenses, stale);

  const chips: Array<{ text: string; warn?: boolean }> = [
    { text: `${row.sources_count} sources` },
  ];
  if (failedLenses.length > 0) {
    chips.push({
      text: `${failedLenses.length} lens failed: ${failedLenses.join(", ")}`,
      warn: true,
    });
  }
  const poisoned = (report?.lenses ?? []).filter((l) => l.state === "poisoned");
  if (poisoned.length > 0) {
    chips.push({ text: `${poisoned.length} source flagged`, warn: true });
  }
  if (stale) chips.push({ text: "stale figure flagged", warn: true });

  return (
    <div className="rounded-xl border border-[#e5e7eb] bg-[#fafafa] px-3.5 py-3">
      <div className="flex items-start gap-2">
        <span className="mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#0e0f11] text-[11px] font-semibold text-white">
          R
        </span>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
            From your analyst
          </div>
          <div className="mt-0.5 text-[13px] leading-snug text-[#0e0f11]">
            {line}
          </div>
        </div>
      </div>
      {mix.total > 0 ? (
        <div className="mt-2.5">
          <EvidenceCell mix={mix} />
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {chips.map((c, i) => (
          <span
            key={i}
            className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
              c.warn
                ? "border-[#f0e2c0] bg-[#fdfaf0] text-[#8a6d00]"
                : "border-[#e5e3dc] bg-[#f1f0ec] text-[#595959]"
            }`}
          >
            {c.text}
          </span>
        ))}
      </div>
    </div>
  );
}

function citify(md: string): React.ReactNode[] {
  const parts = String(md ?? "").split(/(\[\d+\])/g);
  return parts.map((p, i) => {
    const m = /^\[(\d+)\]$/.exec(p);
    if (m) {
      return (
        <span
          key={i}
          className="mx-0.5 inline-flex items-center rounded border border-[#e5e3dc] bg-[#f1f0ec] px-1 text-[11px] font-semibold tabular-nums text-[#595959] align-baseline"
        >
          {m[1]}
        </span>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

function BlockHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
      {children}
    </div>
  );
}

function ExecSummaryBlock({ b }: { b: Block }) {
  const bottom = typeof b.bottom_line === "string" ? b.bottom_line : "";
  const prose = typeof b.prose_md === "string" ? b.prose_md : "";
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
        So what: bottom line
      </div>
      <div className="mt-0.5 text-[16px] font-semibold leading-snug text-[#0e0f11]">
        {citify(bottom)}
      </div>
      {prose ? (
        <div className="mt-1 text-[13px] leading-relaxed text-[#595959]">
          {citify(prose)}
        </div>
      ) : null}
    </div>
  );
}

function CompetitiveTableBlock({ b }: { b: Block }) {
  const rows = Array.isArray(b.rows) ? (b.rows as Record<string, unknown>[]) : [];
  if (rows.length === 0) return null;
  return (
    <div>
      <BlockHead>Competitive landscape · {rows.length} players</BlockHead>
      <div className="overflow-x-auto rounded-lg border border-[#e5e7eb]">
        <table className="w-full min-w-[460px] border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-[#e5e7eb] bg-[#fafafa] text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
              <th className="px-2.5 py-1.5">Brand</th>
              <th className="px-2.5 py-1.5">Price model</th>
              <th className="px-2.5 py-1.5">Positioning</th>
              <th className="px-2.5 py-1.5">Gap / opening</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f0f0f0]">
            {rows.map((r, i) => (
              <tr key={i} className="align-top text-[#0e0f11]">
                <td className="px-2.5 py-1.5 font-semibold">
                  {String(r.brand ?? "")}
                </td>
                <td className="px-2.5 py-1.5 text-[#595959]">
                  {String(r.price ?? "-")}
                </td>
                <td className="px-2.5 py-1.5 text-[#595959]">
                  {String(r.positioning ?? "")}
                </td>
                <td className="px-2.5 py-1.5">{String(r.gap ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GapListBlock({ b }: { b: Block }) {
  const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
  if (items.length === 0) return null;
  return (
    <div>
      <BlockHead>Gaps &amp; openings · {items.length} found</BlockHead>
      <div className="space-y-2">
        {items.map((g, i) => (
          <div key={i} className="rounded-lg border border-[#e5e7eb] px-3 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
              {String(g.category ?? "")}
            </div>
            <div className="text-[13px] font-semibold text-[#0e0f11]">
              {String(g.title ?? "")}
            </div>
            <div className="mt-0.5 text-[12px] leading-snug text-[#595959]">
              {citify(String(g.body_md ?? ""))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PersonaCardsBlock({ b }: { b: Block }) {
  const cards = Array.isArray(b.cards)
    ? (b.cards as Record<string, unknown>[])
    : Array.isArray(b.items)
      ? (b.items as Record<string, unknown>[])
      : [];
  if (cards.length === 0) return null;
  return (
    <div>
      <BlockHead>Segments</BlockHead>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {cards.map((p, i) => {
          const role =
            typeof p.role === "string"
              ? p.role
              : typeof p.tagline === "string"
                ? p.tagline
                : "";
          const body =
            typeof p.body === "string"
              ? p.body
              : typeof p.commentary_md === "string"
                ? p.commentary_md
                : "";
          return (
            <div key={i} className="rounded-lg border border-[#e5e7eb] px-3 py-2">
              <div className="text-[13px] font-semibold text-[#0e0f11]">
                {String(p.name ?? "")}
              </div>
              {role ? (
                <div className="text-[11px] text-[#8a8a8a]">{role}</div>
              ) : null}
              {body ? (
                <div className="mt-0.5 text-[12px] leading-snug text-[#595959]">
                  {body}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatTilesBlock({ b }: { b: Block }) {
  const tiles = Array.isArray(b.tiles) ? (b.tiles as Record<string, unknown>[]) : [];
  if (tiles.length === 0) return null;
  return (
    <div>
      <BlockHead>Key numbers</BlockHead>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {tiles.map((t, i) => {
          const prior =
            typeof t.prior_value === "string" && t.prior_value && t.prior_value !== "—"
              ? `was ${t.prior_value}`
              : "";
          const asOf = typeof t.as_of === "string" ? t.as_of : "";
          const meta = [prior, asOf ? `as of ${asOf}` : ""].filter(Boolean).join(" · ");
          return (
            <div key={i} className="rounded-lg border border-[#e5e7eb] px-3 py-2">
              <div className="text-[16px] font-semibold tabular-nums text-[#0e0f11]">
                {String(t.value ?? "")}
              </div>
              <div className="text-[11px] leading-snug text-[#595959]">
                {String(t.label ?? "")}
              </div>
              {meta ? (
                <div className="mt-0.5 text-[11px] text-[#8a8a8a]">{meta}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecommendationsBlock({ b }: { b: Block }) {
  const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
  if (items.length === 0) return null;
  return (
    <div>
      <BlockHead>What to do next</BlockHead>
      <ol className="m-0 list-none space-y-2 p-0">
        {items.map((r, i) => (
          <li
            key={i}
            className="flex gap-2.5 rounded-lg border border-[#e5e7eb] px-3 py-2"
          >
            <span
              aria-hidden
              className="mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#0e0f11] text-[11px] font-semibold tabular-nums text-white"
            >
              {typeof r.index === "number" ? r.index : i + 1}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-[13px] font-semibold text-[#0e0f11]">
                  {String(r.title ?? "")}
                </span>
                {typeof r.label === "string" && r.label ? (
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
                    {r.label}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 text-[12px] leading-snug text-[#595959]">
                {citify(String(r.body_md ?? ""))}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RisksBlock({ b }: { b: Block }) {
  const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
  if (items.length === 0) return null;
  return (
    <div>
      <BlockHead>What I&apos;m not sure about</BlockHead>
      <div className="space-y-2">
        {items.map((r, i) => {
          const tone = String(r.tone ?? "");
          const danger = tone === "high-risk" || tone === "warn";
          return (
            <div
              key={i}
              className="rounded-lg border border-[#e5e7eb] px-3 py-2"
            >
              <div className="text-[13px] font-semibold text-[#0e0f11]">
                {danger ? "⚠ " : ""}
                {String(r.title ?? "")}
              </div>
              <div className="mt-0.5 text-[12px] leading-snug text-[#595959]">
                {citify(String(r.body_md ?? ""))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NestedDisclosure({
  summary,
  className,
  children,
}: {
  summary: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded-lg border border-[#e5e7eb] ${className ?? ""}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-semibold text-[#0e0f11]"
      >
        <span aria-hidden className="text-[11px] text-[#8a8a8a]">
          {open ? "▾" : "▸"}
        </span>
        <span className="min-w-0 flex-1">{summary}</span>
      </button>
      {open ? children : null}
    </div>
  );
}

function SourcesDetails({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;
  return (
    <NestedDisclosure
      className="mt-3"
      summary={`Sources (${sources.length}) · with capture status`}
    >
      <div className="space-y-1.5 px-3 pb-3">
        {sources.map((s, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="mt-px inline-flex h-4 min-w-4 items-center justify-center rounded bg-[#f1f0ec] px-1 text-[11px] font-semibold tabular-nums text-[#595959]">
              {s.n ?? i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-[#0e0f11]">
                {s.title ?? s.url ?? "Source"}
              </div>
              {s.url ? (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block truncate text-[11px] text-[#3b6fb0] hover:underline"
                >
                  {s.url}
                </a>
              ) : null}
              <div className="text-[11px] text-[#8a8a8a]">
                {[s.source_type, s.accessed_at ? `accessed ${s.accessed_at}` : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
            {s.capture_status ? (
              <span className="shrink-0 rounded-full border border-[#e5e3dc] bg-[#f1f0ec] px-2 py-0.5 text-[11px] font-semibold text-[#595959]">
                {s.capture_status.replace(/_/g, " ")}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </NestedDisclosure>
  );
}

function LensesDetails({ lenses }: { lenses: Lens[] }) {
  if (lenses.length === 0) return null;
  const anyBad = lenses.some(
    (l) => l.state === "failed" || l.state === "poisoned",
  );
  return (
    <NestedDisclosure
      className="mt-2"
      summary={
        <>
          How I checked ({lenses.length} angles) · per-angle evidence
          {anyBad ? (
            <span className="ml-2 rounded-full border border-[#f0e2c0] bg-[#fdfaf0] px-2 py-0.5 text-[11px] font-semibold text-[#8a6d00]">
              failed / flagged inside
            </span>
          ) : null}
        </>
      }
    >
      <div className="space-y-2 px-3 pb-3">
        {lenses.map((l, i) => {
          const bad = l.state === "failed" || l.state === "poisoned";
          const fetched = l.provenance?.fetched_urls?.length ?? 0;
          const errs = l.provenance?.fetch_errors ?? 0;
          return (
            <div
              key={i}
              className={`rounded-lg border px-3 py-2 ${
                bad ? "border-[#f0e2c0] bg-[#fdfaf0]" : "border-[#e5e7eb]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-[#0e0f11]">
                  {l.label ?? l.lens ?? "Angle"}
                </span>
                {l.state ? (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      bad
                        ? "border border-[#f0e2c0] bg-[#fdfaf0] text-[#8a6d00]"
                        : "border border-[#e5e3dc] bg-[#f1f0ec] text-[#595959]"
                    }`}
                  >
                    {l.state}
                  </span>
                ) : null}
              </div>
              {l.takeaways && l.takeaways.length > 0 ? (
                <ul className="mt-1 list-disc pl-4 text-[12px] text-[#595959]">
                  {l.takeaways.map((t, j) => (
                    <li key={j}>{t}</li>
                  ))}
                </ul>
              ) : (
                <div className="mt-1 text-[11px] text-[#8a8a8a]">
                  No takeaways. The angle didn&apos;t complete.
                </div>
              )}
              <div className="mt-1 text-[11px] text-[#8a8a8a]">
                {fetched} urls fetched · {errs} fetch error{errs === 1 ? "" : "s"}
                {l.disconfirm ? " · disconfirming angle" : ""}
              </div>
              {l.provenance?.reason ? (
                <div className="mt-0.5 text-[11px] text-[#8a6d00]">
                  {l.state === "poisoned" ? "⚠ " : "✕ "}
                  {l.provenance.reason}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </NestedDisclosure>
  );
}

function InboxMemo({ row }: { row: RequestRow }) {
  const report = row.report;
  if (!report) return null;
  const blocks = report.blocks ?? [];
  const pick = (types: string[]) =>
    blocks.filter((b) => typeof b.type === "string" && types.includes(b.type));

  const execBlocks = pick(["exec_summary"]);
  const foundBlocks = pick([
    "competitive_table",
    "gap_list",
    "persona_cards",
    "stat_tiles",
  ]);
  const recBlocks = pick(["recommendations"]);
  const riskBlocks = pick(["risks"]);

  return (
    <div className="space-y-2">
      {}
      <TrustStrip row={row} />

      {}
      <div>
        <span className="inline-flex rounded-full border border-[#e5e3dc] bg-[#f1f0ec] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#595959]">
          {templateLabel(report.template ?? row.template)}
        </span>
      </div>

      {}
      {execBlocks.map((b, i) => (
        <ExecSummaryBlock key={`exec-${i}`} b={b} />
      ))}

      {}
      {foundBlocks.length > 0 ? (
        <div className="rounded-xl border border-[#e5e7eb] bg-[#fafafa] px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#0e0f11]">
            What the research found
          </div>
          <div className="mt-1 space-y-1">
            {foundBlocks.map((b, i) => {
              switch (b.type) {
                case "competitive_table":
                  return <CompetitiveTableBlock key={`found-${i}`} b={b} />;
                case "gap_list":
                  return <GapListBlock key={`found-${i}`} b={b} />;
                case "persona_cards":
                  return <PersonaCardsBlock key={`found-${i}`} b={b} />;
                case "stat_tiles":
                  return <StatTilesBlock key={`found-${i}`} b={b} />;
                default:
                  return null;
              }
            })}
          </div>
        </div>
      ) : null}

      {}
      {recBlocks.map((b, i) => (
        <RecommendationsBlock key={`rec-${i}`} b={b} />
      ))}

      {}
      {riskBlocks.map((b, i) => (
        <RisksBlock key={`risk-${i}`} b={b} />
      ))}

      {}
      <SourcesDetails sources={report.sources ?? []} />
      <LensesDetails lenses={report.lenses ?? []} />

      {row.has_pdf && row.artifact ? (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => void openArtifact(row.artifact!.id)}
            title={row.artifact.filename}
            className="rounded-cta border border-[#e5e7eb] bg-white px-2.5 py-1.5 text-[12px] font-semibold text-[#0e0f11] transition-colors hover:bg-[#f7f4ee]"
          >
            Save PDF
          </button>
        </div>
      ) : null}
    </div>
  );
}

const STATUS_CHIP: Record<
  RequestRow["status"],
  { label: string; glyph: string; cls: string }
> = {
  answered: {
    label: "Answered",
    glyph: "✓",
    cls: "border-[#e5e3dc] bg-[#f1f0ec] text-[#595959]",
  },
  running: {
    label: "Running",
    glyph: "⏳",
    cls: "border-[#e5e3dc] bg-[#f1f0ec] text-[#595959]",
  },
  needs_you: {
    label: "Needs you",
    glyph: "⚠",
    cls: "border-[#f0e2c0] bg-[#fdfaf0] text-[#8a6d00]",
  },
};

function StatusChip({ status }: { status: RequestRow["status"] }) {
  const m = STATUS_CHIP[status];
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-semibold ${m.cls}`}
    >
      <span aria-hidden>{m.glyph}</span>
      {m.label}
    </span>
  );
}

function RequestFeedRow({
  row,
  open,
  onToggle,
}: {
  row: RequestRow;
  open: boolean;
  onToggle: () => void;
}) {
  const bodyId = `req-body-${row.run_id}`;
  const needs = row.status === "needs_you";

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-white ${
        needs ? "border-[#f0e2c0]" : "border-[#e5e7eb]"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="break-words text-[13px] font-semibold leading-snug text-[#0e0f11]">
            {row.query}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#8a8a8a]">
            <span className="font-semibold uppercase tracking-wide">
              {templateLabel(row.template)}
            </span>
            {row.status === "answered" ? (
              <>
                <MixMiniBar mix={row.validation_mix} />
                <span>· {num(row.sources_count)} sources</span>
              </>
            ) : null}
            {row.status === "needs_you" && row.questions ? (
              <span>
                · clarification: {row.questions.length} question
                {row.questions.length === 1 ? "" : "s"}
              </span>
            ) : null}
            <span>· {ago(row.generated_at)}</span>
          </div>
        </div>
        <StatusChip status={row.status} />
        <span aria-hidden className="text-[#8a8a8a]">
          {open ? "⌄" : "›"}
        </span>
      </button>

      {open ? (
        <div
          id={bodyId}
          className="border-t border-[#f0f0f0] px-4 py-3.5 text-[#0e0f11]"
        >
          {row.status === "answered" ? <InboxMemo row={row} /> : null}

          {row.status === "needs_you" ? (
            <div className="space-y-2">
              <div className="text-[12px] text-[#595959]">
                The agent returned a <b>clarification</b> instead of guessing.
                Answer in chat to run this.
              </div>
              {(row.questions ?? []).map((q, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-[#e5e7eb] px-3 py-2"
                >
                  <div className="text-[13px] font-semibold text-[#0e0f11]">
                    {q.question}
                  </div>
                  {q.why ? (
                    <div className="mt-0.5 text-[12px] text-[#8a8a8a]">
                      Why: {q.why}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {row.status === "running" ? (
            <div className="text-[13px] text-[#595959]">
              Researching… checking angles. This updates when the run finishes.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FeedBanner({ needsCount }: { needsCount: number }) {
  if (needsCount > 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[#f0e2c0] bg-[#fdfaf0] px-4 py-2.5">
        <span className="inline-flex items-center whitespace-nowrap rounded-full border border-[#e8dcb4] bg-[#f6f1de] px-2.5 py-1 text-[11px] font-semibold text-[#8a6d00]">
          Needs you · {needsCount}
        </span>
        <span className="text-[13px] text-[#0e0f11]">
          {needsCount === 1 ? "1 question is" : `${needsCount} questions are`}{" "}
          waiting on a clarification before the agent can run it. Answer in chat.
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-xl border border-[#e5e7eb] bg-white px-4 py-2.5">
      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-[#e5e3dc] bg-[#f1f0ec] px-2.5 py-1 text-[11px] font-semibold text-[#595959]">
        All clear
      </span>
      <span className="text-[13px] text-[#595959]">
        Nothing&apos;s waiting on you.
      </span>
    </div>
  );
}

function RequestFeed({ requests }: { requests: RequestRow[] }) {
  const defaultOpen =
    requests.find((r) => r.status === "needs_you") ??
    requests.find((r) => r.status === "answered") ??
    requests[0];
  const [openId, setOpenId] = useState<string | null>(
    defaultOpen ? defaultOpen.run_id : null,
  );
  return (
    <div className="space-y-2.5">
      {requests.map((row) => (
        <RequestFeedRow
          key={row.run_id}
          row={row}
          open={openId === row.run_id}
          onToggle={() =>
            setOpenId((cur) => (cur === row.run_id ? null : row.run_id))
          }
        />
      ))}
    </div>
  );
}

export function ResearchDashboard() {
  const state = useAgentDashboard<Payload>("research");
  return (
    <DashboardShell
      title="Research"
      subtitle="An inbox of your research requests: answered reports expand inline, clarifications wait for you, running scans show progress."
      state={state}
      genericFallback={emptyState}
      render={(d) => {
        const k = d.kpis;
        const requests = d.requests ?? [];
        if (requests.length === 0) return emptyState;
        const needsCount = requests.filter(
          (r) => r.status === "needs_you",
        ).length;
        return (
          <>
            <KpiStrip>
              <Kpi label="Reports produced" value={num(k.reports_produced)} />
              <Kpi label="Sources cited" value={num(k.sources_cited)} />
              <Kpi label="PDFs generated" value={num(k.pdfs_generated)} />
              <Kpi label="Last researched" value={ago(k.last_researched)} />
            </KpiStrip>

            <FeedBanner needsCount={needsCount} />
            <RequestFeed requests={requests} />
          </>
        );
      }}
    />
  );
}
