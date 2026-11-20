import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { redditDb as serviceClient } from "@/services/channels/reddit/db";
import {
  ALREADY_POSTED_MESSAGE,
  DRAFT_MAX_CHARS,
  DRAFT_RATE_LIMITED_MESSAGE,
  THREAD_GONE_MESSAGE,
  draftThreadReply,
  updateThreadDraft,
} from "@/services/channels/reddit/draft";
import { consumeTenantRateLimit, tenantMarkerAt, type TenantId } from "@/services/tenant-client";

const idSchema = z.string().uuid();

const DRAFT_BUCKET = "reddit_draft";
const DRAFT_LIMIT = 20;
const DRAFT_WINDOW_S = 60 * 60;

async function draftRetryAfterS(tenantId: TenantId): Promise<number> {
  try {
    const start = await tenantMarkerAt(tenantId, DRAFT_BUCKET);
    if (start !== null) return Math.max(1, Math.ceil((start + DRAFT_WINDOW_S * 1000 - Date.now()) / 1000));
  } catch (err) {
    console.error("[reddit-threads] draft window read failed", err instanceof Error ? err.message : err);
  }
  return DRAFT_WINDOW_S;
}

export async function redditThreadDraftPost(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: "not_found", message: THREAD_GONE_MESSAGE });
    return;
  }
  try {
    const result = await draftThreadReply(serviceClient(), auth.tenant_id, id.data, {}, {
      claim: () => consumeTenantRateLimit(auth.tenant_id, DRAFT_BUCKET, DRAFT_LIMIT, DRAFT_WINDOW_S),
    });
    if (result.ok) {
      res.json({ draft: { text: result.text } });
      return;
    }
    if (result.code === "rate_limited") {
      res.status(429).json({
        error: "rate_limited",
        message: DRAFT_RATE_LIMITED_MESSAGE,
        retry_after_s: await draftRetryAfterS(auth.tenant_id),
      });
      return;
    }
    if (result.code === "not_found") {
      res.status(404).json({ error: "not_found", message: result.message });
      return;
    }
    if (result.code === "already_posted") {
      res.status(409).json({ error: "already_posted", message: result.message });
      return;
    }
    res.status(502).json({ error: "draft_failed", message: result.message });
  } catch (err) {
    console.error("[reddit-threads] draft failed", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "draft_failed", message: "Zavi couldn't draft a reply right now. Try again in a minute." });
  }
}

const threadPatchSchema = z.object({
  draft_state: z.enum(["drafted", "posted", "dismissed"]),
  draft_text: z.string().trim().min(1).max(DRAFT_MAX_CHARS).optional(),
}).refine((patch) => patch.draft_state !== "drafted" || !!patch.draft_text, { message: "A saved draft needs text." });

export async function redditThreadUpdate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: "not_found", message: THREAD_GONE_MESSAGE });
    return;
  }
  const parsed = threadPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues.map((i) => i.message) });
    return;
  }
  try {
    const outcome = await updateThreadDraft(serviceClient(), auth.tenant_id, id.data, parsed.data);
    if (outcome === "not_found") {
      res.status(404).json({ error: "not_found", message: THREAD_GONE_MESSAGE });
      return;
    }
    if (outcome === "already_posted") {
      res.status(409).json({ error: "already_posted", message: ALREADY_POSTED_MESSAGE });
      return;
    }
    res.json({ ok: true, draft_state: parsed.data.draft_state });
  } catch (err) {
    console.error("[reddit-threads] update failed", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "reddit_thread_update_failed" });
  }
}
