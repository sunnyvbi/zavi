
import { z } from "zod";
import { continueBuild, continueRefusal, type ContinueBuildResult } from "@/services/agents/continue-build";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { siteIdFromGraph } from "@/services/sites/site-run";

export const BUILD_CONTINUE_KEY = "build-continue";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BuildContinueArgs = { run_id: string };

export const buildContinueSchema = z.object({
  run_id: z.string().trim().regex(UUID_RE, "run_id must be a build (conductor run) uuid").transform((s) => s.toLowerCase()),
});

export type StuckBuild = {
  run_id: string;
  tenant_id: string;
  status: string;
  paused_at: string | null;
  updated_at: string | null;
  failure_class: string | null;
  failure_reason: string | null;
  spend_usd: number | null;
  max_usd: number | null;
  site: { id: string; label: string | null; hostname: string | null; status: string | null } | null;
  refusal: string | null;
};

export type BuildContinueDeps = {
  readBuild: (run_id: string) => Promise<StuckBuild | null>;
  continueBuild: (tenant_id: string, run_id: string) => Promise<ContinueBuildResult>;
};

async function readBuildDefault(run_id: string): Promise<StuckBuild | null> {
  const sb = staffCrossTenantClient("admin script build-continue: staff resumes a customer's paused build");
  const { data, error } = await sb
    .from("conductor_runs")
    .select("id, tenant_id, kind, status, paused_at, updated_at, failure_class, failure_reason, spend_usd, max_usd, goal_graph")
    .eq("id", run_id)
    .maybeSingle();
  if (error) throw new Error(`build-continue: run read failed: ${error.message}`);
  if (!data) return null;
  const row = data as {
    id: string;
    tenant_id: string;
    kind: string | null;
    status: string;
    paused_at: string | null;
    updated_at: string | null;
    failure_class: string | null;
    failure_reason: string | null;
    spend_usd: number | string | null;
    max_usd: number | string | null;
    goal_graph: unknown;
  };
  const { data: site, error: siteErr } = await sb
    .from("sites")
    .select("id, label, hostname, status")
    .eq("root_conductor_run_id", run_id)
    .eq("tenant_id", row.tenant_id)
    .maybeSingle();
  if (siteErr) throw new Error(`build-continue: site read failed: ${siteErr.message}`);
  const num = (v: number | string | null) => (v === null || v === "" ? null : Number(v));
  return {
    run_id: row.id,
    tenant_id: row.tenant_id,
    status: row.status,
    paused_at: row.paused_at,
    updated_at: row.updated_at,
    failure_class: row.failure_class,
    failure_reason: row.failure_reason ? row.failure_reason.slice(0, 300) : null,
    spend_usd: num(row.spend_usd),
    max_usd: num(row.max_usd),
    site: site ? (site as StuckBuild["site"]) : null,
    refusal: continueRefusal(row) ?? (siteIdFromGraph(row.goal_graph) ? null : "old_site_frozen"),
  };
}

export const DEFAULT_BUILD_CONTINUE_DEPS: BuildContinueDeps = {
  readBuild: readBuildDefault,
  continueBuild: (tenant_id, run_id) => continueBuild(tenant_id, run_id),
};

export function continueConfirmPhrase(run_id: string): string {
  return `CONTINUE ${run_id}`;
}

export async function previewBuildContinue(run_id: string, deps: BuildContinueDeps): Promise<StuckBuild & { confirm_phrase: string }> {
  const build = await deps.readBuild(run_id);
  if (!build) throw new BuildContinueNotFound();
  return { ...build, confirm_phrase: continueConfirmPhrase(run_id) };
}

export class BuildContinueNotFound extends Error {
  constructor() {
    super("No website build with that id.");
  }
}

export async function applyBuildContinue(run_id: string, deps: BuildContinueDeps): Promise<{ build: StuckBuild; result: ContinueBuildResult }> {
  const build = await deps.readBuild(run_id);
  if (!build) throw new BuildContinueNotFound();
  const result = await deps.continueBuild(build.tenant_id, build.run_id);
  return { build, result };
}
