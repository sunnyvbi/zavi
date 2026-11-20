
import type { Request, Response } from "express";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { promoteDiscoveryDraft, isCanonicalSlug } from "@/services/readiness/promote-draft";

export async function staffBrainDrafts(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenant_id = req.params.tenant_id;

  const { data, error } = await serviceClient()
    .from("memory_note")
    .select("id, slug, title, body_markdown, metadata, created_at, updated_at")
    .eq("tenant_id", tenant_id)
    .eq("source", "agent_discovery_inferred")
    .is("superseded_by", null)
    .order("updated_at", { ascending: false });
  if (error) {
    res.status(500).json({ error: { code: "brain_drafts_failed", message: error.message } });
    return;
  }

  const drafts = (data ?? []).map((r) => {
    const row = r as {
      id: string;
      slug: string;
      title: string | null;
      body_markdown: string | null;
      metadata: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
    };
    const d = (row.metadata?.discovery ?? {}) as Record<string, unknown>;
    return {
      note_id: row.id,
      draft_slug: row.slug,
      canonical_slug: row.slug.replace(/__inferred$/, ""),
      title: row.title,
      body_markdown: row.body_markdown,
      confidence: d.confidence ?? "low",
      domain_corroborated: d.domain_corroborated ?? false,
      independent_domains: d.independent_domains ?? 0,
      fetched_hosts: d.fetched_hosts ?? [],
      cited_sources: d.cited_sources ?? [],
      promote_hint: d.promote_hint ?? null,
      updated_at: row.updated_at,
    };
  });

  res.json({ drafts });
}

export async function staffBrainPromote(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenant_id = req.params.tenant_id;
  const body = (req.body ?? {}) as { slug?: unknown; force?: unknown };

  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!isCanonicalSlug(slug)) {
    res.status(400).json({
      error: { code: "bad_slug", message: "slug must be one of the canonical brain anchors" },
    });
    return;
  }
  const force = body.force === true;

  try {
    const result = await promoteDiscoveryDraft({
      tenant_id,
      slug,
      force,
      actor_user_id: (req as { staff_user_id?: string }).staff_user_id ?? null,
    });

    if (result.ok) {
      res.json({ promoted: result });
      return;
    }
    if (result.code === "no_draft") {
      res.status(404).json({ error: { code: result.code, message: result.message } });
      return;
    }
    if (result.code === "render_failed") {
      res.status(503).json({ error: { code: result.code, message: result.message } });
      return;
    }
    res.status(409).json({
      error: {
        code: result.code,
        message: result.message,
        existing_source: result.existing_source,
      },
    });
  } catch (e) {
    res
      .status(500)
      .json({ error: { code: "promote_failed", message: (e as Error).message } });
  }
}
