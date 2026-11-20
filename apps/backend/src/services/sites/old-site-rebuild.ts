
import { decodeXmlEntities, sanitizeFetchedContent, xmlEscapeContent } from "@/services/onboarding/enrichment/sanitize";
import { validateCompanyName } from "@/services/provisioning/tenant-slug";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";

export const REBUILD_CLAIM_STALE_SECONDS = 300;

const MIN_IDEA = 8;
const MAX_IDEA = 4000;
const MAX_NAME = 100;

export type OldSiteSource = {
  name: string;
  build_run_id: string | null;
};

export type OldSiteBrief = {
  company_name: string | null;
  idea: string | null;
  objective: string | null;
};

export type RebuildClaim =
  | { outcome: "claimed"; token: string }
  | { outcome: "existing"; conductor_run_id: string }
  | { outcome: "starting" };

export type OldSiteRebuildDeps = {
  loadOldSite: (tenant_id: string) => Promise<OldSiteSource | null>;
  loadBrief: (tenant_id: string, conductor_run_id: string) => Promise<OldSiteBrief | null>;
  claim: (tenant_id: string, source_run_id: string | null) => Promise<RebuildClaim>;
  settle: (tenant_id: string, token: string, conductor_run_id: string) => Promise<boolean>;
  release: (tenant_id: string, token: string) => Promise<boolean>;
  startBuild: (input: {
    tenant_id: string;
    company_name: string;
    idea: string;
    site_name: string;
    started_by_user_id: string | null;
    onRunCreated: (conductor_run_id: string) => Promise<void>;
  }) => Promise<{ conductor_run_id: string }>;
  warn?: (event: string, meta: Record<string, unknown>) => void;
};

export type OldSiteRebuildResult =
  | { kind: "started"; conductor_run_id: string }
  | { kind: "existing"; conductor_run_id: string }
  | { kind: "starting" };

export class RebuildClaimLost extends Error {
  readonly code = "rebuild_claim_lost";
  constructor() {
    super("Another rebuild request took over this one, so nothing extra was started.");
    this.name = "RebuildClaimLost";
  }
}

export class NoOldSite extends Error {
  readonly code = "no_old_site";
  constructor() {
    super("This workspace has no site from the earlier builder to rebuild.");
    this.name = "NoOldSite";
  }
}

function canonicalText(raw: string | null | undefined): string {
  const decoded = decodeXmlEntities(String(raw ?? "")).trim();
  return decoded ? xmlEscapeContent(sanitizeFetchedContent(decoded)).trim() : "";
}

export function rebuildName(brief: OldSiteBrief | null, source: OldSiteSource): string {
  for (const candidate of [brief?.company_name, source.name]) {
    const name = decodeXmlEntities(String(candidate ?? "")).replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    if (name && !validateCompanyName(name)) return name;
  }
  return "My site";
}

export function rebuildIdea(brief: OldSiteBrief | null, name: string): string {
  const idea = canonicalText(brief?.idea);
  if (idea.length >= MIN_IDEA) return idea.slice(0, MAX_IDEA);
  const objective = canonicalText(
    decodeXmlEntities(String(brief?.objective ?? "")).replace(/^build product:\s*/i, ""),
  );
  if (objective.length >= MIN_IDEA) return objective.slice(0, MAX_IDEA);
  return xmlEscapeContent(`A website for ${name}.`);
}

export async function rebuildOldSite(
  input: { tenant_id: string; started_by_user_id: string | null },
  deps: OldSiteRebuildDeps,
): Promise<OldSiteRebuildResult> {
  const tenant_id = (input.tenant_id ?? "").trim();
  if (!tenant_id) throw new Error("rebuildOldSite: tenant_id is required");

  const source = await deps.loadOldSite(tenant_id);
  if (!source) throw new NoOldSite();

  let brief: OldSiteBrief | null = null;
  if (source.build_run_id) {
    try {
      brief = await deps.loadBrief(tenant_id, source.build_run_id);
    } catch (e) {
      deps.warn?.("old_site_rebuild_brief_unreadable", { error: (e as Error)?.message ?? String(e) });
      brief = null;
    }
  }
  const name = rebuildName(brief, source);

  const claim = await deps.claim(tenant_id, source.build_run_id);
  if (claim.outcome === "existing") return { kind: "existing", conductor_run_id: claim.conductor_run_id };
  if (claim.outcome === "starting") return { kind: "starting" };

  try {
    const started = await deps.startBuild({
      tenant_id,
      company_name: name,
      idea: rebuildIdea(brief, name),
      site_name: name,
      started_by_user_id: input.started_by_user_id,
      onRunCreated: async (conductor_run_id) => {
        if (!(await deps.settle(tenant_id, claim.token, conductor_run_id))) {
          deps.warn?.("old_site_rebuild_claim_lost", { conductor_run_id });
          throw new RebuildClaimLost();
        }
      },
    });
    return { kind: "started", conductor_run_id: started.conductor_run_id };
  } catch (e) {
    await deps.release(tenant_id, claim.token).catch((releaseErr: unknown) => {
      deps.warn?.("old_site_rebuild_release_failed", { error: (releaseErr as Error)?.message ?? String(releaseErr) });
    });
    throw e;
  }
}

export function parseRebuildClaim(data: unknown): RebuildClaim {
  const d = (data ?? {}) as { outcome?: unknown; token?: unknown; conductor_run_id?: unknown };
  if (d.outcome === "claimed" && typeof d.token === "string" && d.token) return { outcome: "claimed", token: d.token };
  if (d.outcome === "existing" && typeof d.conductor_run_id === "string" && d.conductor_run_id) {
    return { outcome: "existing", conductor_run_id: d.conductor_run_id };
  }
  if (d.outcome === "starting") return { outcome: "starting" };
  throw new Error("claim_old_site_rebuild returned an unexpected shape");
}

export function briefFromGraph(objective: string | null, graph: unknown): OldSiteBrief {
  let company_name: string | null = null;
  let idea: string | null = null;
  for (const node of Array.isArray(graph) ? graph : []) {
    const payload = (node as { payload?: { company_name?: unknown; idea?: unknown; refine_mode?: unknown } } | null)?.payload;
    if (!payload || payload.refine_mode === true) continue;
    if (!company_name && typeof payload.company_name === "string" && payload.company_name.trim()) {
      company_name = payload.company_name.trim();
    }
    if (!idea && typeof payload.idea === "string" && payload.idea.trim()) idea = payload.idea.trim();
  }
  return { company_name, idea, objective };
}

export function realOldSiteRebuildDeps(): Omit<OldSiteRebuildDeps, "startBuild"> {
  return {
    loadOldSite: async (tenant_id) => {
      const { oldFlowBuiltApp } = await import("@/services/run-artifacts/built-sites");
      const app = await oldFlowBuiltApp(tenant_id);
      return app ? { name: app.name, build_run_id: app.build_run_id } : null;
    },
    loadBrief: async (tenant_id, conductor_run_id) => {
      const { data, error } = await tenantClient(asTenantId(tenant_id))
        .from("conductor_runs")
        .select("objective, goal_graph")
        .eq("id", conductor_run_id)
        .maybeSingle();
      if (error) throw new Error(`conductor_runs brief read failed: ${error.message}`);
      if (!data) return null;
      const row = data as { objective?: string | null; goal_graph?: unknown };
      return briefFromGraph(row.objective ?? null, row.goal_graph);
    },
    claim: async (tenant_id, source_run_id) => {
      const { data, error } = await tenantRpc(asTenantId(tenant_id), "claim_old_site_rebuild", {
        p_source_run_id: source_run_id,
        p_stale_seconds: REBUILD_CLAIM_STALE_SECONDS,
      });
      if (error) throw new Error(`claim_old_site_rebuild failed: ${error.message}`);
      return parseRebuildClaim(data);
    },
    settle: async (tenant_id, token, conductor_run_id) => {
      const { data, error } = await tenantRpc(asTenantId(tenant_id), "settle_old_site_rebuild", {
        p_token: token,
        p_conductor_run_id: conductor_run_id,
      });
      if (error) throw new Error(`settle_old_site_rebuild failed: ${error.message}`);
      return data === true;
    },
    release: async (tenant_id, token) => {
      const { data, error } = await tenantRpc(asTenantId(tenant_id), "release_old_site_rebuild", { p_token: token });
      if (error) throw new Error(`release_old_site_rebuild failed: ${error.message}`);
      return data === true;
    },
  };
}
