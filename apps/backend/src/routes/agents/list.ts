
import type { Request, Response } from "express";
import { LISTED_AGENT_SLUGS, listAgents } from "@/services/agents/registry";
import { presentationStatus } from "@/services/agents/run-display-state";
import { filterTenantVisibleAgents } from "@/services/agents/visibility";
import { annotateLockedTier, tenantPlanForDisplay } from "@/services/agents/entitlement";
import { tenantClient, type TenantId } from "@/services/tenant-client";
import { requireAuth } from "@/services/auth/middleware";
import { tenantRoleOf } from "@/services/auth/members";
import { serviceClient } from "@/services/supabase";

export function shapeCatalogMetadata(mp: unknown): { cost_class: unknown; tools: string[] } {
  const m = (mp ?? {}) as Record<string, unknown>;
  const toolCount = Array.isArray(m.tools) ? (m.tools as unknown[]).length : 0;
  return {
    cost_class: m.cost_class,
    tools: Array.from({ length: toolCount }, () => "•"),
  };
}

type DraftRow = {
  slug: string;
  name: string;
  model: string;
  created_at: string;
};

type CustomListRow = { id: string; slug: string; name: string; role: string; tools: unknown; status: string };

async function listCustomAgentsForTenant(tenant_id: TenantId): Promise<CustomListRow[]> {
  try {
    const { data, error } = await tenantClient(tenant_id)
      .from("custom_agents")
      .select("id, slug, name, role, tools, status")
      .eq("status", "active")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as CustomListRow[];
  } catch (e) {
    console.warn(`[agents/list] custom_agents read failed, listing built-ins only: ${(e as Error).message}`);
    return [];
  }
}

async function listDraftsForTenant(tenant_id: string): Promise<DraftRow[]> {
  const { data, error } = await serviceClient()
    .from("agent_drafts")
    .select("slug, name, model, created_at")
    .eq("tenant_id", tenant_id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    throw new Error(`agent_drafts read failed: ${error.message}`);
  }
  return (data ?? []) as DraftRow[];
}

export async function agentsList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const listed = listAgents().filter((a) => LISTED_AGENT_SLUGS.includes(a.slug));
    let agents = await annotateLockedTier(
      await filterTenantVisibleAgents(listed, auth.tenant_id),
      auth.tenant_id,
    );

    const sb = serviceClient();
    if ((await tenantRoleOf(sb, auth.user_id, auth.tenant_id)) === null) agents = [];

    const agentRows = await Promise.all(
      agents.map(async (a) => {
        const { data: runs, error: rerr } = await sb
          .from("agent_runs")
          .select("id, status, finished_at, outcome, output_text")
          .eq("agent_slug", a.slug)
          .eq("tenant_id", auth.tenant_id)
          .order("enqueued_at", { ascending: false })
          .limit(100);
        if (rerr) throw new Error(`agent_runs read failed: ${rerr.message}`);
        const rows = runs ?? [];
        const latest = rows[0] ?? null;
        const successCount = rows.filter((r) => r.status === "success").length;
        return {
          slug: a.slug,
          name: a.name,
          description: a.description,
          content_hash: a.content_hash,
          metadata_praxis: shapeCatalogMetadata(a.metadata_praxis),
          locked_tier: a.locked_tier,
          is_chat_eligible: true,
          runs_total: rows.length,
          latest_run: latest
            ? {
                id: latest.id,
                finished_at: latest.finished_at,
                status: latest.status,
                presentation_status: presentationStatus({
                  status: latest.status,
                  outcome:
                    (latest as { outcome?: { deliverable?: string | null } | null }).outcome ??
                    null,
                  outputText: (latest as { output_text?: string | null }).output_text ?? null,
                }),
              }
            : null,
          parse_ok_rate: successCount > 0 ? successCount / rows.length : null,
        };
      }),
    );

    const customRows = await listCustomAgentsForTenant(auth.tenant_id);
    let customLock: "starter" | null = null;
    if (customRows.length > 0) {
      const plan = await tenantPlanForDisplay(auth.tenant_id);
      customLock = plan === "free" ? "starter" : null;
    }
    const customAgentRows = await Promise.all(
      customRows.map(async (c) => {
        const { data: runs, error: rerr } = await sb
          .from("agent_runs")
          .select("id, status, finished_at")
          .eq("agent_slug", c.slug)
          .eq("tenant_id", auth.tenant_id)
          .order("enqueued_at", { ascending: false })
          .limit(100);
        if (rerr) throw new Error(`agent_runs read failed: ${rerr.message}`);
        const rows = runs ?? [];
        const latest = rows[0] ?? null;
        const successCount = rows.filter((r) => r.status === "success").length;
        return {
          slug: c.slug,
          name: c.name,
          description: c.role || c.name,
          content_hash: "",
          metadata_praxis: shapeCatalogMetadata({ cost_class: "standard", tools: c.tools }),
          locked_tier: customLock,
          is_chat_eligible: true,
          custom: true,
          custom_agent_id: c.id,
          status: c.status,
          runs_total: rows.length,
          latest_run: latest
            ? { id: latest.id, finished_at: latest.finished_at, status: latest.status }
            : null,
          parse_ok_rate: successCount > 0 ? successCount / rows.length : null,
        };
      }),
    );

    const drafts = await listDraftsForTenant(auth.tenant_id);
    res.json({ agents: [...agentRows, ...customAgentRows], drafts });
  } catch (e) {
    res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
  }
}
