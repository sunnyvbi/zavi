
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { loadTenantRole, requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId } from "@/services/tenant-client";
import { getEmailTemplate, saveEmailTemplate } from "@/services/email-templates/store";
import { draftTemplateFromBrand, liveDraftTemplateDeps, type DraftTemplateDeps } from "@/services/email-templates/draft-from-brand";
import { FONT_KEYS } from "@/services/email-templates/render";

const WRITE_ROLES = ["owner", "admin"] as const;

function internal(res: Response, where: string): void {
  console.error(`[email-template] ${where} failed`);
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong. Try again." } });
}

async function requireWriter(req: Request, res: Response): Promise<AuthedRequest | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (auth.tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden workspace." } });
    return null;
  }
  try {
    return (await requireTenantRole(auth, WRITE_ROLES, res)) ? auth : null;
  } catch {
    internal(res, "role check");
    return null;
  }
}

export async function getEmailTemplateHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const [template, role] = await Promise.all([getEmailTemplate(asTenantId(auth.tenant_id)), loadTenantRole(auth).catch(() => null)]);
    res.json({ template, fonts: FONT_KEYS, can_edit: role === "owner" || role === "admin" });
  } catch {
    internal(res, "read");
  }
}

export async function putEmailTemplateHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireWriter(req, res);
  if (!auth) return;
  try {
    const template = await saveEmailTemplate(asTenantId(auth.tenant_id), auth.user_id, req.body);
    res.json({ template });
  } catch (e) {
    if (e instanceof ZodError) {
      res.status(400).json({ error: { code: "invalid_template", message: e.issues[0]?.message ?? "That template is not valid." } });
      return;
    }
    internal(res, "save");
  }
}

export function draftEmailTemplateWith(deps: DraftTemplateDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const auth = await requireWriter(req, res);
    if (!auth) return;
    try {
      res.json({ draft: await draftTemplateFromBrand(auth.tenant_id, deps) });
    } catch {
      internal(res, "draft");
    }
  };
}

export const draftEmailTemplateHandler = draftEmailTemplateWith(liveDraftTemplateDeps);
