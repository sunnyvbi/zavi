
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import {
  EXTENSION_CONSENT_VERSION,
  grantExtensionConsent,
  readExtensionConsent,
  revokeExtensionConsent,
} from "@/services/extension/consent";

export async function getExtensionConsent(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const consent = await readExtensionConsent(auth.tenant_id, auth.user_id);
  res.json({
    consent,
    consent_required: !consent.granted,
    current_version: EXTENSION_CONSENT_VERSION,
  });
}

export async function postExtensionConsent(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const consent = await grantExtensionConsent(auth.tenant_id, auth.user_id);
    res.json({ consent, consent_required: !consent.granted });
  } catch (e) {
    res.status(500).json({
      error: { code: "write_failed", message: (e as Error).message },
    });
  }
}

export async function deleteExtensionConsent(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const { state, runs_cleared } = await revokeExtensionConsent(
      auth.tenant_id,
      auth.user_id,
    );
    res.json({ consent: state, consent_required: true, runs_cleared });
  } catch (e) {
    res.status(500).json({
      error: { code: "revoke_failed", message: (e as Error).message },
    });
  }
}
