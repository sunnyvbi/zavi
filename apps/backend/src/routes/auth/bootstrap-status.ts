
import type { Request, Response } from "express";
import { verifyBearer } from "@/services/auth/jwt";
import { serverClientFromBearer } from "@/services/supabase";

export async function authBootstrapStatus(req: Request, res: Response): Promise<void> {
  const verified = await verifyBearer(req);
  if (!verified) {
    res.status(401).json({
      error: { code: "unauthenticated", message: "Missing or invalid Bearer token." },
    });
    return;
  }

  const supabase = serverClientFromBearer(verified.access_token);
  const { data, error } = await supabase
    .from("tenant_provisioning")
    .select("status, tenant_id, failure_reason, updated_at")
    .eq("user_id", verified.user_id)
    .maybeSingle();

  if (error) {
    res.status(500).json({
      error: { code: "db_error", message: error.message },
    });
    return;
  }

  if (!data) {
    res.json({ status: "pending", tenant_id: null });
    return;
  }

  res.json({
    status: (data as { status: string }).status,
    tenant_id: (data as { tenant_id: string | null }).tenant_id ?? null,
    failure_reason: (data as { failure_reason: string | null }).failure_reason ?? null,
    updated_at: (data as { updated_at: string }).updated_at,
  });
}
