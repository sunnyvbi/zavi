import { socialDraftVersion as version } from "@/services/approvals/social-draft-version";
import type { Request, Response } from "express";
import { z } from "zod";
import { postDraftSaveSchema, savedPostDraftSchema, type SavedPostDraft } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";
import { tenantClient } from "@/services/tenant-client";
import { editedSocialDraft } from "@/services/approvals/social-draft-edit";
import { renderPostDraftImage } from "@/services/channels/post-draft-media";

const rowSchema = z.object({ id: z.string(), status: z.string(), decision_class: z.literal("social.publish.v2"), body: z.object({ channel: z.string(), payload: z.record(z.string(), z.unknown()) }).passthrough() });
const idSchema = z.object({ id: z.string().uuid() });

export async function channelStagedPostDraft(req: Request, res: Response): Promise<void> {
  try {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const params = idSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ error: { code: "validation", message: "Invalid draft ID." } }); return; }
    const db = tenantClient(auth.tenant_id);
    const read = await db.from("decisions").select("id,status,decision_class,body").eq("id", params.data.id).maybeSingle();
    if (read.error) throw new Error("Read failed");
    const parsed = rowSchema.safeParse(read.data);
    if (!parsed.success) { res.status(404).json({ error: { code: "not_found", message: "Post draft not found." } }); return; }
    const row = parsed.data;
    const saved = savedPostDraftSchema.safeParse(row.body.post_draft);
    if (req.method === "GET") { res.setHeader("Cache-Control", "private, no-store"); res.json({ revision: version(row.body), content: saved.success ? saved.data : null, editable: row.status === "proposed" && !auth.tenant_overridden }); return; }
    const input = postDraftSaveSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: { code: "validation", message: "Invalid draft edits." } }); return; }
    const role = await loadTenantRoleFor(auth.user_id, auth.tenant_id);
    if (auth.tenant_overridden || !role || !["owner", "admin", "member"].includes(role)) { res.status(403).json({ error: { code: "forbidden", message: "You cannot edit this workspace’s drafts." } }); return; }
    if (row.status !== "proposed" || version(row.body) !== input.data.revision) { res.status(409).json({ error: { code: "draft_changed", message: "This draft changed. Refresh before editing." } }); return; }
    let content: SavedPostDraft | null = input.data.content;
    if (content?.variant_index !== undefined) { res.status(400).json({ error: { code: "unsupported_variant", message: "Edit this staged post as a single draft." } }); return; }
    const original = rowSchema.shape.body.safeParse(row.body.post_draft_original);
    const originalBody = original.success ? original.data : row.body;
    let next = originalBody;
    if (content) {
      const rendered = await renderPostDraftImage(auth.tenant_id, content, {});
      content = { ...content, ...(rendered ? { rendered_image_path: rendered } : {}) };
      const edited = editedSocialDraft(auth.tenant_id, row.body, { text: content.text, thread: content.thread, ...(rendered ? { image_path: rendered } : {}) });
      next = { ...row.body, ...edited, post_draft: content, post_draft_original: originalBody };
    }
    const result = await db.from("decisions").update({ body: next }).eq("id", row.id).eq("status", "proposed").eq("decision_class", "social.publish.v2").eq("body", JSON.stringify(row.body)).select("id").maybeSingle();
    if (result.error) throw new Error("Save failed");
    if (!result.data) { res.status(409).json({ error: { code: "draft_changed", message: "This draft changed. Refresh before editing." } }); return; }
    res.json({ ok: true, revision: version(next), content });
  } catch (error) { res.status(503).json({ error: { code: "save_failed", message: error instanceof Error && /workspace|photo|image|thread|payload/i.test(error.message) ? error.message.slice(0, 200) : "Could not save this draft. Your edits are still open." } }); }
}
