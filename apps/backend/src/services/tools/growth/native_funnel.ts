
import { serviceClient } from "@/services/supabase";

export const DEFAULT_FUNNEL_STEPS = [
  "signup",
  "activation",
  "key_action",
  "purchase",
] as const;

export type NativeFunnelStep = {
  event: string;
  count: number;
  conversion_from_top: number | null;
};

export type NativeFunnel = {
  has_data: boolean;
  tenant_id: string;
  window: string;
  total_events_in_window?: number;
  steps: NativeFunnelStep[];
};

export async function readNativeFunnel(
  tenant_id: string,
  steps: readonly string[] = DEFAULT_FUNNEL_STEPS,
  windowDays = 30,
): Promise<NativeFunnel> {
  const sc = serviceClient();
  const { data, error } = await sc.rpc("get_native_funnel", {
    p_tenant_id: tenant_id,
    p_steps: steps as string[],
    p_window: `${windowDays} days`,
  });

  if (error) {
    return { has_data: false, tenant_id, window: `${windowDays} days`, steps: [] };
  }

  const f = (data ?? {}) as Partial<NativeFunnel>;
  return {
    has_data: Boolean(f.has_data),
    tenant_id: f.tenant_id ?? tenant_id,
    window: f.window ?? `${windowDays} days`,
    total_events_in_window: f.total_events_in_window,
    steps: Array.isArray(f.steps) ? f.steps : [],
  };
}
