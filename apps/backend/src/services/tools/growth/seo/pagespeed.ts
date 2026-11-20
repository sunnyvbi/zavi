
import { z } from "zod";

import {
  type GoogleApiUnavailable,
  notConfigured,
  readGoogleApiKey,
  requestGoogleJson,
} from "./google-api";
import { extractCulprits, type PsiCulprit } from "./psi-culprits";

export type { PsiCulprit, PsiCulpritKind, PsiCulpritOwner } from "./psi-culprits";
export { MAX_CULPRITS } from "./psi-culprits";

export const PAGESPEED_TIMEOUT_MS = 180_000;

const PAGESPEED_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export const REQUESTED_CATEGORIES = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
] as const;

export const AGENTIC_BROWSING_CATEGORY_ID = "agentic-browsing";

export const MAX_OPPORTUNITIES = 8;

export type PsiAudit = {
  id: string;
  title: string | null;
  score: number | null;
  scoreDisplayMode: string | null;
  status: "pass" | "fail" | "not_applicable" | "unknown";
};

export type PsiCategory = {
  id: string;
  title: string | null;
  score: number | null;
  scoreDisplayMode: string | null;
  audits: PsiAudit[] | null;
};

export const PSI_METRICS = ["LCP", "INP", "CLS", "FCP", "TBT"] as const;
export type PsiMetricName = (typeof PSI_METRICS)[number];

export type PsiMetricSaving = {
  metric: PsiMetricName;
  value: number;
  unit: "ms" | "score";
};

export type PsiOpportunity = {
  id: string;
  title: string | null;
  score: number | null;
  metricSavings: PsiMetricSaving[];
  savingsMs: number | null;
  savingsBytes: number | null;
  culprits: PsiCulprit[];
};

export type PagespeedReport = {
  kind: "ok";
  requested_url: string;
  strategy: "mobile" | "desktop";
  final_url: string | null;
  fetch_time: string | null;
  lighthouse_version: string | null;
  categories: PsiCategory[];
  agentic_browsing: PsiCategory | null;
  opportunities: PsiOpportunity[];
  server_response_ms: number | null;
};

export type PagespeedResult = PagespeedReport | GoogleApiUnavailable;

const auditRefSchema = z
  .object({ id: z.string().optional().catch(undefined) })
  .catch({});

const categorySchema = z
  .object({
    id: z.string().optional().catch(undefined),
    title: z.string().optional().catch(undefined),
    score: z.number().nullable().optional().catch(undefined),
    scoreDisplayMode: z.string().optional().catch(undefined),
    categoryScoreDisplayMode: z.string().optional().catch(undefined),
    auditRefs: z.array(z.unknown()).optional().catch(undefined),
  })
  .catch({});

const auditSchema = z
  .object({
    id: z.string().optional().catch(undefined),
    title: z.string().optional().catch(undefined),
    score: z.number().nullable().optional().catch(undefined),
    scoreDisplayMode: z.string().optional().catch(undefined),
    metricSavings: z.record(z.string(), z.number()).optional().catch(undefined),
    numericValue: z.number().optional().catch(undefined),
    details: z
      .object({
        overallSavingsMs: z.number().optional().catch(undefined),
        overallSavingsBytes: z.number().optional().catch(undefined),
        items: z.array(z.unknown()).optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .catch({});

const SERVER_RESPONSE_AUDIT_ID = "server-response-time";

const envelopeSchema = z
  .object({
    lighthouseResult: z
      .object({
        lighthouseVersion: z.string().optional().catch(undefined),
        finalUrl: z.string().optional().catch(undefined),
        finalDisplayedUrl: z.string().optional().catch(undefined),
        fetchTime: z.string().optional().catch(undefined),
        categories: z.record(z.string(), z.unknown()).optional().catch(undefined),
        audits: z.record(z.string(), z.unknown()).optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .catch({});

function statusOf(score: number | null, mode: string | null): PsiAudit["status"] {
  if (mode === "notApplicable") return "not_applicable";
  if (mode === "informative" || mode === "manual" || mode === "error") return "unknown";
  if (score === null) return "unknown";
  if (score >= 1) return "pass";
  return "fail";
}

function auditFrom(id: string, raw: unknown): PsiAudit {
  const parsed = auditSchema.parse(raw);
  const score = parsed.score ?? null;
  const mode = parsed.scoreDisplayMode ?? null;
  return {
    id: parsed.id ?? id,
    title: parsed.title ?? null,
    score,
    scoreDisplayMode: mode,
    status: statusOf(score, mode),
  };
}

function isFraction(mode: string | null): boolean {
  return mode === "fraction";
}

const METRIC_GOOD_THRESHOLD: Record<PsiMetricName, number> = {
  LCP: 2500,
  INP: 200,
  CLS: 0.1,
  FCP: 1800,
  TBT: 200,
};

const OVERLAPPING_AUDITS: readonly (readonly string[])[] = [
  ["mainthread-work-breakdown", "long-tasks", "bootup-time"],
];

function severityOf(o: PsiOpportunity): number {
  let best = 0;
  for (const s of o.metricSavings) {
    best = Math.max(best, s.value / METRIC_GOOD_THRESHOLD[s.metric]);
  }
  return best;
}

export function rankOpportunities(opportunities: PsiOpportunity[]): PsiOpportunity[] {
  const kept = dropOverlapping(opportunities);
  const measured = kept.filter((o) => o.metricSavings.length > 0);
  const legacyOnly = kept.filter((o) => o.metricSavings.length === 0);

  measured.sort((a, b) => severityOf(b) - severityOf(a) || a.id.localeCompare(b.id));
  legacyOnly.sort(
    (a, b) =>
      (b.savingsMs ?? 0) - (a.savingsMs ?? 0) ||
      (b.savingsBytes ?? 0) - (a.savingsBytes ?? 0) ||
      a.id.localeCompare(b.id),
  );
  return [...measured, ...legacyOnly];
}

function dropOverlapping(opportunities: PsiOpportunity[]): PsiOpportunity[] {
  const dropped = new Set<string>();
  const donated = new Map<string, PsiCulprit[]>();
  for (const group of OVERLAPPING_AUDITS) {
    const present = opportunities.filter((o) => group.includes(o.id));
    if (present.length < 2) continue;
    const ordered = [...present].sort(
      (a, b) => severityOf(b) - severityOf(a) || (a.score ?? 1) - (b.score ?? 1),
    );
    const winner = ordered[0];
    for (const o of present) if (o !== winner) dropped.add(o.id);
    if (winner.culprits.length === 0) {
      const donor = ordered.slice(1).find((o) => o.culprits.length > 0);
      if (donor) donated.set(winner.id, donor.culprits);
    }
  }
  return opportunities
    .filter((o) => !dropped.has(o.id))
    .map((o) => {
      const gift = donated.get(o.id);
      return gift ? { ...o, culprits: gift } : o;
    });
}

export async function fetchPagespeed(
  url: string,
  opts?: {
    strategy?: "mobile" | "desktop";
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<PagespeedResult> {
  const key = readGoogleApiKey();
  if (!key) return notConfigured();

  const strategy = opts?.strategy ?? "mobile";
  const endpoint = new URL(PAGESPEED_ENDPOINT);
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("strategy", strategy);
  for (const c of REQUESTED_CATEGORIES) endpoint.searchParams.append("category", c);

  const res = await requestGoogleJson({
    url: endpoint.toString(),
    key,
    timeoutMs: opts?.timeoutMs ?? PAGESPEED_TIMEOUT_MS,
    signal: opts?.signal,
  });
  if (res.kind !== "ok") return res;

  const lhr = envelopeSchema.parse(res.json).lighthouseResult;
  if (!lhr) {
    return {
      kind: "malformed_response",
      message: "PageSpeed answered 200 without a lighthouseResult.",
    };
  }

  const audits = new Map<string, PsiAudit>();
  for (const [id, raw] of Object.entries(lhr.audits ?? {})) {
    try {
      audits.set(id, auditFrom(id, raw));
    } catch {
      continue;
    }
  }

  const categories: PsiCategory[] = [];
  for (const [id, raw] of Object.entries(lhr.categories ?? {})) {
    let parsed: z.infer<typeof categorySchema>;
    try {
      parsed = categorySchema.parse(raw);
    } catch {
      continue;
    }
    const mode = parsed.categoryScoreDisplayMode ?? parsed.scoreDisplayMode ?? null;
    let refs: PsiAudit[] | null = null;
    if (isFraction(mode)) {
      refs = [];
      for (const ref of parsed.auditRefs ?? []) {
        const refId = auditRefSchema.parse(ref).id;
        if (!refId) continue;
        const audit = audits.get(refId);
        refs.push(
          audit ?? {
            id: refId,
            title: null,
            score: null,
            scoreDisplayMode: null,
            status: "unknown",
          },
        );
      }
    }
    categories.push({
      id: parsed.id ?? id,
      title: parsed.title ?? null,
      score: parsed.score ?? null,
      scoreDisplayMode: mode,
      audits: refs,
    });
  }

  const opportunities: PsiOpportunity[] = [];
  for (const [id, raw] of Object.entries(lhr.audits ?? {})) {
    let parsed: z.infer<typeof auditSchema>;
    try {
      parsed = auditSchema.parse(raw);
    } catch {
      continue;
    }
    const score = parsed.score ?? null;
    if (score === null || score >= 1) continue;

    const savings: PsiMetricSaving[] = [];
    for (const metric of PSI_METRICS) {
      const value = parsed.metricSavings?.[metric];
      if (typeof value !== "number" || !(value > 0)) continue;
      savings.push({ metric, value, unit: metric === "CLS" ? "score" : "ms" });
    }
    savings.sort((a, b) => b.value - a.value);

    const ms = parsed.details?.overallSavingsMs ?? null;
    const bytes = parsed.details?.overallSavingsBytes ?? null;
    const hasMs = typeof ms === "number" && ms > 0;
    const hasBytes = typeof bytes === "number" && bytes > 0;

    if (savings.length === 0 && !hasMs && !hasBytes) continue;

    opportunities.push({
      id: parsed.id ?? id,
      title: parsed.title ?? null,
      score,
      metricSavings: savings,
      savingsMs: hasMs ? ms : null,
      savingsBytes: hasBytes ? bytes : null,
      culprits: extractCulprits(parsed.details?.items),
    });
  }
  const ranked = rankOpportunities(opportunities);

  const serverResponse = auditSchema.safeParse(
    (lhr.audits ?? {})[SERVER_RESPONSE_AUDIT_ID],
  );
  const serverResponseMs =
    serverResponse.success && typeof serverResponse.data.numericValue === "number"
      ? serverResponse.data.numericValue
      : null;

  return {
    kind: "ok",
    requested_url: url,
    strategy,
    final_url: lhr.finalUrl ?? lhr.finalDisplayedUrl ?? null,
    fetch_time: lhr.fetchTime ?? null,
    lighthouse_version: lhr.lighthouseVersion ?? null,
    categories,
    agentic_browsing: categories.find((c) => c.id === AGENTIC_BROWSING_CATEGORY_ID) ?? null,
    opportunities: ranked.slice(0, MAX_OPPORTUNITIES),
    server_response_ms: serverResponseMs,
  };
}
