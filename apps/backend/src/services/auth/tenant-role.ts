
import type { Response } from "express";
import { serviceClient } from "@/services/supabase";
import type { AuthedRequest } from "./middleware";

export type TenantRole = string;

export async function loadTenantRoleFor(
  user_id: string,
  tenant_id: string,
): Promise<TenantRole | null> {
  const { data, error } = await serviceClient()
    .from("tenant_users")
    .select("role")
    .eq("user_id", user_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error) throw new Error(`tenant_users role read failed: ${error.message}`);
  return (data as { role?: string | null } | null)?.role ?? null;
}

export async function loadTenantRole(auth: AuthedRequest): Promise<TenantRole | null> {
  return loadTenantRoleFor(auth.user_id, auth.tenant_id);
}

export async function requireTenantRole(
  auth: AuthedRequest,
  allowed: readonly TenantRole[],
  res: Response,
  deniedMessage?: string,
): Promise<boolean> {
  const role = await loadTenantRole(auth);
  if (!role || !allowed.includes(role)) {
    res.status(403).json({
      error: {
        code: "forbidden",
        message: deniedMessage ?? `This action requires one of: ${allowed.join(", ")}. Your role: ${role ?? "none"}.`,
      },
    });
    return false;
  }
  return true;
}
