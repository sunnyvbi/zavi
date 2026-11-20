
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { DOGFOOD_SLUGS } from "@/services/tenants/new-tenant-alert";

const BUILDS_MAX = 2000;
const RUNS_MAX = 10000;
const LOGS_MAX = 5000;
const BUILDS_SHOWN = 200;

export type CostFlow = "fast" | "staged" | "edit";
export type CostPass = "first" | "repair" | "visual_fix";

export type CostBuildInput = { id: string; tenant_id: string; status: string; created_at: string; refine: boolean; fast: boolean };
export type CostRunInput = {
  id: string;
  build_id: string;
  agent_slug: string;
  status: string;
  model: string | null;
  usd: number;
  stage: string | null;
  fast: boolean;
  repair: boolean;
  vision_fix: boolean;
  finished: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};
export type CostImageInput = { run_id: string; usd: number };
export type CostSideInput = { run_id: string; usd: number };
const FINISHED = new Set(["done", "failed", "halted"]);

type Tokens = { input: number; output: number; cache_read: number; cache_write: number };
type Bucket = { runs: number; usd: number; tokens: Tokens };

export type CostBuildRow = {
  id: string;
  tenant_id: string;
  tenant_slug: string | null;
  created_at: string;
  status: string;
  flow: CostFlow;
  finished: boolean;
  usd: number;
  model_usd: number;
  tool_usd: number;
  image_usd: number;
  runs: number;
  passes: Record<CostPass, number>;
  by_stage: Record<string, Bucket>;
  by_model: Record<string, Bucket>;
};

type Dist = { builds: number; avg: number; p50: number; p90: number; max: number; total: number };

export type BuildCostReport = {
  days: number;
  scope: "real" | "all";
  not_included: string[];
  totals: { builds: number; unfinished: number; usd: number; model_usd: number; tool_usd: number; image_usd: number; runs: number; cache_read_share: number | null };
  truncated: { builds: boolean; runs: boolean; images: boolean; tool_costs: boolean };
  per_build: Record<CostFlow, Dist | null>;
  by_stage: Array<{ stage: string; flow: CostFlow; pass: CostPass } & Bucket>;
  by_model: Array<{ model: string } & Bucket>;
  builds: CostBuildRow[];
};

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const emptyTokens = (): Tokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
const emptyBucket = (): Bucket => ({ runs: 0, usd: 0, tokens: emptyTokens() });

function add(b: Bucket, r: CostRunInput): void {
  b.runs += 1;
  b.usd += r.usd;
  b.tokens.input += r.input_tokens;
  b.tokens.output += r.output_tokens;
  b.tokens.cache_read += r.cache_read_tokens;
  b.tokens.cache_write += r.cache_creation_tokens;
}

function passOf(r: CostRunInput): CostPass {
  return r.vision_fix ? "visual_fix" : r.repair ? "repair" : "first";
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

function dist(values: number[]): Dist | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const total = s.reduce((a, b) => a + b, 0);
  return { builds: s.length, avg: round(total / s.length), p50: round(percentile(s, 50)), p90: round(percentile(s, 90)), max: round(s[s.length - 1]!), total: round(total, 2) };
}

export function buildCostReport(input: {
  days: number;
  scope: "real" | "all";
  builds: CostBuildInput[];
  runs: CostRunInput[];
  images: CostImageInput[];
  side?: CostSideInput[];
  slugs: Record<string, string>;
  truncated?: BuildCostReport["truncated"];
}): BuildCostReport {
  const imageByRun = new Map<string, number>();
  for (const i of input.images) imageByRun.set(i.run_id, (imageByRun.get(i.run_id) ?? 0) + i.usd);
  const sideByRun = new Map<string, number>();
  for (const x of input.side ?? []) sideByRun.set(x.run_id, (sideByRun.get(x.run_id) ?? 0) + x.usd);
  const runsByBuild = new Map<string, CostRunInput[]>();
  for (const r of input.runs) {
    const list = runsByBuild.get(r.build_id) ?? [];
    list.push(r);
    runsByBuild.set(r.build_id, list);
  }

  const stageMap = new Map<string, { stage: string; flow: CostFlow; pass: CostPass } & Bucket>();
  const modelMap = new Map<string, { model: string } & Bucket>();
  const rows: CostBuildRow[] = [];
  for (const b of input.builds) {
    const runs = runsByBuild.get(b.id) ?? [];
    if (runs.length === 0) continue;
    const flow: CostFlow = b.refine ? "edit" : b.fast || runs.some((r) => r.fast) ? "fast" : "staged";
    const by_stage: Record<string, Bucket> = {};
    const by_model: Record<string, Bucket> = {};
    const passes: Record<CostPass, number> = { first: 0, repair: 0, visual_fix: 0 };
    let image_usd = 0;
    let tool_usd = 0;
    let model_usd = 0;
    for (const r of runs) {
      const stage = r.stage ?? "unknown";
      const pass = passOf(r);
      const model = r.model ?? (r.usd > 0 ? "unrecorded" : "no model call");
      add((by_stage[stage] ??= emptyBucket()), r);
      add((by_model[model] ??= emptyBucket()), r);
      passes[pass] += 1;
      const sk = `${flow}|${stage}|${pass}`;
      const sb = stageMap.get(sk) ?? { stage, flow, pass, ...emptyBucket() };
      add(sb, r);
      stageMap.set(sk, sb);
      const mb = modelMap.get(model) ?? { model, ...emptyBucket() };
      add(mb, r);
      modelMap.set(model, mb);
      image_usd += imageByRun.get(r.id) ?? 0;
      const side = sideByRun.get(r.id) ?? 0;
      if (r.finished) {
        tool_usd += Math.min(r.usd, side);
        model_usd += r.usd - Math.min(r.usd, side);
      } else {
        tool_usd += side;
        model_usd += r.usd;
      }
    }
    const run_usd = model_usd + tool_usd;
    rows.push({
      id: b.id,
      tenant_id: b.tenant_id,
      tenant_slug: input.slugs[b.tenant_id] ?? null,
      created_at: b.created_at,
      status: b.status,
      flow,
      finished: FINISHED.has(b.status),
      usd: round(run_usd + image_usd),
      model_usd: round(model_usd),
      tool_usd: round(tool_usd),
      image_usd: round(image_usd),
      runs: runs.length,
      passes,
      by_stage,
      by_model,
    });
  }

  const usdOf = (flow: CostFlow) => rows.filter((r) => r.flow === flow && r.finished).map((r) => r.usd);
  const tokens = rows.reduce((t, r) => {
    for (const b of Object.values(r.by_model)) {
      t.input += b.tokens.input;
      t.cache_read += b.tokens.cache_read;
      t.cache_write += b.tokens.cache_write;
    }
    return t;
  }, emptyTokens());
  const inputAll = tokens.input + tokens.cache_read + tokens.cache_write;
  const roundBucket = <T extends Bucket>(b: T): T => ({ ...b, usd: round(b.usd, 2) });
  return {
    days: input.days,
    scope: input.scope,
    not_included: ["design brief model call (Haiku, one per first build)", "review before publish (Haiku, one per publish)", "sandbox time"],
    totals: {
      builds: rows.length,
      unfinished: rows.filter((r) => !r.finished).length,
      usd: round(rows.reduce((s, r) => s + r.usd, 0), 2),
      model_usd: round(rows.reduce((s, r) => s + r.model_usd, 0), 2),
      tool_usd: round(rows.reduce((s, r) => s + r.tool_usd, 0), 2),
      image_usd: round(rows.reduce((s, r) => s + r.image_usd, 0), 2),
      runs: rows.reduce((s, r) => s + r.runs, 0),
      cache_read_share: inputAll > 0 ? round(tokens.cache_read / inputAll, 3) : null,
    },
    truncated: input.truncated ?? { builds: false, runs: false, images: false, tool_costs: false },
    per_build: { fast: dist(usdOf("fast")), staged: dist(usdOf("staged")), edit: dist(usdOf("edit")) },
    by_stage: [...stageMap.values()].map(roundBucket).sort((a, b) => b.usd - a.usd),
    by_model: [...modelMap.values()].map(roundBucket).sort((a, b) => b.usd - a.usd),
    builds: [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, BUILDS_SHOWN),
  };
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function toCostRun(row: Record<string, unknown>): CostRunInput | null {
  const build_id = str(row.build);
  if (!build_id || typeof row.id !== "string") return null;
  return {
    id: row.id,
    build_id,
    agent_slug: String(row.agent_slug ?? ""),
    status: String(row.status ?? ""),
    model: str(row.model_used),
    usd: num(row.cost_usd),
    stage: str(row.stage),
    fast: row.fast === "true",
    repair: row.repair === "true",
    vision_fix: row.vision_fix === "true",
    finished: typeof row.finished_at === "string" && row.finished_at !== "",
    input_tokens: num(row.input_tokens),
    output_tokens: num(row.output_tokens),
    cache_read_tokens: num(row.cache_read_tokens),
    cache_creation_tokens: num(row.cache_creation_tokens),
  };
}

const RUN_SELECT =
  "id, agent_slug, status, finished_at, model_used, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, " +
  "build:payload->>build_conductor_run_id, stage:payload->>stage, fast:payload->>fast_single_pass, repair:payload->>repair_mode, vision_fix:payload->>vision_fix";

export async function staffBuildCosts(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const days = Math.min(90, Math.max(1, Math.floor(Number(req.query.days ?? 14)) || 14));
  const scope: "real" | "all" = req.query.scope === "all" ? "all" : "real";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const sb = staffCrossTenantClient("admin/build-costs: cross-tenant staff read-only cost report");
  const fail = (message: string) => res.status(500).json({ error: { code: "build_costs_query_failed", message } });

  const tenantsQ = await sb.from("tenants").select("id, slug, kind").limit(10000);
  if (tenantsQ.error) return void fail(tenantsQ.error.message);
  const tenants = (tenantsQ.data ?? []) as Array<{ id: string; slug: string | null; kind: string | null }>;
  const slugs = Object.fromEntries(tenants.map((t) => [t.id, t.slug ?? ""]));
  const excluded = new Set(
    scope === "real" ? tenants.filter((t) => t.kind === "test" || DOGFOOD_SLUGS.has(t.slug ?? "")).map((t) => t.id) : [],
  );

  const buildsQ = await sb
    .from("conductor_runs")
    .select(
      "id, tenant_id, status, created_at, r0:goal_graph->0->payload->>refine_mode, " +
        "f0:goal_graph->0->payload->>fast_single_pass, f1:goal_graph->1->payload->>fast_single_pass, f2:goal_graph->2->payload->>fast_single_pass",
    )
    .eq("kind", "build_app")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(BUILDS_MAX);
  if (buildsQ.error) return void fail(buildsQ.error.message);
  const builds: CostBuildInput[] = ((buildsQ.data ?? []) as unknown as Array<Record<string, unknown>>)
    .filter((r) => !excluded.has(String(r.tenant_id)))
    .map((r) => ({
      id: String(r.id),
      tenant_id: String(r.tenant_id),
      status: String(r.status ?? ""),
      created_at: String(r.created_at ?? ""),
      refine: r.r0 === "true",
      fast: r.f0 === "true" || r.f1 === "true" || r.f2 === "true",
    }));

  const runsQ = await sb
    .from("agent_runs")
    .select(RUN_SELECT)
    .not("payload->>build_conductor_run_id", "is", null)
    .gte("enqueued_at", since)
    .order("enqueued_at", { ascending: false })
    .limit(RUNS_MAX);
  if (runsQ.error) return void fail(runsQ.error.message);
  const ids = new Set(builds.map((b) => b.id));
  const runs = ((runsQ.data ?? []) as unknown as Array<Record<string, unknown>>)
    .map(toCostRun)
    .filter((r): r is CostRunInput => r !== null && ids.has(r.build_id));

  const imagesQ = await sb
    .from("praxis_logs")
    .select("run_id, cost:meta->>cost_usd")
    .eq("code", "site_images.generated")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(LOGS_MAX);
  if (imagesQ.error) return void fail(imagesQ.error.message);
  const images = ((imagesQ.data ?? []) as Array<{ run_id: string | null; cost: string | null }>)
    .filter((i): i is { run_id: string; cost: string | null } => !!i.run_id)
    .map((i) => ({ run_id: i.run_id, usd: num(i.cost) }));

  const sideQ = await sb
    .from("agent_run_side_costs")
    .select("run_id, usd")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(LOGS_MAX);
  if (sideQ.error) return void fail(sideQ.error.message);
  const side = ((sideQ.data ?? []) as Array<{ run_id: string; usd: number | string }>).map((x) => ({ run_id: x.run_id, usd: num(x.usd) }));

  const truncated = {
    builds: (buildsQ.data ?? []).length >= BUILDS_MAX,
    runs: (runsQ.data ?? []).length >= RUNS_MAX,
    images: (imagesQ.data ?? []).length >= LOGS_MAX,
    tool_costs: side.length >= LOGS_MAX,
  };
  res.json(buildCostReport({ days, scope, builds, runs, images, side, slugs, truncated }));
}
