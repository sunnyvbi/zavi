
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { listAgents } from "@/services/agents/registry";
import { filterTenantVisibleAgents } from "@/services/agents/visibility";
import { annotateLockedTier } from "@/services/agents/entitlement";
import { listCustomAgentsForTree } from "@/services/agents/custom-agents";
import { isCustomAgentSlug } from "@/services/billing/tiers";
import { countThreadsBySlug } from "@/services/agents/thread-counts";

type RuntimeRow = {
  slug: string;
  latest_run_started_at: string | null;
  latest_run_status: string | null;
  latest_event_preview: string;
  pending_decisions_count: number;
  has_unseen_pending: boolean;
  unseen_thread_count: number;
};

export async function workspaceTree(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const visibleAgents = await filterTenantVisibleAgents(listAgents(), auth.tenant_id);
  const annotated = await annotateLockedTier(visibleAgents, auth.tenant_id);
  const customAgents = await listCustomAgentsForTree(auth.tenant_id);
  const registryAgents = [
    ...annotated,
    ...customAgents.map((c) => ({ ...c, metadata_praxis: undefined as { department?: string } | undefined })),
  ];
  const customExtra = (a: { slug: string; name: string; id?: string }) =>
    isCustomAgentSlug(a.slug)
      ? { name: a.name, custom: true, ...(typeof a.id === "string" ? { custom_agent_id: a.id } : {}) }
      : {};

  const { data, error } = await supabase.rpc("list_agents_for_tenant");
  if (error) {
    res.json({
      agents: registryAgents.map((a) => ({
        slug: a.slug,
        department: a.metadata_praxis?.department ?? "others",
        locked_tier: a.locked_tier,
        latest_run_started_at: null,
        latest_run_status: null,
        latest_event_preview: "",
        pending_decisions_count: 0,
        thread_count: 0,
        has_unseen_pending: true,
        unseen_thread_count: 0,
        ...customExtra(a),
      })),
    });
    return;
  }

  const runtimeBySlug = new Map<string, RuntimeRow>();
  for (const r of (data ?? []) as RuntimeRow[]) {
    runtimeBySlug.set(r.slug, r);
  }
  const threadCountBySlug = await countThreadsBySlug(
    supabase,
    auth.tenant_id,
    auth.user_id,
  );
  const agents = registryAgents.map((a) => {
    const rt = runtimeBySlug.get(a.slug);
    return {
      slug: a.slug,
      thread_count: threadCountBySlug.get(a.slug) ?? 0,
      department: a.metadata_praxis?.department ?? "others",
      locked_tier: a.locked_tier,
      latest_run_started_at: rt?.latest_run_started_at ?? null,
      latest_run_status: rt?.latest_run_status ?? null,
      latest_event_preview: rt?.latest_event_preview ?? "",
      pending_decisions_count: rt?.pending_decisions_count ?? 0,
      has_unseen_pending: rt?.has_unseen_pending ?? true,
      unseen_thread_count: rt?.unseen_thread_count ?? 0,
      ...customExtra(a),
    };
  });

  res.json({ agents });
}
