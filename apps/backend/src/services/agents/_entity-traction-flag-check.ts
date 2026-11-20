
import { serviceClient } from "@/services/supabase";
import {
  entityTractionGuardMode,
  type EntityTractionGuardMode,
} from "./entity-traction-grounding-verifier";

type Sb = ReturnType<typeof serviceClient>;

const TTL_MS = 30_000;
let cache: { mode: EntityTractionGuardMode; at: number } | null = null;

export function __resetEntityTractionFlagCache(): void {
  cache = null;
}

function coerceMode(raw: unknown): EntityTractionGuardMode | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return v === "off" || v === "shadow" || v === "hedge" ? v : null;
}

export async function resolveEntityTractionMode(
  sb?: Sb,
  now: number = Date.now(),
): Promise<EntityTractionGuardMode> {
  if (cache && now - cache.at < TTL_MS) return cache.mode;

  let mode: EntityTractionGuardMode = entityTractionGuardMode();

  try {
    const client = sb ?? serviceClient();
    const { data, error } = await client
      .from("system_config")
      .select("blob")
      .eq("id", 1)
      .maybeSingle<{ blob: Record<string, unknown> }>();
    if (!error) {
      const dbMode = coerceMode((data?.blob ?? {}).entity_traction_guard_mode);
      if (dbMode) mode = dbMode;
    }
  } catch {
  }

  cache = { mode, at: now };
  return mode;
}
