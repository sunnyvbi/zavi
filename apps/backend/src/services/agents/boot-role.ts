import { processRole, servesInngest } from "@/services/config/process-role";
import { isLocalInngest } from "@/services/config/inngest-event-only";
import { isStaging } from "@/services/config/env-targets";

export function shouldRunBootReap(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PRAXIS_CONTAINER_ROLE === "canonical";
}

export function workerId(env: NodeJS.ProcessEnv = process.env): string {
  const role = env.PRAXIS_CONTAINER_ROLE;
  if (role === "canonical") {
    const split = (env.PRAXIS_ROLE ?? "").trim();
    return split === "api" || split === "worker" ? `canonical:${split}` : "canonical";
  }
  if (role === "probe") return "probe";
  const host = (env.HOSTNAME || env.HOST || "unknown")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 40);
  return `dev:${host}`;
}

export function shouldDrainSharedQueue(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.PRAXIS_CONTAINER_ROLE === "canonical" ||
    env.PRAXIS_DRAIN_SHARED_QUEUE === "1"
  );
}

export function isCanonicalContainer(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PRAXIS_CONTAINER_ROLE === "canonical";
}

export function isProbeContainer(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PRAXIS_CONTAINER_ROLE === "probe";
}

export function inngestSyncAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCanonicalContainer(env) || isLocalInngest(env);
}

export function isCanonicalWorkerId(id: string | null | undefined): boolean {
  return id === "canonical" || (typeof id === "string" && id.startsWith("canonical:"));
}

export type BootPlan = {
  servesInngest: boolean;
  bootReap: boolean;
  bootReapOwnRunsOnly: boolean;
  inngestSelfSync: boolean;
  inngestWatchdog: boolean;
  discordGateway: boolean;
  platformWorkerSecrets: boolean;
};

export function bootPlan(env: NodeJS.ProcessEnv = process.env): BootPlan {
  const role = processRole(env);
  const canonical = isCanonicalContainer(env);
  const background = servesInngest(role);
  return {
    servesInngest: background,
    bootReap: shouldRunBootReap(env) && background,
    bootReapOwnRunsOnly: role === "worker",
    inngestSelfSync: canonical && background,
    inngestWatchdog: canonical && role !== "worker" && !isStaging(env),
    discordGateway: canonical && background,
    platformWorkerSecrets: canonical && role !== "worker",
  };
}
