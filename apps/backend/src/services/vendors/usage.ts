
import { AsyncLocalStorage } from "node:async_hooks";
import { globalClient } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";

export type VendorSource =
  | "run"
  | "chat"
  | "onboarding"
  | "growth_research"
  | "reddit_sweep"
  | "reddit_rank"
  | "linkedin_refresh"
  | "geo_sweep"
  | "start_card"
  | "company_research"
  | "fundraising"
  | "unknown";

export type VendorContext = {
  tenant_id: string | null;
  run_id?: string | null;
  source: VendorSource;
};

export type VendorUsageRow = {
  vendor: "apify" | "dataforseo" | "tavily";
  workload: string;
  units?: number | null;
  ms?: number | null;
  memory_mb?: number | null;
  usd_est?: number | null;
  usd?: number | null;
  at?: Date;
};

const store = new AsyncLocalStorage<VendorContext>();

export function withVendorContext<T>(ctx: VendorContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function vendorContext(): VendorContext | undefined {
  return store.getStore();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Writer = (row: Record<string, unknown>) => Promise<void>;

const dbWriter: Writer = async (row) => {
  const { error } = await globalClient().from("vendor_usage").insert(row);
  if (error) throw new Error(error.message);
};

let writer: Writer = dbWriter;

export function __setVendorUsageWriterForTests(w: Writer | null): void {
  writer = w ?? dbWriter;
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function recordVendorUsage(row: VendorUsageRow, ctx: VendorContext | undefined = vendorContext()): void {
  const runId = ctx?.run_id && UUID.test(ctx.run_id) ? ctx.run_id : null;
  const tenantId = ctx?.tenant_id && UUID.test(ctx.tenant_id) ? ctx.tenant_id : null;
  const out = {
    ...(row.at ? { created_at: row.at.toISOString() } : {}),
    tenant_id: tenantId,
    agent_run_id: runId,
    source: ctx?.source ?? "unknown",
    vendor: row.vendor,
    workload: row.workload.slice(0, 120),
    units: num(row.units) === null ? null : Math.round(row.units as number),
    ms: num(row.ms) === null ? null : Math.round(row.ms as number),
    memory_mb: num(row.memory_mb),
    usd_est: num(row.usd_est),
    usd: num(row.usd),
  };
  try {
    void writer(out).catch((e) => {
      void logEvent({
        level: "warn",
        source: "vendors.usage",
        code: "vendor_usage_write_failed",
        error: e,
        tenant_id: tenantId,
      }).catch(() => {});
    });
  } catch {
  }
}

const CU_USD = 0.2;
const APIFY_EVENT_PRICES: Record<string, { start: number; perItem: number }> = {
  "apify/rag-web-browser": { start: 0.001, perItem: 0 },
  "harshmaur/reddit-scraper-pro": { start: 0, perItem: 0.002 },
  "clockworks/tiktok-scraper": { start: 0, perItem: 0.004 },
  "apify/instagram-scraper": { start: 0, perItem: 0.0027 },
};
const RAG_SEARCH_USD = 0.012;

export function actorKey(actor: string): string {
  return actor.replace("~", "/").toLowerCase();
}

export function estimateApifyUsd(input: {
  actor: string;
  ms: number;
  memoryMb: number | null;
  items: number;
  search?: boolean;
}): number {
  const price = APIFY_EVENT_PRICES[actorKey(input.actor)] ?? { start: 0.001, perItem: 0.002 };
  const gb = (input.memoryMb ?? 1024) / 1024;
  const compute = gb * (Math.max(0, input.ms) / 3_600_000) * CU_USD;
  const events = price.start + price.perItem * Math.max(0, input.items) + (input.search ? RAG_SEARCH_USD : 0);
  return Math.round((compute + events) * 1e6) / 1e6;
}

export function recordApifyCall(input: {
  actor: string;
  ms: number;
  memoryMb: number | null;
  items: number;
  search?: boolean;
  at?: Date;
}): void {
  recordVendorUsage({
    vendor: "apify",
    workload: actorKey(input.actor),
    units: input.items,
    ms: input.ms,
    memory_mb: input.memoryMb,
    usd_est: estimateApifyUsd(input),
    at: input.at ?? new Date(Date.now() - Math.max(0, input.ms)),
  });
}

export function apifyRanAndBilled(status: number): boolean {
  return status === 408 || status >= 500;
}

const TAVILY_CREDIT_USD = 0.008;

export function recordTavilySearch(
  input: { depth: "basic" | "advanced" | undefined; ms: number; results: number },
  ctx: VendorContext | undefined = vendorContext(),
): void {
  const credits = input.depth === "advanced" ? 2 : 1;
  recordVendorUsage(
    {
      vendor: "tavily",
      workload: `search_${input.depth ?? "basic"}`,
      units: input.results,
      ms: input.ms,
      usd_est: credits * TAVILY_CREDIT_USD,
      usd: credits * TAVILY_CREDIT_USD,
    },
    ctx,
  );
}

export function recordDataForSeoTask(input: { endpoint: string; cost_usd: number | null; ms: number }): void {
  if (input.cost_usd === null || !Number.isFinite(input.cost_usd)) return;
  recordVendorUsage({
    vendor: "dataforseo",
    workload: input.endpoint,
    units: 1,
    ms: input.ms,
    usd_est: input.cost_usd,
    usd: input.cost_usd,
  });
}
