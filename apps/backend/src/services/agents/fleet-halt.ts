
import { serviceClient } from "@/services/supabase";

export async function isFleetHalted(): Promise<boolean> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (error) return true;
    const blob = (data?.blob ?? {}) as Record<string, unknown>;
    return blob.fleet_halt === true;
  } catch {
    return true;
  }
}

export class FleetHaltedError extends Error {
  readonly code = "fleet_halted";
  constructor() {
    super(
      "fleet halt is active — all agent runs are globally stopped. Clear it via /api/admin/fleet-halt.",
    );
    this.name = "FleetHaltedError";
  }
}
