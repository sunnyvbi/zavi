
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { listAgents } from "@/services/agents/registry";
import { getAgentEffectiveStates } from "@/services/agents/visibility";

export async function agentVisibilityList(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const states = await getAgentEffectiveStates(auth.tenant_id);
    const registry = listAgents();
    const nameBySlug = new Map(registry.map((a) => [a.slug, a.name]));
    const deptBySlug = new Map(
      registry.map((a) => [a.slug, a.metadata_praxis?.department ?? "others"]),
    );
    const agents = states.map((s) => ({
      ...s,
      name: nameBySlug.get(s.slug) ?? s.slug,
      department: deptBySlug.get(s.slug) ?? "others",
    }));
    res.json({
      tenant_id: auth.tenant_id,
      agents,
    });
  } catch (e) {
    res.status(500).json({
      error: { code: "visibility_read_failed", message: (e as Error).message },
    });
  }
}
