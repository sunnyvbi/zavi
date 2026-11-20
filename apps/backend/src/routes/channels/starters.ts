import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { startChannelRun } from "./run";
import { isChannelLockedStrict } from "@/services/channels/lock";
import { checkAgentTier } from "@/services/agents/entitlement";
import { isGenerativeVideoEnabled } from "@/services/agents/_render-launch-video-flag-check";
import { isMediaRouterEnabled } from "@/services/media-router/router";
import { assertCanMakeVideo, LOCK_UNKNOWN_REPLY, StudioError, type VideoGateDeps } from "@/services/video-studio/studio";

export const STARTER_CHANNEL = "generated_video";
export const STARTER_REQUEST_PREFIX = "ai-ugc-starters-";
export const STARTER_FAILED_STATUSES = ["failed", "parse_failed", "cancelled", "error", "dispatch_error"];

export const STARTER_CLAIM_GRACE_MS = 5 * 60_000;
export const STARTER_QUEUED_STALE_MS = 20 * 60_000;

export type StarterAttempt = {
  request_id: string;
  run_id: string | null;
  status: string | null;
  claimed_at?: string | null;
  queued_at?: string | null;
  cards?: number | null;
  unverified?: boolean;
};

export function starterAttemptLive(a: StarterAttempt, now: number = Date.now()): boolean {
  if (a.status && STARTER_FAILED_STATUSES.includes(a.status)) return false;
  if (a.run_id && a.status === "queued" && a.queued_at) {
    const queued = Date.parse(a.queued_at);
    if (Number.isFinite(queued) && now - queued >= STARTER_QUEUED_STALE_MS) return false;
  }
  if (a.run_id) return !starterAttemptEmpty(a);
  if (a.unverified) return true;
  const at = a.claimed_at ? Date.parse(a.claimed_at) : NaN;
  return Number.isFinite(at) && now - at < STARTER_CLAIM_GRACE_MS;
}

export function starterAttemptEmpty(a: StarterAttempt): boolean {
  return a.run_id !== null && a.status === "success" && a.cards === 0;
}

export async function readStarterAttempts(tenantId: string): Promise<StarterAttempt[]> {
  const db = tenantClient(asTenantId(tenantId));
  const { data, error } = await db
    .from("channel_run_claims")
    .select("request_id, run_id, claimed_at")
    .eq("channel_slug", STARTER_CHANNEL)
    .like("request_id", `${STARTER_REQUEST_PREFIX}%`)
    .order("claimed_at", { ascending: false });
  if (error) throw new Error(`starter claims read failed: ${error.message}`);
  const claims = (data ?? []) as Array<{ request_id: string; run_id: string | null; claimed_at: string | null }>;

  const recovered = new Map<string, string>();
  let unverified = false;
  const orphans = claims.filter((c) => c.run_id === null).map((c) => c.request_id);
  if (orphans.length > 0) {
    const found = await db
      .from("agent_runs")
      .select("id, starter_request:payload->>starter_request")
      .eq("trigger", "channel_recipe")
      .in("payload->>starter_request", orphans);
    if (found.error) unverified = true;
    else for (const r of (found.data ?? []) as Array<{ id: string; starter_request: string | null }>) if (r.starter_request) recovered.set(r.starter_request, r.id);
  }

  const resolved = claims.map((c) => ({ ...c, run_id: c.run_id ?? recovered.get(c.request_id) ?? null }));
  const runIds = resolved.map((c) => c.run_id).filter((id): id is string => typeof id === "string");
  const status = new Map<string, string>();
  const queuedAt = new Map<string, string>();
  if (runIds.length > 0) {
    const runs = await db.from("agent_runs").select("id, status, enqueued_at").in("id", runIds);
    if (runs.error) throw new Error(`starter runs read failed: ${runs.error.message}`);
    for (const r of (runs.data ?? []) as Array<{ id: string; status: string; enqueued_at: string | null }>) {
      status.set(r.id, r.status);
      if (r.enqueued_at) queuedAt.set(r.id, r.enqueued_at);
    }
  }

  const finished = runIds.filter((id) => status.get(id) === "success");
  const cards = new Map<string, number>();
  let cardsKnown = finished.length === 0;
  if (finished.length > 0) {
    const read = await db
      .from("channel_actions")
      .select("run_id")
      .in("run_id", finished)
      .like("exec_class", "generated_video.render.v1%");
    if (!read.error) {
      cardsKnown = true;
      for (const id of finished) cards.set(id, 0);
      for (const r of (read.data ?? []) as Array<{ run_id: string }>) cards.set(r.run_id, (cards.get(r.run_id) ?? 0) + 1);
    }
  }

  return resolved.map((c) => ({
    request_id: c.request_id,
    run_id: c.run_id,
    status: c.run_id ? status.get(c.run_id) ?? null : null,
    claimed_at: c.claimed_at,
    queued_at: c.run_id ? queuedAt.get(c.run_id) ?? null : null,
    cards: c.run_id && cardsKnown ? cards.get(c.run_id) ?? null : null,
    unverified: c.run_id === null && unverified,
  }));
}

export function nextStarterRequest(
  attempts: StarterAttempt[],
  now: number = Date.now(),
): { reuse: StarterAttempt | null; request_id: string } {
  const latest = attempts[0] ?? null;
  if (latest && latest.status !== "success" && starterAttemptLive(latest, now)) {
    return { reuse: latest, request_id: latest.request_id };
  }
  const highest = attempts.reduce((m, a) => {
    const n = Number(a.request_id.slice(STARTER_REQUEST_PREFIX.length));
    return Number.isInteger(n) && n > m ? n : m;
  }, 0);
  return { reuse: null, request_id: `${STARTER_REQUEST_PREFIX}${Math.max(highest, attempts.length) + 1}` };
}

export async function readFirstStarterClaim(tenantId: string): Promise<{ used: boolean | null; actionId: string | null }> {
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("starter_autostart_claims").select("action_id").limit(1);
  if (error) return { used: null, actionId: null };
  const rows = (data ?? []) as Array<{ action_id?: unknown }>;
  const id = rows[0]?.action_id;
  return { used: rows.length > 0, actionId: typeof id === "string" ? id : null };
}

export async function startersRead(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const [attempts, firstVideo] = await Promise.all([readStarterAttempts(auth.tenant_id), readFirstStarterClaim(auth.tenant_id)]);
    const now = Date.now();
    const live = attempts.find((a) => starterAttemptLive(a, now)) ?? null;
    const sinceLive = attempts.findIndex((a) => starterAttemptLive(a, now));
    res.json({
      run_id: live?.run_id ?? null,
      started: live !== null,
      run_status: live?.status ?? null,
      failed_attempts: sinceLive === -1 ? attempts.length : sinceLive,
      last_empty: attempts[0] !== undefined && starterAttemptEmpty(attempts[0]),
      first_video_used: firstVideo.used,
      first_video_action_id: firstVideo.actionId,
    });
  } catch (e) {
    console.warn(`[channels/starters] read: ${(e as Error).message}`);
    res.status(503).json({ error: { code: "starters_unavailable", message: "Zavi could not read your starter videos just now. Try again." } });
  }
}

const STARTER_GATE: VideoGateDeps = {
  tier: (t) => checkAgentTier(t, STARTER_CHANNEL),
  videoEnabled: (t) => isGenerativeVideoEnabled(t).catch(() => true),
  routerEnabled: () => isMediaRouterEnabled().catch(() => true),
  channelLocked: () => isChannelLockedStrict(STARTER_CHANNEL).catch(() => true),
};

export async function startersStart(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." } });
    return;
  }
  try {
    await assertCanMakeVideo(STARTER_GATE, auth.tenant_id);
  } catch (e) {
    if (e instanceof StudioError) res.status(e.status).json({ error: { code: e.code, message: e.message, ...e.extra } });
    else res.status(503).json({ error: { code: "video_unavailable", message: LOCK_UNKNOWN_REPLY } });
    return;
  }
  let request_id: string;
  try {
    request_id = nextStarterRequest(await readStarterAttempts(auth.tenant_id)).request_id;
  } catch (e) {
    console.warn(`[channels/starters] start: ${(e as Error).message}`);
    res.status(503).json({ error: { code: "starters_unavailable", message: "Zavi could not start your starter videos just now. Try again." } });
    return;
  }
  await startChannelRun(res, auth, STARTER_CHANNEL, {
    requestId: request_id,
    extra: { starter_by: auth.user_id, starter_request: request_id },
  });
}
