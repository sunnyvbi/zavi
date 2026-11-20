
import type { Request, Response } from "express";
import { z } from "zod";
import {
  assertValidAgentSlug,
  InvalidSlugError,
} from "@/services/memory/loader";
import { listAgentSlugs } from "@/services/agents/registry";
import { PRICING } from "@/services/anthropic";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";

const Body = z.object({
  slug: z.string().min(1).max(48),
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  model: z.string().min(1),
  cost_class: z.enum(["cheap", "standard", "expensive"]),
  sla_class: z.enum(["realtime", "prompt", "daily", "bulk"]).optional(),
  cron: z.string().max(64).default(""),
  impact_classes: z.array(z.string()).default([]),
  instructions: z.string().min(1),
});

export async function agentDraft(req: Request, res: Response): Promise<void> {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(req.body);
  } catch (e) {
    res.status(400).json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    assertValidAgentSlug(body.slug);
  } catch (e) {
    if (e instanceof InvalidSlugError) {
      res.status(400).json({ error: { code: "invalid_slug", message: e.message } });
      return;
    }
    throw e;
  }

  if (!Object.keys(PRICING).includes(body.model)) {
    res.status(400).json({
      error: {
        code: "invalid_model",
        message: `model must be one of: ${Object.keys(PRICING).join(", ")}`,
      },
    });
    return;
  }

  const liveSlugs = listAgentSlugs();
  if (liveSlugs.includes(body.slug)) {
    res.status(409).json({
      error: { code: "slug_collision", message: `slug "${body.slug}" is already a live agent` },
    });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { error } = await supabase.rpc("create_agent_draft", {
    p_tenant_id: auth.tenant_id,
    p_slug: body.slug,
    p_name: body.name,
    p_description: body.description,
    p_model: body.model,
    p_cost_class: body.cost_class,
    p_sla_class: body.sla_class ?? null,
    p_cron: body.cron,
    p_impact_classes: body.impact_classes,
    p_instructions: body.instructions,
  });
  if (error) {
    const code = error.code === "23505" ? "slug_collision" : "draft_failed";
    const status = code === "slug_collision" ? 409 : 500;
    res.status(status).json({ error: { code, message: error.message } });
    return;
  }

  res.json({ ok: true, slug: body.slug });
}
