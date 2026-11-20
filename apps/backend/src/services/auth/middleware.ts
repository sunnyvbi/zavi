
import type { NextFunction, Request, Response } from "express";
import { SignInCheckUnavailableError, verifyBearer } from "./jwt";
import { serverClientFromBearer } from "@/services/supabase";
import { isConnectorAdminWrite, sendConnectorAdminOnly, sendViewerReadOnly, viewerMayCall } from "./viewer";
import { getCachedTenant, setCachedTenant } from "./tenant-cache";
import {
  getSessionTenant,
  setSessionTenant,
} from "@/services/tenants/session-tenant";
import { asTenantId, type TenantId } from "@/services/tenant-client";
import {
  readTenantDisabled,
  TENANT_DISABLED_CODE,
  TENANT_DISABLED_MESSAGE,
} from "@/services/tenants/disabled";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AuthedRequest = {
  user_id: string;
  email: string | null;
  tenant_id: TenantId;
  access_token: string;
  tenant_overridden?: boolean;
};

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthedRequest;
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) {
    return;
  }
  if (!req.auth) req.auth = auth;
  next();
}

export async function requireAuth(
  req: Request,
  res: Response,
): Promise<AuthedRequest | null> {
  if (req.auth && req.auth.user_id && req.auth.tenant_id && req.auth.access_token) {
    return req.auth;
  }
  const auth = await resolveAuth(req, res);
  if (!auth) return null;
  if (!(await enforceRoleWriteRules(req, res, auth))) {
    req.auth = undefined;
    return null;
  }
  return auth;
}

async function enforceRoleWriteRules(
  req: Request,
  res: Response,
  auth: AuthedRequest,
): Promise<boolean> {
  const path = String(req.originalUrl ?? req.url ?? "").split("?")[0];
  if (viewerMayCall(req.method, path)) return true;
  let role: string | null;
  try {
    const { data, error } = await serverClientFromBearer(auth.access_token)
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", auth.tenant_id)
      .eq("user_id", auth.user_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    role = (data as { role?: string } | null)?.role ?? null;
  } catch (e) {
    res.status(500).json({ error: { code: "auth_db_error", message: (e as Error).message } });
    return false;
  }
  if (role === "viewer") {
    sendViewerReadOnly(res);
    return false;
  }
  if (isConnectorAdminWrite(req.method, path) && role !== "owner" && role !== "admin") {
    sendConnectorAdminOnly(res);
    return false;
  }
  return true;
}

async function refuseIfTenantDisabled(res: Response, tenantId: string): Promise<boolean> {
  const disabled = await readTenantDisabled(tenantId);
  if (disabled === false) return false;
  if (disabled === null) {
    res.status(503).json({
      error: { code: "tenant_status_unavailable", message: "Couldn't check your workspace. Try again in a moment." },
    });
    return true;
  }
  res.status(403).json({
    error: { code: TENANT_DISABLED_CODE, message: TENANT_DISABLED_MESSAGE },
  });
  return true;
}

async function resolveAuth(
  req: Request,
  res: Response,
): Promise<AuthedRequest | null> {
  let verified: Awaited<ReturnType<typeof verifyBearer>>;
  try {
    verified = await verifyBearer(req, { throwWhenUnavailable: true });
  } catch (e) {
    if (!(e instanceof SignInCheckUnavailableError)) throw e;
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: { code: "auth_unavailable", message: "Zavi can't check your sign-in right now. Try again in a moment." },
    });
    return null;
  }
  if (!verified) {
    res.status(401).json({
      error: { code: "unauthenticated", message: "Missing or invalid Bearer token." },
    });
    return null;
  }

  const rawEvalTenant = req.headers?.["x-eval-tenant"];
  const evalTenantHeader = (Array.isArray(rawEvalTenant) ? rawEvalTenant[0] : rawEvalTenant)?.trim();
  if (evalTenantHeader) {
    if (!UUID_RE.test(evalTenantHeader)) {
      res.status(400).json({
        error: { code: "bad_eval_tenant", message: "X-Eval-Tenant must be a UUID." },
      });
      return null;
    }
    const ovClient = serverClientFromBearer(verified.access_token);
    const { data: ovMem, error: ovErr } = await ovClient
      .from("tenant_users")
      .select("tenant_id")
      .eq("tenant_id", evalTenantHeader)
      .eq("user_id", verified.user_id)
      .maybeSingle();
    if (ovErr) {
      res.status(500).json({ error: { code: "auth_db_error", message: ovErr.message } });
      return null;
    }
    if (!ovMem) {
      res.status(403).json({
        error: {
          code: "eval_tenant_not_a_member",
          message: "Not a member of the requested X-Eval-Tenant.",
        },
      });
      return null;
    }
    if (await refuseIfTenantDisabled(res, evalTenantHeader)) return null;
    const auth: AuthedRequest = {
      user_id: verified.user_id,
      email: verified.email ?? null,
      tenant_id: asTenantId(evalTenantHeader),
      access_token: verified.access_token,
      tenant_overridden: true,
    };
    req.auth = auth;
    return auth;
  }

  const cachedTenant = getCachedTenant(verified.user_id, verified.session_id);
  if (cachedTenant) {
    if (await refuseIfTenantDisabled(res, cachedTenant)) return null;
    const auth: AuthedRequest = {
      user_id: verified.user_id,
      email: verified.email ?? null,
      tenant_id: asTenantId(cachedTenant),
      access_token: verified.access_token,
    };
    req.auth = auth;
    return auth;
  }

  const supabase = serverClientFromBearer(verified.access_token);

  let tenantId: string | null = null;
  let pinnedThisSession = false;
  if (verified.session_id) {
    tenantId = await getSessionTenant(verified.session_id);
    pinnedThisSession = tenantId !== null;
  }

  if (!tenantId) {
    tenantId = verified.claim_tenant_id;
  }

  if (!tenantId) {
    const { data: prof, error: pErr } = await supabase
      .from("profiles")
      .select("active_tenant_id")
      .eq("user_id", verified.user_id)
      .maybeSingle();

    if (pErr) {
      res.status(500).json({
        error: { code: "auth_db_error", message: pErr.message },
      });
      return null;
    }
    tenantId = (prof?.active_tenant_id as string | undefined) ?? null;
  }

  if (!tenantId) {
    res.status(403).json({
      error: {
        code: "no_active_tenant",
        message: "Complete onboarding first (no active tenant for this user).",
      },
    });
    return null;
  }

  const { data: mem, error: mErr } = await supabase
    .from("tenant_users")
    .select("tenant_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", verified.user_id)
    .maybeSingle();

  if (mErr) {
    res.status(500).json({
      error: { code: "auth_db_error", message: mErr.message },
    });
    return null;
  }

  if (!mem) {
    res.status(403).json({
      error: {
        code: "membership_revoked",
        message: "Active tenant is no longer a valid membership. Switch tenants or re-onboard.",
      },
    });
    return null;
  }

  if (await refuseIfTenantDisabled(res, tenantId)) return null;

  if (verified.session_id && !pinnedThisSession) {
    try {
      await setSessionTenant(verified.session_id, verified.user_id, tenantId);
    } catch (e) {
      console.warn(
        `[auth] session self-pin failed for ${verified.session_id}: ${(e as Error).message}`,
      );
    }
  }

  setCachedTenant(verified.user_id, verified.session_id, tenantId);

  const auth: AuthedRequest = {
    user_id: verified.user_id,
    email: verified.email ?? null,
    tenant_id: asTenantId(tenantId),
    access_token: verified.access_token,
  };
  req.auth = auth;
  return auth;
}
