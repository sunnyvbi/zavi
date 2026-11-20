
import { PRICING } from "@/services/anthropic";
import { OPENAI_PRICING } from "@/services/openai";
import { getSetting } from "@/services/settings";
import type { Provider, Role } from "@/services/llm/models";

export async function resolveRoleModel(
  role: string,
  defaultModel: string,
  tenant_id?: string | null,
): Promise<string> {
  let overrides: Record<string, unknown> | null | undefined;
  try {
    overrides = (await getSetting("llm_role_model_overrides", tenant_id)) as
      | Record<string, unknown>
      | null
      | undefined;
  } catch (err) {
    console.warn(
      `[resolveRoleModel] settings read failed for role '${role}': ${(err as Error).message}; using ${defaultModel}`,
    );
    return defaultModel;
  }

  const picked = overrides?.[role];
  if (picked === undefined || picked === null) return defaultModel;
  if (typeof picked === "string" && Object.prototype.hasOwnProperty.call(PRICING, picked)) {
    return picked;
  }

  console.warn(
    `[resolveRoleModel] override for role '${role}' is not a known model id: ${JSON.stringify(picked)}; using ${defaultModel}`,
  );
  return defaultModel;
}

function isKnownModelId(id: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(PRICING, id) ||
    Object.prototype.hasOwnProperty.call(OPENAI_PRICING, id)
  );
}

export async function getModel(
  provider: Provider,
  role: Role | string,
  defaultModel: string,
  tenant_id?: string | null,
): Promise<string> {
  void provider;

  let overrides: Record<string, unknown> | null | undefined;
  try {
    overrides = (await getSetting("llm_role_model_overrides", tenant_id)) as
      | Record<string, unknown>
      | null
      | undefined;
  } catch (err) {
    console.warn(
      `[getModel] settings read failed for role '${role}': ${(err as Error).message}; using ${defaultModel}`,
    );
    return defaultModel;
  }

  const picked = overrides?.[role];
  if (picked === undefined || picked === null) return defaultModel;
  if (typeof picked === "string" && isKnownModelId(picked)) {
    return picked;
  }

  console.warn(
    `[getModel] override for role '${role}' is not a known model id: ${JSON.stringify(picked)}; using ${defaultModel}`,
  );
  return defaultModel;
}
