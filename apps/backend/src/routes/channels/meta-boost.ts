
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { ExpectedToolError } from "@/services/tools/types";
import { BOOST_REASON_TEXT, createBoostAd, readBoostOptions } from "@/services/tools/meta-ads/write/boost_post";

const CHANNEL = "meta_ads";
const MetaId = z.string().trim().regex(/^[0-9]{1,40}$/);

async function gate(req: Request, res: Response, write: boolean) {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (write && (auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to make changes." } });
    return null;
  }
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return null;
  const locked = await refuseIfChannelPlanLocked(auth.tenant_id, CHANNEL);
  if (locked) {
    res.status(403).json(locked.body);
    return null;
  }
  return auth;
}

export async function metaBoostOptions(req: Request, res: Response): Promise<void> {
  const auth = await gate(req, res, false);
  if (!auth) return;
  const q = z.object({ page_id: MetaId.optional() }).safeParse(req.query ?? {});
  try {
    res.json(await readBoostOptions(auth.tenant_id, q.success ? q.data.page_id : undefined));
  } catch (e) {
    console.warn(`[meta-boost] options: ${(e as Error).message}`);
    res.status(502).json({ error: { code: "meta_boost_unavailable", message: "Zavi couldn't read your Meta account just now. Try again in a minute." } });
  }
}

const BoostBody = z.object({
  page_id: MetaId,
  post_id: z.string().trim().regex(/^[0-9]{1,40}(_[0-9]{1,40})?$/),
  ad_set_id: MetaId,
  request_id: z.string().trim().min(8).max(200).optional(),
});

function isRefusal(code: string): boolean {
  return Object.keys(BOOST_REASON_TEXT).some((r) => code === `meta_ads_${r}`) || code.startsWith("meta_ads_boost_") || code === "meta_ads_post_not_on_page" || code === "meta_ads_scope_missing" || code === "meta_ads_page_not_managed" || code === "meta_ads_page_role_missing";
}

export async function metaBoostCreate(req: Request, res: Response): Promise<void> {
  const auth = await gate(req, res, true);
  if (!auth) return;
  const body = BoostBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "bad_boost_request", message: "Pick a Page, a post and an ad set." } });
    return;
  }
  try {
    const r = await createBoostAd(auth.tenant_id, { page_id: body.data.page_id, post_id: body.data.post_id, ad_set_id: body.data.ad_set_id });
    res.json({ ...r, note: "The ad is paused. Nothing spends until you turn it on in Meta Ads Manager." });
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      res.status(isRefusal(e.code) ? 409 : 502).json({ error: { code: e.code, message: e.message } });
      return;
    }
    console.warn(`[meta-boost] create: ${(e as Error).message}`);
    res.status(502).json({ error: { code: "meta_boost_failed", message: "Meta did not create the ad. Nothing was changed. Try again." } });
  }
}
