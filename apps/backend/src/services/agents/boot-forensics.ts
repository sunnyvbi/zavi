
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { workerId } from "@/services/agents/boot-role";

type Svc = ReturnType<typeof serviceClient>;

export const BOOT_STORM_DEFAULT_THRESHOLD = 3;
const BOOT_WINDOW_MS = 10 * 60 * 1000;

export function bootStormBreakerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.BOOT_STORM_BREAKER !== "0";
}

export function bootStormThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const n = parseInt(env.BOOT_STORM_THRESHOLD || "", 10);
  return Number.isFinite(n) && n >= 1 ? n : BOOT_STORM_DEFAULT_THRESHOLD;
}

export type BootForensics = {
  container_role: string;
  prev_shutdown_clean: boolean | null;
  boots_last_10m: number;
  storm: boolean;
};

export async function recordBootForensics(
  bootTsIso: string,
  svc: Svc = serviceClient(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootForensics> {
  const role = forensicRole(env);
  let prev_shutdown_clean: boolean | null = null;
  let boots_last_10m = 1;

  try {
    const { data, error } = await svc
      .from("praxis_logs")
      .select("code")
      .eq("source", "boot")
      .eq("meta->>container_role", role)
      .in("code", ["backend_boot", "backend_shutdown_sigterm"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (!error && data && data.length > 0) {
      prev_shutdown_clean =
        (data[0] as { code?: string }).code === "backend_shutdown_sigterm";
    }
  } catch {
  }

  try {
    const cutoff = new Date(
      new Date(bootTsIso).getTime() - BOOT_WINDOW_MS,
    ).toISOString();
    const { data, error } = await svc
      .from("praxis_logs")
      .select("id")
      .eq("source", "boot")
      .eq("code", "backend_boot")
      .eq("meta->>container_role", role)
      .gte("created_at", cutoff)
      .limit(50);
    if (!error && data) boots_last_10m = data.length + 1;
  } catch {
  }

  await logEvent({
    level: "info",
    source: "boot",
    code: "backend_boot",
    meta: {
      container_role: role,
      ...(prev_shutdown_clean === null
        ? {}
        : { prev_shutdown_clean: prev_shutdown_clean ? 1 : 0 }),
      boots_last_10m,
    },
  });

  const storm =
    bootStormBreakerEnabled(env) && boots_last_10m >= bootStormThreshold(env);
  if (storm) {
    await logEvent({
      level: "error",
      source: "boot",
      code: "backend_boot_storm",
      meta: { container_role: role, boots_last_10m },
    });
  }

  return { container_role: role, prev_shutdown_clean, boots_last_10m, storm };
}

export async function recordShutdownSigterm(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await logEvent({
    level: "info",
    source: "boot",
    code: "backend_shutdown_sigterm",
    meta: { container_role: forensicRole(env) },
  });
}

export function forensicRole(env: NodeJS.ProcessEnv = process.env): string {
  return env.PRAXIS_CONTAINER_ROLE === "canonical"
    ? workerId(env)
    : env.PRAXIS_CONTAINER_ROLE || "unknown";
}
