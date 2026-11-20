
import { getNumberSetting } from "@/services/settings";
import { countJobsSince, tickAttemptBucket } from "./store";

export function localMetersBypassed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LAUNCH_VIDEO_PUBLIC_LOCAL_UNMETERED === "1";
}

export type CapLimits = { perIpDay: number; globalDay: number };
export type CapCounts = { ip: number; global: number };
export type CapDecision = { allowed: true } | { allowed: false; reason: string; axis: keyof CapCounts };

export function evaluateCaps(counts: CapCounts, limits: CapLimits): CapDecision {
  if (limits.globalDay > 0 && counts.global >= limits.globalDay)
    return { allowed: false, axis: "global", reason: "daily_global_cap" };
  if (limits.perIpDay > 0 && counts.ip >= limits.perIpDay)
    return { allowed: false, axis: "ip", reason: "daily_ip_cap" };
  return { allowed: true };
}

export function utcDayStartIso(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString();
}

async function resolveLimits(): Promise<CapLimits> {
  const [perIpDay, globalDay] = await Promise.all([
    getNumberSetting("launch_video_public_cap_per_ip_day"),
    getNumberSetting("launch_video_public_cap_global_day"),
  ]);
  return { perIpDay, globalDay };
}

export async function checkCaps(input: { ip_hash: string | null }): Promise<CapDecision> {
  const unmetered = localMetersBypassed();
  if (unmetered) {
    console.warn("[launch-video] LOCAL UNMETERED: per-IP render cap bypassed, GLOBAL daily ceiling still enforced");
  }
  const resolved = await resolveLimits();
  const limits = unmetered ? { ...resolved, perIpDay: 0 } : resolved;
  const since = utcDayStartIso();
  const [ip, global] = await Promise.all([
    input.ip_hash ? countJobsSince({ ip_hash: input.ip_hash }, since) : Promise.resolve(0),
    countJobsSince({}, since),
  ]);
  return evaluateCaps({ ip, global }, limits);
}

const ATTEMPT_WINDOW_SECONDS = 24 * 60 * 60;

export type AttemptDecision =
  | { allowed: true }
  | { allowed: false; reason: "cap"; axis: "ip" | "global" }
  | { allowed: false; reason: "error" | "no_ip" };

async function tickAttempt(key: string, limit: number): Promise<boolean> {
  if (limit <= 0) return true;
  return tickAttemptBucket(key, limit, ATTEMPT_WINDOW_SECONDS);
}

export async function checkAttemptCap(input: { ip_hash: string | null }): Promise<AttemptDecision> {
  const unmetered = localMetersBypassed();
  if (unmetered) {
    console.warn("[launch-video] LOCAL UNMETERED: per-IP attempt meter bypassed, global meter still enforced");
  }
  if (!input.ip_hash) return { allowed: false, reason: "no_ip" };
  try {
    const [globalLimit, ipLimit] = await Promise.all([
      getNumberSetting("launch_video_public_attempts_global_day"),
      getNumberSetting("launch_video_public_attempts_per_ip_day"),
    ]);
    if (!unmetered && !(await tickAttempt(`lvp_attempt:ip:${input.ip_hash}`, ipLimit)))
      return { allowed: false, reason: "cap", axis: "ip" };
    if (!(await tickAttempt("lvp_attempt:global", globalLimit)))
      return { allowed: false, reason: "cap", axis: "global" };
    return { allowed: true };
  } catch (e) {
    console.error(`[launch-video] attempt-meter RPC failed, failing closed: ${(e as Error).message}`);
    return { allowed: false, reason: "error" };
  }
}
