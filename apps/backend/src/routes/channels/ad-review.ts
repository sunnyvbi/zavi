import type { Request, Response } from "express";
import { z } from "zod";
import { adReviewChangesSchema, getChannel } from "@zavi/shared";
import { requireAuth } from "@/services/auth/middleware";
import { loadTenantRole, requireTenantRole } from "@/services/auth/tenant-role";
import { tenantClient, tenantRpc } from "@/services/tenant-client";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { reviewRowSchema, readAdReview, revisedAd, StaleAdRevision } from "@/services/channels/ad-review/revision";

const params = z.object({ id: z.string().uuid() });
const input = adReviewChangesSchema.extend({ request_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/) });
const result = z.object({ ok: z.boolean(), action_id: z.string().uuid().optional(), code: z.string().optional() });

async function action(req: Request, res: Response) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  const id = params.safeParse(req.params);
  if (!id.success) { res.status(400).json({ error: { code: "validation", message: "Invalid action ID." } }); return null; }
  const { data, error } = await tenantClient(auth.tenant_id).from("channel_actions")
    .select("id,channel_slug,exec_class,exec_payload,body,status,exec_status,exec_result,approved_by,score,score_inputs,blocking,impact,impact_reason").eq("id", id.data.id).maybeSingle();
  if (error) { res.status(503).json({ error: { code: "read_failed", message: "Could not load this proposal. Try again." } }); return null; }
  const parsed = reviewRowSchema.safeParse(data);
  if (!parsed.success || getChannel(parsed.data.channel_slug)?.category !== "paid") {
    res.status(404).json({ error: { code: "not_found", message: "Ad proposal not found." } }); return null;
  }
  let objectChanges = false;
  let approvals: number | undefined;
  if (parsed.data.exec_status === "failed") {
    const db = tenantClient(auth.tenant_id);
    const [changes, approved] = await Promise.all([
      db.from("ad_object_changes").select("action_id").eq("action_table", "channel_actions").eq("action_id", parsed.data.id).limit(1),
      db.from("channel_action_events").select("id", { count: "exact", head: true }).eq("action_id", parsed.data.id).eq("event", "approved"),
    ]);
    objectChanges = !!changes.error || (changes.data ?? []).length > 0;
    approvals = approved.error ? undefined : approved.count ?? undefined;
  }
  return { auth, row: { ...parsed.data, object_changes: objectChanges, approvals } };
}

export async function channelAdReview(req: Request, res: Response): Promise<void> {
  try {
    const current = await action(req, res);
    if (!current) return;
    res.setHeader("Cache-Control", "private, no-store");
    const role = current.auth.tenant_overridden ? null : await loadTenantRole(current.auth);
    res.json(await readAdReview(current.auth.tenant_id, current.row, req.query.refresh === "1", role === "owner" || role === "admin"));
  } catch { res.status(503).json({ error: { code: "preview_unavailable", message: "The ad preview could not be loaded. Try again." } }); }
}

async function revise(req: Request, res: Response): Promise<void> {
  const parsed = input.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { code: "validation", message: "Invalid proposal edits." } }); return; }
  const current = await action(req, res);
  if (!current) return;
  const { auth, row } = current;
  if (auth.tenant_overridden) { res.status(403).json({ error: { code: "forbidden", message: "An overridden workspace cannot revise ads." } }); return; }
  if (!await requireTenantRole(auth, ["owner", "admin"], res)) return;
  const locked = await refuseIfChannelPlanLocked(auth.tenant_id, row.channel_slug);
  if (locked) { res.status(403).json(locked.body); return; }
  let next;
  try { next = revisedAd(row, parsed.data.revision, parsed.data.changes, true); }
  catch (error) {
    if (error instanceof StaleAdRevision) { res.status(409).json({ error: { code: "invalid_revision", message: error.message } }); return; }
    res.status(422).json({ error: { code: "invalid_changes", message: error instanceof Error ? error.message : "Check your changes and try again." } }); return;
  }
  const { data, error } = await tenantRpc(auth.tenant_id, "revise_pending_ad_action", {
    p_action_id: row.id, p_actor_user_id: auth.user_id, p_expected_payload: row.exec_payload,
    p_expected_body: row.body, p_payload: next.payload, p_body: next.body, p_request_id: parsed.data.request_id,
  });
  if (error) { res.status(503).json({ error: { code: "revision_unavailable", message: "Changes could not be confirmed. Refresh the channel before retrying." } }); return; }
  const out = result.safeParse(data);
  if (!out.success || !out.data.ok) { res.status(409).json({ error: { code: "action_changed", message: "This proposal changed. Refresh the channel before editing." } }); return; }
  res.json(out.data);
}

export async function channelAdRevise(req: Request, res: Response): Promise<void> {
  try { await revise(req, res); }
  catch { res.status(503).json({ error: { code: "revision_unavailable", message: "Changes could not be confirmed. Refresh the channel before retrying." } }); }
}

export async function channelAdPreview(req: Request, res: Response): Promise<void> {
  try {
    const input = adReviewChangesSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: { code: "validation", message: "Invalid preview changes." } }); return; }
    const current = await action(req, res);
    if (!current) return;
    const next = revisedAd(current.row, input.data.revision, input.data.changes);
    const result = await readAdReview(current.auth.tenant_id, { ...current.row, exec_payload: next.payload, body: next.body });
    res.setHeader("Cache-Control", "private, no-store"); res.json(result);
  } catch { res.status(409).json({ error: { code: "preview_unavailable", message: "The source could not be resolved. Check the ID and connection, then try again." } }); }
}
