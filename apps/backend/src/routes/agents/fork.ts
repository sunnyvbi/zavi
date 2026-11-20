
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { loadGlobalAgentDefinition } from "@/services/agents/registry";
import { serverClientFromBearer } from "@/services/supabase";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

export async function agentFork(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const slug = req.params.slug;

  const global = loadGlobalAgentDefinition(slug);
  if (!global) {
    res.status(404).json({
      error: { code: "template_not_found", message: `no global template for slug "${slug}"` },
    });
    return;
  }

  const raw = fs.readFileSync(path.join(AGENTS_ROOT, slug, "agent.md"), "utf-8");
  const parsed = matter(raw);
  const frontmatter = parsed.data as Record<string, unknown>;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data: version, error } = await supabase.rpc("fork_agent_template", {
    p_tenant_id: auth.tenant_id,
    p_slug: slug,
    p_body_markdown: parsed.content,
    p_frontmatter: frontmatter,
    p_parent_template: slug,
  });
  if (error) {
    res.status(500).json({ error: { code: "fork_failed", message: error.message } });
    return;
  }
  res.json({ ok: true, slug, version });
}
