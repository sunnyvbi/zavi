import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { checkAgentTier, planUpgradeErrorBody } from "@/services/agents/entitlement";
import { isChannelLocked } from "@/services/channels/lock";
import { filePastedEmail, PASTE_CHANNEL, type PasteDeps } from "@/services/email-cards/paste";

const PasteBody = z.object({ inputs: z.record(z.string(), z.unknown()) }).strict();

const FORM_CODES = new Set(["validation", "paste_required", "email_button_link_missing", "top_action_mismatch", "email_list_required", "list_not_found", "email_audience_missing"]);

function statusOf(code: string): number {
  if (code === "paste_failed") return 500;
  if (FORM_CODES.has(code) || code.startsWith("email_render_")) return 400;
  if (code.endsWith("_unreadable") || code.endsWith("_unavailable") || code === "email_tool_read_failed") return 503;
  return 409;
}

export function makePostEmailPasteHandler(
  deps: Partial<PasteDeps> = {},
  tierCheck: typeof checkAgentTier = checkAgentTier,
  lockCheck: typeof isChannelLocked = isChannelLocked,
) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
      res.locals.idempotencyRelease = true;
      res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Switch to your own workspace to make changes." } });
      return;
    }
    res.locals.idempotencyRelease = true;
    let roleOk: boolean;
    try {
      roleOk = await requireTenantRole(auth, ["owner", "admin"], res);
    } catch (e) {
      console.warn(`[email-cards/paste] role check failed: ${(e as Error).message}`);
      res.status(503).json({ error: { code: "role_unreadable", message: "Zavi could not check your role just now. Try again in a minute." } });
      return;
    }
    if (!roleOk) return;
    res.locals.idempotencyRelease = false;
    const body = PasteBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.locals.idempotencyRelease = true;
      res.status(400).json({ error: { code: "validation", message: "Check the form and try again." } });
      return;
    }
    let tier: Awaited<ReturnType<typeof checkAgentTier>>;
    try {
      tier = await tierCheck(auth.tenant_id, PASTE_CHANNEL);
    } catch {
      res.locals.idempotencyRelease = true;
      res.status(503).json({ error: { code: "plan_unreadable", message: "Zavi could not check your plan just now. Try again in a minute." } });
      return;
    }
    if (!tier.allowed || tier.unverified) {
      res.locals.idempotencyRelease = true;
      if (tier.unverified) {
        res.status(503).json({ error: { code: "plan_unreadable", message: "Zavi could not check your plan just now. Try again in a minute." } });
        return;
      }
      res.status(403).json(planUpgradeErrorBody(PASTE_CHANNEL, tier.required_tier));
      return;
    }
    if (await lockCheck(PASTE_CHANNEL)) {
      res.locals.idempotencyRelease = true;
      res.status(409).json({ error: { code: "coming_soon", message: "Email campaigns is not available right now." } });
      return;
    }
    let out: Awaited<ReturnType<typeof filePastedEmail>>;
    try {
      out = await filePastedEmail(auth.tenant_id, body.data.inputs, deps);
    } catch (e) {
      console.warn(`[email-cards/paste] ${(e as Error).message}`);
      res.status(500).json({ error: { code: "paste_failed", message: "Zavi could not file this email just now. Check Email campaigns before trying again." } });
      return;
    }
    if (!out.ok) {
      if (!out.wrote) res.locals.idempotencyRelease = true;
      res.status(statusOf(out.code)).json({ error: { code: out.code, message: out.message } });
      return;
    }
    res.json({ ok: true, card: out.card, link: out.link, route: out.route, versions: out.versions });
  };
}

export const postEmailPasteHandler = makePostEmailPasteHandler();
