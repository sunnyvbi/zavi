import { z } from "zod";
import { getBoolSettingStrictResolved } from "@/services/settings";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export const BUILD_REASONS = ["look", "layout", "copy", "missing", "broken", "slow"] as const;
export type BuildReason = (typeof BUILD_REASONS)[number];

export const BuildReasonsSchema = z
  .array(z.enum(BUILD_REASONS))
  .max(BUILD_REASONS.length)
  .refine((a) => new Set(a).size === a.length, { message: "reasons must be unique" });

export const CARRYOVER_FLAG = "site_build_feedback_carryover" as const;
export const CARRYOVER_MAX_LINES = 3;
export const CARRYOVER_RECENT_DOWNVOTES = 3;
const SITE_RUNS_SCANNED = 100;

export const CARRYOVER_SENTENCES: Record<BuildReason, string> = {
  look: "The founder disliked the last look: keep colours and fonts consistent with their brand and avoid generic defaults.",
  layout: "The founder disliked the last layout: keep sections clearly ordered, aligned and evenly spaced, and do not crowd the page.",
  copy: "The founder flagged wrong words or facts last time: use only facts from the brief and the request, and never invent claims, prices or names.",
  missing: "The founder said a section was missing last time: make sure every section the request and the plan ask for is on the page.",
  broken: "The founder said something was broken last time: check that every link, button, form and image works before you finish.",
  slow: "The founder found the last result slow: keep images compressed and sized, and do not add heavy scripts or animations.",
};

const isReason = (v: unknown): v is BuildReason => typeof v === "string" && (BUILD_REASONS as readonly string[]).includes(v);

export function carryoverLines(recentReasons: unknown[]): string[] {
  const seen = new Set<BuildReason>();
  for (const row of recentReasons) {
    if (!Array.isArray(row)) continue;
    for (const r of row) if (isReason(r)) seen.add(r);
  }
  return [...seen].slice(0, CARRYOVER_MAX_LINES).map((r) => CARRYOVER_SENTENCES[r]);
}

export function carryoverBlock(lines: string[]): string {
  if (lines.length === 0) return "";
  return `\n\n---\n### What the founder disliked in earlier builds of this site\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

export type CarryoverDeps = {
  enabled: (tenantId: string) => Promise<boolean>;
  siteRunIds: (tenantId: string, siteId: string) => Promise<string[]>;
  recentDownvoteReasons: (tenantId: string, runIds: string[]) => Promise<unknown[]>;
};

async function siteRunIds(tenantId: string, siteId: string): Promise<string[]> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("conductor_runs")
    .select("id")
    .eq("kind", "build_app")
    .eq("goal_graph->0->payload->>site_id", siteId)
    .order("created_at", { ascending: false })
    .limit(SITE_RUNS_SCANNED);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: unknown }>).map((r) => String(r.id));
}

async function recentDownvoteReasons(tenantId: string, runIds: string[]): Promise<unknown[]> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("agent_feedback")
    .select("build_reasons")
    .eq("target_type", "conductor_run")
    .eq("rating", -1)
    .in("target_id", runIds)
    .order("created_at", { ascending: false })
    .limit(CARRYOVER_RECENT_DOWNVOTES);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ build_reasons: unknown }>).map((r) => r.build_reasons);
}

const realDeps: CarryoverDeps = {
  enabled: (tenantId) => getBoolSettingStrictResolved(CARRYOVER_FLAG, tenantId),
  siteRunIds,
  recentDownvoteReasons,
};

export async function buildFeedbackCarryover(tenantId: string, siteId: string | null, deps: CarryoverDeps = realDeps): Promise<string> {
  if (!tenantId || !siteId) return "";
  try {
    if (!(await deps.enabled(tenantId))) return "";
    const ids = await deps.siteRunIds(tenantId, siteId);
    if (ids.length === 0) return "";
    const recent = await deps.recentDownvoteReasons(tenantId, ids);
    return carryoverBlock(carryoverLines(recent.slice(0, CARRYOVER_RECENT_DOWNVOTES)));
  } catch (e: unknown) {
    console.warn(`[build-feedback] carry-over skipped: ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}
