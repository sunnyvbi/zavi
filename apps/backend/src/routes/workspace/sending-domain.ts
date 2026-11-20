
import type { Request, Response } from "express";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { loadTenantRole, requireTenantRole } from "@/services/auth/tenant-role";
import { BulkEmailError } from "@/services/comms/bulk-outbound/errors";
import { bulkSendgridKey } from "@/services/comms/bulk-outbound/config";
import { readEmailSettingText, readPostalAddress } from "@/services/comms/bulk-outbound/readiness";
import {
  addSendingDomain,
  getSendingDomain,
  removeSendingDomain,
  verifySendingDomain,
} from "@/services/comms/bulk-outbound/sending-domain";

const WRITE_ROLES = ["owner", "admin"] as const;

function fail(res: Response, e: unknown): void {
  if (e instanceof BulkEmailError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  console.error(`[sending-domain] unexpected ${(e as Error)?.name ?? "error"}`);
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
    res.status(500).json({ error: { code: "role_check_failed", message: "Something went wrong. Try again." } });
    return null;
  }
}

export async function getSendingDomainHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const role = await loadTenantRole(auth).catch(() => null);
    const canManage = role === "owner" || role === "admin";
    if (canManage && auth.tenant_overridden !== true) {
      await removeSendingDomain({ tenantId: auth.tenant_id, userId: auth.user_id, onlyIfStale: true }).catch(() => undefined);
    }
    const [domain, typed, postal] = await Promise.all([
      getSendingDomain(auth.tenant_id),
      readEmailSettingText(auth.tenant_id, "sending_domain").catch(() => null),
      readPostalAddress(auth.tenant_id).catch(() => null),
    ]);
    res.json({
      domain,
      suggested_domain: domain ? null : typed,
      can_manage: canManage,
      bulk_email_ready: bulkSendgridKey() !== null,
      postal_address_set: !!postal,
    });
  } catch (e) {
    fail(res, e);
  }
}

export async function addSendingDomainHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireWriter(req, res);
  if (!auth) return;
  try {
    const domain = (req.body as { domain?: unknown } | undefined)?.domain;
    res.json({ domain: await addSendingDomain({ tenantId: auth.tenant_id, userId: auth.user_id, domain }) });
  } catch (e) {
    fail(res, e);
  }
}

export async function verifySendingDomainHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireWriter(req, res);
  if (!auth) return;
  try {
    res.json({ domain: await verifySendingDomain({ tenantId: auth.tenant_id }) });
  } catch (e) {
    fail(res, e);
  }
}

export async function deleteSendingDomainHandler(req: Request, res: Response): Promise<void> {
  const auth = await requireWriter(req, res);
  if (!auth) return;
  try {
    res.json(await removeSendingDomain({ tenantId: auth.tenant_id, userId: auth.user_id }));
  } catch (e) {
    fail(res, e);
  }
}
