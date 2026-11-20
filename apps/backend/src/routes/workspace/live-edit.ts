import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { isProductBuilderEnabled } from "@/agents/engineer/product-builder-flag";
import { ExpectedToolError } from "@/services/tools/types";
import {
  LiveEditError,
  discardDraft,
  readLiveEditState,
  wakeLiveEditPreview,
} from "@/services/build/live-edit";
import { OLD_SITE_FROZEN_STATUS, oldSiteFrozenBody } from "@/services/sites/old-site-freeze";

const WRITE_ROLES = ["owner", "admin"] as const;

function sendError(res: Response, e: unknown, fallbackCode: string): void {
  if (e instanceof LiveEditError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  if (e instanceof ExpectedToolError && e.code === "fast_forward_rejected") {
    res.status(409).json({
      error: {
        code: "draft_behind",
        message: "Your live app changed since these edits were made. Discard the draft and make the change again.",
      },
    });
    return;
  }
  console.warn(`[live-edit] ${fallbackCode}: ${(e as Error)?.message ?? e}`);
  res.status(500).json({ error: { code: fallbackCode, message: "Something went wrong. Try again." } });
}

async function gate(req: Request, res: Response, write: boolean) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (write && !(await requireTenantRole(auth, WRITE_ROLES, res))) return null;
  if (!(await isProductBuilderEnabled())) {
    res.status(403).json({ error: { code: "product_builder_disabled", message: "Product builder is not enabled." } });
    return null;
  }
  return auth;
}

export async function getLiveEditState(req: Request, res: Response): Promise<void> {
  const auth = await gate(req, res, false);
  if (!auth) return;
  try {
    res.set("Cache-Control", "no-store");
    res.json(await readLiveEditState(auth.tenant_id, undefined, { framed: req.query.framed === "1" }));
  } catch (e) {
    sendError(res, e, "live_edit_state_failed");
  }
}

export async function postPublishDraft(req: Request, res: Response): Promise<void> {
  const auth = await gate(req, res, true);
  if (!auth) return;
  res.status(OLD_SITE_FROZEN_STATUS).json(oldSiteFrozenBody());
}

export async function postDiscardDraft(req: Request, res: Response): Promise<void> {
  const auth = await gate(req, res, true);
  if (!auth) return;
  try {
    res.json({ ok: true, ...(await discardDraft(auth.tenant_id)) });
  } catch (e) {
    sendError(res, e, "discard_draft_failed");
  }
}

export async function postWakeLiveEditPreview(req: Request, res: Response): Promise<void> {
  const auth = await gate(req, res, true);
  if (!auth) return;
  try {
    res.json({ ok: true, ...(await wakeLiveEditPreview(auth.tenant_id)) });
  } catch (e) {
    sendError(res, e, "wake_preview_failed");
  }
}
