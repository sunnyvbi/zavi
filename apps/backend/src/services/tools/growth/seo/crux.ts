
import { z } from "zod";

import {
  type GoogleApiUnavailable,
  notConfigured,
  readGoogleApiKey,
  requestGoogleJson,
} from "./google-api";

export const CRUX_TIMEOUT_MS = 15_000;

const CRUX_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";

export const CRUX_METRICS = [
  "largest_contentful_paint",
  "interaction_to_next_paint",
  "cumulative_layout_shift",
  "first_contentful_paint",
  "experimental_time_to_first_byte",
] as const;

export type CruxMetricName = (typeof CRUX_METRICS)[number];

export type CruxBin = {
  start: number | null;
  end: number | null;
  density: number | null;
};

export type CruxMetric = {
  p75: number | null;
  histogram: CruxBin[];
};

export type CruxCollectionPeriod = {
  first_date: string | null;
  last_date: string | null;
};

export type CruxRecordResult = {
  kind: "ok";
  scope: "url" | "origin";
  key: string;
  collection_period: CruxCollectionPeriod | null;
  metrics: Record<CruxMetricName, CruxMetric | null>;
};

export type CruxNoData = {
  kind: "no_data";
  tried: Array<"url" | "origin">;
};

export type CruxResult = CruxRecordResult | CruxNoData | GoogleApiUnavailable;

const numberish = z
  .union([z.number(), z.string()])
  .optional()
  .catch(undefined)
  .transform((v) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
      const n = Number(v.trim());
      return Number.isFinite(n) ? n : null;
    }
    return null;
  });

const binSchema = z
  .object({
    start: numberish,
    end: numberish,
    density: numberish,
  })
  .catch({ start: null, end: null, density: null });

const metricSchema = z
  .object({
    percentiles: z.object({ p75: numberish }).optional().catch(undefined),
    histogram: z.array(z.unknown()).optional().catch(undefined),
  })
  .catch({});

const dateSchema = z
  .object({
    year: z.number().optional().catch(undefined),
    month: z.number().optional().catch(undefined),
    day: z.number().optional().catch(undefined),
  })
  .catch({});

const recordSchema = z
  .object({
    record: z
      .object({
        key: z
          .object({
            url: z.string().optional().catch(undefined),
            origin: z.string().optional().catch(undefined),
          })
          .optional()
          .catch(undefined),
        metrics: z.record(z.string(), z.unknown()).optional().catch(undefined),
        collectionPeriod: z
          .object({
            firstDate: dateSchema.optional().catch(undefined),
            lastDate: dateSchema.optional().catch(undefined),
          })
          .optional()
          .catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .catch({});

function isoDate(d: z.infer<typeof dateSchema> | undefined): string | null {
  if (!d || d.year === undefined || d.month === undefined || d.day === undefined) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

function metricFrom(raw: unknown): CruxMetric | null {
  let parsed: z.infer<typeof metricSchema>;
  try {
    parsed = metricSchema.parse(raw);
  } catch {
    return null;
  }
  const bins: CruxBin[] = [];
  for (const b of parsed.histogram ?? []) {
    try {
      const bin = binSchema.parse(b);
      bins.push({ start: bin.start, end: bin.end, density: bin.density });
    } catch {
      continue;
    }
  }
  const p75 = parsed.percentiles?.p75 ?? null;
  if (p75 === null && bins.length === 0) return null;
  return { p75, histogram: bins };
}

function isNoDataMessage(message: string): boolean {
  return /chrome ux report data not found/i.test(message);
}

async function queryOne(
  key: string,
  body: { url: string } | { origin: string },
  scope: "url" | "origin",
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<CruxRecordResult | CruxNoData | GoogleApiUnavailable> {
  const res = await requestGoogleJson({
    url: CRUX_ENDPOINT,
    key,
    method: "POST",
    body,
    timeoutMs,
    signal,
  });

  if (res.kind === "http_error" && res.status === 404) {
    void isNoDataMessage(res.message);
    return { kind: "no_data", tried: [scope] };
  }
  if (res.kind !== "ok") return res;

  const parsed = recordSchema.parse(res.json).record;
  if (!parsed) {
    return {
      kind: "malformed_response",
      message: "CrUX answered 200 without a record.",
    };
  }

  const metrics = {} as Record<CruxMetricName, CruxMetric | null>;
  for (const name of CRUX_METRICS) metrics[name] = metricFrom((parsed.metrics ?? {})[name]);

  const first = isoDate(parsed.collectionPeriod?.firstDate);
  const last = isoDate(parsed.collectionPeriod?.lastDate);

  return {
    kind: "ok",
    scope,
    key: parsed.key?.url ?? parsed.key?.origin ?? ("url" in body ? body.url : body.origin),
    collection_period: first === null && last === null ? null : { first_date: first, last_date: last },
    metrics,
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export async function fetchCrux(
  url: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<CruxResult> {
  const key = readGoogleApiKey();
  if (!key) return notConfigured();

  const timeoutMs = opts?.timeoutMs ?? CRUX_TIMEOUT_MS;

  const byUrl = await queryOne(key, { url }, "url", timeoutMs, opts?.signal);
  if (byUrl.kind !== "no_data") return byUrl;

  const origin = originOf(url);
  if (!origin) return byUrl;

  const byOrigin = await queryOne(key, { origin }, "origin", timeoutMs, opts?.signal);
  if (byOrigin.kind === "no_data") return { kind: "no_data", tried: ["url", "origin"] };
  return byOrigin;
}
