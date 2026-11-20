
import { findProtectedPathHits, type ProtectedPathHit } from "./pipeline-policy";
import { siteProtectedPathHits } from "@/services/sites/site-build-target";

export const FRESH_APP_LIFTED_GLOBS: readonly string[] = [
  "**/auth/**",
  "**/middleware/**",
  "**/billing/**",
  "**/webhooks/**",
] as const;

const ENV_GLOB = "**/.env*";
const ENV_TEMPLATE_RE = /(^|\/)\.env\.(example|sample|template)$/;

function liftable(glob: string, appGlobs: readonly string[]): boolean {
  return FRESH_APP_LIFTED_GLOBS.includes(glob) && !appGlobs.includes(glob);
}

export function withoutFreshAppHits<T extends { path: string; glob: string }>(
  hits: readonly T[],
  appGlobs: readonly string[],
): T[] {
  return hits.filter(
    (h) => !liftable(h.glob, appGlobs) && !(h.glob === ENV_GLOB && !appGlobs.includes(ENV_GLOB) && ENV_TEMPLATE_RE.test(h.path)),
  );
}

export function freshAppProtectedPathHits(
  files: Array<{ path?: string | null; action?: string | null }>,
  globSet: { globs: readonly string[]; app_globs: readonly string[] },
  opts: { siteRepo: boolean },
): ProtectedPathHit[] {
  const kept = globSet.globs.filter((g) => !liftable(g, globSet.app_globs));
  const keptForTemplates = globSet.app_globs.includes(ENV_GLOB) ? kept : kept.filter((g) => g !== ENV_GLOB);
  const isTemplate = (f: { path?: string | null }) => typeof f.path === "string" && ENV_TEMPLATE_RE.test(f.path.trim());
  const match = (subset: typeof files, globs: string[]) =>
    opts.siteRepo ? siteProtectedPathHits(subset, globs) : findProtectedPathHits(subset.map((f) => f.path ?? null), globs);
  return [...match(files.filter((f) => !isTemplate(f)), kept), ...match(files.filter(isTemplate), keptForTemplates)];
}

export function isFreshBuildCodegenPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as { stage?: unknown; refine_mode?: unknown; customer_origin?: unknown; live_edit_branch?: unknown };
  if (p.refine_mode === true || p.customer_origin === true || p.live_edit_branch !== undefined) return false;
  return p.stage === "scaffold" || p.stage === "build";
}

type GraphNodeLike = { child_run_id?: unknown; payload?: { stage?: unknown; refine_mode?: unknown } | null };

export function isFreshBuildRun(
  row: { kind?: unknown; goal_graph?: unknown } | null | undefined,
  agent_run_id: string | null | undefined,
): boolean {
  if (!row || row.kind !== "build_app" || !agent_run_id) return false;
  const graph = Array.isArray(row.goal_graph) ? (row.goal_graph as GraphNodeLike[]) : [];
  if (graph.length === 0 || graph[0]?.payload?.refine_mode === true) return false;
  const node = graph.find((n) => n && n.child_run_id === agent_run_id);
  if (!node) return false;
  const stage = node.payload?.stage;
  return (stage === "scaffold" || stage === "build") && node.payload?.refine_mode !== true;
}
