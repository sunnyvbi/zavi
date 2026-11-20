
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import {
  mergeEditableFrontmatter,
  FrontmatterValidationError,
  ALLOWED_MODELS,
  EDITABLE_FRONTMATTER_KEYS,
  LOCKED_FRONTMATTER_KEYS,
  listFleetToolUniverse,
} from "@/services/agents/setup-schema";

const Body = z.object({
  body_markdown: z.string().min(1),
  frontmatter: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["draft", "active", "retired"]).default("draft"),
});

export async function agentSave(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = req.params.slug;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body);
  } catch (e) {
    res.status(400).json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);

  const { data: latest, error: latestErr } = await supabase
    .from("tenant_agents")
    .select("frontmatter")
    .eq("tenant_id", auth.tenant_id)
    .eq("slug", slug)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) {
    res.status(500).json({ error: { code: "save_failed", message: latestErr.message } });
    return;
  }
  if (!latest) {
    res.status(409).json({
      error: { code: "not_forked_yet", message: "Fork this agent before editing." },
    });
    return;
  }
  const base = (latest.frontmatter ?? {}) as Record<string, unknown>;

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = mergeEditableFrontmatter(base, body.frontmatter);
  } catch (e) {
    if (e instanceof FrontmatterValidationError) {
      res.status(400).json({
        error: { code: e.code, message: e.message, field: e.field },
      });
      return;
    }
    res.status(400).json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const { data: version, error } = await supabase.rpc("save_agent_version", {
    p_tenant_id: auth.tenant_id,
    p_slug: slug,
    p_body_markdown: body.body_markdown,
    p_frontmatter: frontmatter,
    p_status: body.status,
  });
  if (error) {
    const code = error.code === "P0002" ? "not_forked_yet" : "save_failed";
    const status = code === "not_forked_yet" ? 409 : 500;
    res.status(status).json({ error: { code, message: error.message } });
    return;
  }
  res.json({ ok: true, slug, version });
}

export async function agentEditSchema(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  res.json({
    allowed_models: ALLOWED_MODELS,
    tool_universe: listFleetToolUniverse(),
    editable_fields: EDITABLE_FRONTMATTER_KEYS,
    locked_fields: LOCKED_FRONTMATTER_KEYS,
    response_contracts: ["auto", "digest", "terse"],
    recall_policies: ["always", "live_state_aware"],
    cost_classes: ["cheap", "standard", "expensive"],
  });
}
