
import { randomUUID } from "node:crypto";
import { serverClientFromBearer, serviceClient } from "@/services/supabase";
import {
  ActivateTenantPackResultSchema,
  type ActivateTenantPackResult,
} from "./types";

export type ActivateOptions = {
  accessToken: string | null;
  idempotencyKey?: string;
};

export async function activateTenantPack(
  tenant_id: string,
  pack_id: string,
  opts: ActivateOptions,
): Promise<ActivateTenantPackResult> {
  const idempotencyKey = opts.idempotencyKey ?? randomUUID();
  const sb = opts.accessToken
    ? serverClientFromBearer(opts.accessToken)
    : serviceClient();

  const { data, error } = await sb.rpc("activate_tenant_pack", {
    p_tenant_id: tenant_id,
    p_pack_id: pack_id,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    throw new Error(`activate_tenant_pack failed: ${error.message}`);
  }

  const result = ActivateTenantPackResultSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `activate_tenant_pack returned unexpected shape: ${JSON.stringify(data)}`,
    );
  }
  return result.data;
}
