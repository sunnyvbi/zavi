import { buildConductorRunIdOf } from "@/services/billing/tiers";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export const CONDUCTOR_TICK_REQUESTED = "conductor/tick.requested" as const;

export type TickRequester = {
  send: (event: {
    name: typeof CONDUCTOR_TICK_REQUESTED;
    data: { conductor_run_id: string };
  }) => Promise<unknown>;
};

export async function requestConductorTick(
  client: TickRequester,
  conductor_run_id: string,
): Promise<boolean> {
  try {
    await client.send({
      name: CONDUCTOR_TICK_REQUESTED,
      data: { conductor_run_id },
    });
    return true;
  } catch (e) {
    console.warn(
      `[conductor-kick] tick request failed for ${conductor_run_id}: ${(e as Error).message}`,
    );
    return false;
  }
}

const CONDUCTOR_RUN_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function targetedRunId(event: unknown): string | null {
  const data = (event as { data?: { conductor_run_id?: unknown } } | null)?.data;
  const id = data?.conductor_run_id;
  return typeof id === "string" && CONDUCTOR_RUN_ID_RE.test(id) ? id : null;
}

export const KICK_DEDUPE_WINDOW_MS = 30_000;

const recentKicks = new Map<string, number>();

export function resetConductorKickDedupe(): void {
  recentKicks.clear();
}

export async function requestConductorTickDeduped(
  client: TickRequester,
  conductor_run_id: string,
  now: number = Date.now(),
): Promise<boolean> {
  const last = recentKicks.get(conductor_run_id);
  if (last !== undefined && now - last < KICK_DEDUPE_WINDOW_MS) return false;
  for (const [id, at] of recentKicks) {
    if (now - at >= KICK_DEDUPE_WINDOW_MS) recentKicks.delete(id);
  }
  recentKicks.set(conductor_run_id, now);
  const ok = await requestConductorTick(client, conductor_run_id);
  if (!ok) recentKicks.delete(conductor_run_id);
  return ok;
}

type ActiveCheck = (conductor_run_id: string, tenant_id: string) => Promise<boolean>;

async function activeConductorOf(
  isActive: ActiveCheck,
  child_payload: unknown,
  tenant_id: string,
): Promise<string | null> {
  const conductor_run_id = buildConductorRunIdOf(child_payload);
  if (!conductor_run_id) return null;
  if (!tenant_id) return null;
  try {
    return (await isActive(conductor_run_id, tenant_id)) ? conductor_run_id : null;
  } catch (e) {
    console.warn(
      `[conductor-kick] conductor lookup failed for ${conductor_run_id}: ${(e as Error).message}`,
    );
    return null;
  }
}

export async function requestTickForFinishedChild(
  client: TickRequester,
  isActive: ActiveCheck,
  child_payload: unknown,
  tenant_id: string,
): Promise<boolean> {
  const conductor_run_id = await activeConductorOf(isActive, child_payload, tenant_id);
  if (!conductor_run_id) return false;
  return requestConductorTick(client, conductor_run_id);
}

export async function requestTickForLandedPush(
  client: TickRequester,
  isActive: ActiveCheck,
  run_payload: unknown,
  tenant_id: string,
): Promise<boolean> {
  try {
    const conductor_run_id = await activeConductorOf(isActive, run_payload, tenant_id);
    if (!conductor_run_id) return false;
    return await requestConductorTickDeduped(client, conductor_run_id);
  } catch (e) {
    console.warn(`[conductor-kick] landed-push kick failed: ${(e as Error).message}`);
    return false;
  }
}

export const MAX_TENANT_BUILD_KICKS = 3;

export async function listActiveBuildConductorRunIds(tenant_id: string): Promise<string[]> {
  if (!tenant_id) return [];
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("conductor_runs")
    .select("id")
    .eq("status", "active")
    .eq("kind", "build_app")
    .limit(MAX_TENANT_BUILD_KICKS);
  if (error) return [];
  return ((data ?? []) as Array<{ id?: unknown }>)
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string" && CONDUCTOR_RUN_ID_RE.test(id));
}

export async function requestTicksForTenantBuilds(
  client: TickRequester,
  tenant_id: string,
  listActive: (tenant_id: string) => Promise<string[]> = listActiveBuildConductorRunIds,
): Promise<number> {
  if (!tenant_id) return 0;
  let ids: string[] = [];
  try {
    ids = (await listActive(tenant_id)).slice(0, MAX_TENANT_BUILD_KICKS);
  } catch (e) {
    console.warn(
      `[conductor-kick] active build lookup failed for tenant ${tenant_id}: ${(e as Error).message}`,
    );
    return 0;
  }
  let sent = 0;
  for (const id of ids) {
    try {
      if (await requestConductorTickDeduped(client, id)) sent++;
    } catch {
      continue;
    }
  }
  return sent;
}

export async function isActiveConductorRun(
  conductor_run_id: string,
  tenant_id: string,
): Promise<boolean> {
  if (!tenant_id) return false;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("conductor_runs")
    .select("status")
    .eq("id", conductor_run_id)
    .maybeSingle();
  if (error) return false;
  return (data as { status?: string } | null)?.status === "active";
}

export const FOLLOW_UP_TICK_MIN_DELAY_MS = 60_000;
export const FOLLOW_UP_TICK_BUCKET_MS = 30_000;

export type FollowUpTickEvent = {
  id: string;
  name: typeof CONDUCTOR_TICK_REQUESTED;
  data: { conductor_run_id: string };
  ts: number;
};

export function needsFollowUpTick(result: { action: string; awaiting?: string }): boolean {
  const a = result.action;
  if (result.awaiting === "look") return false;
  return a !== "noop" && a !== "halted" && !a.startsWith("completed");
}

export function followUpTickEvent(
  conductor_run_id: string,
  now: number = Date.now(),
): FollowUpTickEvent {
  const bucket = Math.floor((now + FOLLOW_UP_TICK_MIN_DELAY_MS) / FOLLOW_UP_TICK_BUCKET_MS) + 1;
  const ts = bucket * FOLLOW_UP_TICK_BUCKET_MS;
  return {
    id: `conductor-follow-up-${conductor_run_id}-${ts}`,
    name: CONDUCTOR_TICK_REQUESTED,
    data: { conductor_run_id },
    ts,
  };
}

export const LOOK_AUTO_START_TICK_SLACK_MS = 1_000;

export function lookAutoStartTickEvent(
  conductor_run_id: string,
  auto_start_at: string | undefined,
  now: number = Date.now(),
): FollowUpTickEvent | null {
  const at = typeof auto_start_at === "string" ? Date.parse(auto_start_at) : NaN;
  if (!Number.isFinite(at) || at <= now) return null;
  const ts = at + LOOK_AUTO_START_TICK_SLACK_MS;
  return {
    id: `conductor-look-auto-${conductor_run_id}-${ts}`,
    name: CONDUCTOR_TICK_REQUESTED,
    data: { conductor_run_id },
    ts,
  };
}
