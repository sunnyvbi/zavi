
import type { CatalogBreakdown, CatalogGrain } from "@/services/analytics/metric-registry";
import type { LocalDate, ResolvedWindow } from "@/services/analytics/metric-time";

export type Parts = Record<string, number>;

export type MetricFetchCtx = {
  tenant_id: string;
  tz: string;
  now: Date;
  grain: CatalogGrain;
  breakdown?: CatalogBreakdown;
  gateway: import("@/services/data-gateway/types").GatewayContext;
};

export type FetchOk = {
  ok: true;
  daily?: Array<{ date: LocalDate; parts: Parts }>;
  buckets?: Array<{ start: LocalDate; parts: Parts }>;
  total_parts?: Parts;
  breakdown?: Array<{ key: string; parts: Parts }>;
  currency: string | null;
  row_count: number;
  truncated: boolean;
  caveats: string[];
  params: Record<string, unknown>;
  estimate?: Estimate;
};

export type Estimate = {
  exact: boolean;
  assumptions: string[];
  inputs: Parts;
  coverage: Record<string, unknown>;
};

export type Bounds = { low: number | null; high: number | null };

export type FetchFailReason =
  | "not_connected"
  | "read_failed"
  | "needs_confirmation"
  | "unsupported"
  | "currency_mismatch"
  | "too_many_rows"
  | "empty_window"
  | "unsupported_definition";

export type FetchFail = {
  ok: false;
  reason: FetchFailReason;
  message: string;
  caveats?: string[];
};

export type FetchResult = FetchOk | FetchFail;

export type MetricImpl = {
  value(parts: Parts): number | null;
  bounds?(parts: Parts, window: Parts): Bounds;
  fetch(ctx: MetricFetchCtx, window: ResolvedWindow): Promise<FetchResult>;
};
