
import { Router, type Request, type Response } from "express";
import { forwardAsyncErrors } from "@/services/http/async-errors";
import { z } from "zod";

import { verifyBearer } from "@/services/auth/jwt";
import { serverClientFromBearer } from "@/services/supabase";
import { syncActiveTenantStrict } from "@/services/tenants/active-tenant";
import { setSessionTenant } from "@/services/tenants/session-tenant";

function unauthorized(res: Response): void {
  res.status(401).json({
    error: { code: "unauthorized", message: "Missing or invalid Bearer token." },
  });
}

const switchBody = z.object({
  tenant_id: z.string().uuid(),
});

type TenantMembership = {
  tenant_id: string;
  slug: string;
  display_name: string;
  role: string;
  website: string | null;
};

function marketingUrl(productUrl: unknown): string | null {
  if (!productUrl || typeof productUrl !== "object") return null;
  const marketing = (productUrl as { marketing?: unknown }).marketing;
  return typeof marketing === "string" && marketing.trim() ? marketing : null;
}

async function listMineHandler(req: Request, res: Response): Promise<void> {
  const verified = await verifyBearer(req);
  if (!verified) {
    unauthorized(res);
    return;
  }

  const userClient = serverClientFromBearer(verified.access_token);
  const { data, error } = await userClient
    .from("tenant_users")
    .select("tenant_id, role, tenants:tenant_id (id, slug, display_name, product_url)")
    .eq("user_id", verified.user_id);
  if (error) {
    res.status(500).json({
      error: { code: "list_failed", message: error.message },
    });
    return;
  }

  type Row = {
    tenant_id: string;
    role: string;
    tenants:
      | { id: string; slug: string; display_name: string | null; product_url: unknown }
      | Array<{ id: string; slug: string; display_name: string | null; product_url: unknown }>
      | null;
  };

  const tenants: TenantMembership[] = [];
  for (const r of (data ?? []) as Row[]) {
    const t = Array.isArray(r.tenants) ? r.tenants[0] : r.tenants;
    if (!t) continue;
    tenants.push({
      tenant_id: r.tenant_id,
      slug: t.slug,
      display_name: t.display_name ?? t.slug,
      role: r.role,
      website: marketingUrl(t.product_url),
    });
  }

  res.json({ tenants });
}

async function switchHandler(req: Request, res: Response): Promise<void> {
  const verified = await verifyBearer(req);
  if (!verified) {
    unauthorized(res);
    return;
  }

  const parsed = switchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
    return;
  }
  const tenantId = parsed.data.tenant_id;

  const userClient = serverClientFromBearer(verified.access_token);
  const { data: membership, error: memErr } = await userClient
    .from("tenant_users")
    .select("tenant_id")
    .eq("user_id", verified.user_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (memErr) {
    res.status(500).json({
      error: { code: "switch_failed", message: memErr.message },
    });
    return;
  }
  if (!membership) {
    res.status(403).json({
      error: { code: "not_a_member", message: "Not a member of that tenant." },
    });
    return;
  }

  try {
    await syncActiveTenantStrict(verified.user_id, tenantId);
  } catch (e) {
    res.status(500).json({
      error: { code: "switch_failed", message: (e as Error).message },
    });
    return;
  }

  if (verified.session_id) {
    try {
      await setSessionTenant(verified.session_id, verified.user_id, tenantId);
    } catch (e) {
      res.status(500).json({
        error: { code: "switch_failed", message: (e as Error).message },
      });
      return;
    }
  }

  res.status(200).json({ ok: true });
}

export function tenantsRouter(): Router {
  const r = forwardAsyncErrors(Router());
  r.get("/mine", listMineHandler);
  r.post("/switch", switchHandler);
  return r;
}
