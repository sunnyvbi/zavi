import { channelStagedPostDraft } from "./staged-post-draft";
import { adReviewVersion } from "@/services/channels/ad-review/version";
import type { Request, Response } from "express";
import { z } from "zod";
import { savedPostDraftSchema, postDraftSaveSchema, type PostDraftReview, type SavedPostDraft } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { renderPostDraftImage } from "@/services/channels/post-draft-media";
import { tenantClient } from "@/services/tenant-client";
import { loadTenantRoleFor } from "@/services/auth/tenant-role";

const idSchema = z.object({ id: z.string().uuid() });
const rowSchema = z.object({ id: z.string(), body: z.unknown(), edited_body: z.unknown(), status: z.string(), action_type: z.string(), exec_class: z.string().nullable(), exec_status: z.string().nullable(), approved_by: z.string().nullable() });
const postTypes = new Set(["text_post", "image_post", "video_post", "reply"]);
function revision(row: z.infer<typeof rowSchema>) { return adReviewVersion("channel.post-draft", [row.body, row.edited_body]); }

async function read(req: Request, res: Response) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  const params = idSchema.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: { code: "validation", message: "Invalid draft ID." } }); return null; }
  const query = await tenantClient(auth.tenant_id).from("channel_actions").select("id,body,edited_body,status,action_type,exec_class,exec_status,approved_by").eq("id", params.data.id).maybeSingle();
  if (query.error) { res.status(503).json({ error: { code: "draft_unavailable", message: "Could not read this draft." } }); return null; }
  const row = rowSchema.safeParse(query.data);
  if (!row.success || !postTypes.has(row.data.action_type) || row.data.exec_class) { res.status(404).json({ error: { code: "not_found", message: "Editable post draft not found." } }); return null; }
  return { auth, row: row.data };
}

export async function channelPostDraftRead(req: Request, res: Response): Promise<void> {
  if (req.query.store === "decisions") return channelStagedPostDraft(req, res);
  try {
    const current = await read(req, res);
    if (!current) return;
    const { row } = current;
    const parsed = savedPostDraftSchema.safeParse(row.edited_body);
    const result: PostDraftReview = { revision: revision(row), content: parsed.success ? parsed.data : null, editable: row.status === "pending" && !row.exec_status && !row.approved_by && !current.auth.tenant_overridden };
    res.setHeader("Cache-Control", "private, no-store"); res.json(result);
  } catch { res.status(503).json({ error: { code: "draft_unavailable", message: "Could not read this draft." } }); }
}

export async function channelPostDraftSave(req: Request, res: Response): Promise<void> {
  if (req.query.store === "decisions") return channelStagedPostDraft(req, res);
  try {
    const input = postDraftSaveSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: { code: "validation", message: "Invalid draft changes." } }); return; }
    const current = await read(req, res);
    if (!current) return;
    const { auth, row } = current;
    const role = await loadTenantRoleFor(auth.user_id, auth.tenant_id);
    if (auth.tenant_overridden || !role || !["owner", "admin", "member"].includes(role)) { res.status(403).json({ error: { code: "forbidden", message: "You cannot edit this workspace’s drafts." } }); return; }
    if (row.status !== "pending" || row.exec_status || row.approved_by || revision(row) !== input.data.revision) { res.status(409).json({ error: { code: "draft_changed", message: "This draft changed. Refresh before editing it." } }); return; }
    if (row.action_type !== "image_post" && input.data.content && [input.data.content.image_path, input.data.content.size, input.data.content.headline].some((value) => value !== undefined)) {
      res.status(400).json({ error: { code: "unsupported_media", message: "This draft supports text editing only." } }); return;
    }
    const image = input.data.content?.image_path;
    if (image && (!image.startsWith(`${auth.tenant_id}/`) || !/^[a-f0-9-]{36}\/[a-f0-9-]{36}\.(png|jpg|jpeg|webp)$/.test(image))) { res.status(403).json({ error: { code: "image_not_owned", message: "Choose an image from this workspace." } }); return; }
    let content: SavedPostDraft | null = input.data.content;
    if (content?.variant_index !== undefined) {
      const previous = savedPostDraftSchema.safeParse(row.edited_body);
      content = { ...content, variants: { ...(previous.success ? previous.data.variants : {}), [content.variant_index]: { text: content.text, thread: content.thread } } };
    }
    if (content && (content.image_path || content.size || content.headline)) {
      try { const rendered = await renderPostDraftImage(auth.tenant_id, content, row.body); content = { ...content, ...(rendered ? { rendered_image_path: rendered } : {}) }; }
      catch (error) { res.status(400).json({ error: { code: "image_unavailable", message: error instanceof Error ? error.message : "Could not save the edited photo." } }); return; }
    }
    let query = tenantClient(auth.tenant_id).from("channel_actions").update({ edited_body: content }).eq("id", row.id).eq("status", "pending").is("exec_class", null).is("exec_status", null).is("approved_by", null).eq("body", JSON.stringify(row.body));
    query = row.edited_body == null ? query.is("edited_body", null) : query.eq("edited_body", JSON.stringify(row.edited_body));
    const saved = await query.select("id").maybeSingle();
    if (saved.error) { res.status(503).json({ error: { code: "save_failed", message: "Could not save the draft. Your edits are still open." } }); return; }
    if (!saved.data) { res.status(409).json({ error: { code: "draft_changed", message: "This draft changed. Refresh before editing it." } }); return; }
    res.json({ ok: true, revision: revision({ ...row, edited_body: content }), content: content });
  } catch { res.status(503).json({ error: { code: "save_failed", message: "Could not save the draft. Your edits are still open." } }); }
}
