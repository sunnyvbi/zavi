
import { signOwnImageForVendor } from "@/services/chat-images/sign-own-image";
import { NonRetriableError } from "inngest";
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  generativeVideoIntakeSchema,
  narrowAspect,
  finishMode,
  type GenerativeVideoIntake,
} from "@/services/launch-video/generative-video-intake";
import {
  cancelMedia,
  costForJob,
  downloadMedia,
  generateMedia,
  isMediaRouterEnabled,
  pollMediaOnce,
  submitMedia,
} from "@/services/media-router/router";
import { mediaSlotHash } from "@/services/media-router/keys";
import { checkAffordMedia, flushCharges, type AffordCheck, type PendingCharge } from "@/services/media-router/charge";
import { clearPendingCharges, settleDeliveredVideoCharges, type StoredCharge } from "./video-charge-settle";
import { creditsToUsd } from "@/services/agents/credits";
import { logEvent } from "@/services/logging/logEvent";
import { trackMediaGenerated } from "@/services/analytics/action-events";
import type { JobRef, MediaFailReason, MediaRequest, MediaResult, MediaTask, SpokenWord } from "@/services/media-router/types";
import { isGenerativeVideoEnabled } from "@/services/agents/_render-launch-video-flag-check";
import { routeIntent, submitPathFor, type ModelDescriptor } from "@/services/launch-video/generative-models";
import {
  submitGeneration,
  pollGenerationOnce,
} from "@/services/launch-video/platform-higgsfield";
import { meterPlatformGeneration, type PlatformGenerationSurface } from "@/services/mcp/higgsfield-meter";
import { uploadFileToThread } from "@/services/tools/slack/upload_file";
import { callSlackTool } from "@/services/mcp/internal/slack";
import { deliverArtifactToThread } from "@/services/agents/deliver-artifact-to-thread";
import type { ChannelActionDeliveryTarget, VideoRenderTarget } from "@/services/launch-video/delivery-target";
import { billedVideoUsd, videoCreditsOf, routedVideoPlan, DEFAULT_CLIP_SECONDS } from "@/services/launch-video/video-estimate";
import { resolvePresenterVoice, talkingHeadPortraitPrompt, TALKING_HEAD_VOICE_STABILITY } from "@/services/launch-video/presenter";
import { runFinishPass } from "@/services/launch-video/finish-pass";
import { getBoolSetting } from "@/services/settings";
import { setChannelActionVideoMedia } from "@/services/channels/exec-actions";
import { stageYouTubeUploadForCard, type UploadSb } from "./video-youtube-upload";
import { CHANNEL_VIDEO_EVENT, GENERATED_VIDEO_RENDER_CLASS, renderKeyFor } from "@/services/channels/generated-video-render";
import { channelVideoBlock } from "@/services/launch-video/video-block";
import { CHANNEL_VIDEO_MAX_POLLS, VIDEO_POLL_DELAY_MS, VIDEO_RENDER_MAX_MS } from "@/services/launch-video/render-budget";
import { draftToIntake, videoDraftSchema } from "@/services/video-studio/draft";
import { lookAtPortraitUrl } from "@/services/video-studio/photo-look";
import { FAILED_KIND, REQUEUED_KIND } from "@/services/video-studio/studio";

type Sb = ReturnType<typeof serviceClient>;
type Step = Parameters<Parameters<typeof inngest.createFunction>[2]>[0]["step"];

const NANO_BANANA: ModelDescriptor = { model: "nano_banana", category: "images", pollCeiling: { attempts: 40, delayMs: 3_000 }, reveal: false, creditEst: 1 };
const TTS: ModelDescriptor = { model: "text2speech_v2", category: "audios", pollCeiling: { attempts: 20, delayMs: 2_500 }, reveal: false, creditEst: 1 };

const ESCALATION_ON = (process.env.GENERATIVE_VIDEO_ESCALATION || "").trim() === "1";

export function durationForScript(script?: string): number {
  const words = (script || "").trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 8;
  return Math.min(15, Math.max(4, Math.ceil(words / 2.5) + 1));
}

const DURABLE_VIDEO_BUCKET = "launch-video-artifacts";

type GenerateVideoEventData = {
  run_id?: string;
  delivery_target?: VideoRenderTarget;
  channel_id?: string;
  thread_ts?: string;
  team_id?: string | null;
};

export async function notifyGenerateVideoFailure(data: GenerateVideoEventData, sb: Sb = serviceClient()): Promise<void> {
  const run_id = data.run_id;
  if (!run_id) return;
  const target: VideoRenderTarget | null =
    data.delivery_target ??
    (data.channel_id ? { kind: "slack", channel_id: data.channel_id, thread_ts: data.thread_ts, team_id: data.team_id ?? null } : null);
  if (!target || target.kind === "channel_action") return;
  const { data: runRow, error: runErr } = await sb
    .from("agent_runs")
    .select("tenant_id")
    .eq("id", run_id)
    .maybeSingle<{ tenant_id: string }>();
  if (runErr) throw new Error(`generate-video onFailure: agent_runs read failed: ${runErr.message}`);
  const tenant_id = runRow?.tenant_id;
  if (!tenant_id) return;
  let deliveredQuery = sb
    .from("run_artifacts")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("run_id", run_id)
    .like("mime", "video/%");
  if (target.kind === "slack") deliveredQuery = deliveredQuery.eq("slack_delivered", true);
  const delivered = await deliveredQuery.limit(1);
  if (delivered.error) throw new Error(`generate-video onFailure: run_artifacts read failed: ${delivered.error.message}`);
  if ((delivered.data ?? []).length > 0) {
    await settleDeliveredVideoCharges(sb, tenant_id, run_id);
    await releaseVideoHold(sb, run_id);
    return;
  }
  await releaseVideoHold(sb, run_id);
  if (target.kind === "chat") {
    const told = await sb
      .from("agent_thread_messages")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("thread_id", target.thread_id)
      .contains("meta", { source_run_id: run_id })
      .limit(1);
    if (told.error) throw new Error(`generate-video onFailure: thread read failed: ${told.error.message}`);
    if ((told.data ?? []).length > 0) return;
  }
  const text = "Sorry, the video generation didn't complete. No credits were used for a failed generation.";
  if (target.kind === "chat") {
    const ok = await deliverArtifactToThread({ tenant_id, thread_id: target.thread_id, run_id, body: text, meta: { kind: "generative_video_failed" } });
    if (!ok) throw new Error(`generate-video onFailure: chat delivery failed (thread=${target.thread_id})`);
    return;
  }
  await callSlackTool(tenant_id, "post_message", { channel_id: target.channel_id, thread_ts: target.thread_ts, text }, target.team_id ?? undefined);
}

export const generateVideoFn = inngest.createFunction(
  {
    id: "generate-video",
    retries: 2,
    concurrency: { key: "event.data.tenant_id", limit: 1 },
    idempotency: "event.data.run_id",
    onFailure: async ({ event }) =>
      notifyGenerateVideoFailure((event.data?.event?.data ?? {}) as GenerateVideoEventData),
  },
  { event: "video.generate.requested" },
  async ({ event, step, logger }) => {
    const { run_id, intake: rawIntake, channel_id, thread_ts, team_id } = event.data;
    if (!run_id) throw new NonRetriableError("generate-video: missing run_id");
    const target: VideoRenderTarget | null =
      (event.data.delivery_target as VideoRenderTarget | undefined) ??
      (channel_id ? { kind: "slack", channel_id, thread_ts, team_id: team_id ?? null } : null);
    if (!target) throw new NonRetriableError("generate-video: no delivery target");
    if (target.kind === "channel_action") throw new NonRetriableError("generate-video: card renders use generate-channel-video");

    const sb = serviceClient();

    const { data: runRow, error: runErr } = await step.run("derive-tenant-c8-reverified", async () =>
      sb.from("agent_runs").select("tenant_id, payload").eq("id", run_id).maybeSingle<{ tenant_id: string; payload?: StudioRunPayload | null }>(),
    );
    if (runErr) throw new Error(`generate-video: agent_runs read failed: ${runErr.message}`);
    const tenant_id = runRow?.tenant_id;
    if (!tenant_id) throw new NonRetriableError(`generate-video: no agent_runs row for ${run_id}`);

    const enabled = await step.run("flag-check", () => isGenerativeVideoEnabled(tenant_id, sb));
    if (!enabled) {
      logger.warn(`generate-video: flag OFF for tenant ${tenant_id} (run ${run_id})`);
      if (runRow?.payload?.stage === STUDIO_RENDER_STAGE) await postFailure(tenant_id, target, run_id, "video making is switched off right now, so the video was not made");
      return { skipped: "flag_off" };
    }

    const parsed = generativeVideoIntakeSchema.safeParse(rawIntake);
    if (!parsed.success) {
      await postFailure(tenant_id, target, run_id, "the video request was incomplete");
      throw new NonRetriableError(`generate-video: invalid intake: ${parsed.error.message}`);
    }
    const isStudio = runRow?.payload?.stage === STUDIO_RENDER_STAGE;
    const videoSubmitted = await sb.from("generative_video_jobs").select("run_id").eq("run_id", run_id).eq("meter_key", `${run_id}:gen-video:0`).maybeSingle();
    if (videoSubmitted?.error) throw new Error(`generate-video: job row read failed: ${videoSubmitted.error.message}`);
    if (!videoSubmitted?.data) {
      const block =
        !isStudio || ((await isMediaRouterEnabled()) && (await isGenerativeVideoEnabled(tenant_id, sb)))
          ? await channelVideoBlock(tenant_id)
          : "video making is switched off right now, so the video was not made";
      if (block) {
        await postFailure(tenant_id, target, run_id, block);
        return { skipped: isStudio ? "studio_blocked" : "channel_blocked" };
      }
    }
    const studio = target.kind === "chat" ? studioRenderOf(runRow?.payload) : null;
    return runVideoFlow(step, sb, { tenant_id, run_id, intake: parsed.data, target, logger, studio }, { maxPolls: CHANNEL_VIDEO_MAX_POLLS });
  },
);

export { channelVideoBlock };

export const STUDIO_RENDER_STAGE = "video-studio-render";
export const STUDIO_RETRY_CHAIN_MAX = 5;

type StudioRunPayload = { stage?: string; studio_thread_id?: unknown; draft_message_id?: unknown; retry_of?: unknown };

export type StudioRender = { thread_id: string; draft_message_id: string; retry_of: string | null };

export function studioRenderOf(payload: StudioRunPayload | null | undefined): StudioRender | null {
  if (payload?.stage !== STUDIO_RENDER_STAGE) return null;
  const thread_id = payload.studio_thread_id;
  const draft_message_id = payload.draft_message_id;
  if (typeof thread_id !== "string" || !thread_id || typeof draft_message_id !== "string" || !draft_message_id) return null;
  return { thread_id, draft_message_id, retry_of: typeof payload.retry_of === "string" && payload.retry_of ? payload.retry_of : null };
}

export async function studioRenderCurrent(sb: Sb, tenant_id: string, run_id: string, studio: StudioRender): Promise<boolean> {
  const r = await sb
    .from("agent_thread_messages")
    .select("meta")
    .eq("tenant_id", tenant_id)
    .eq("thread_id", studio.thread_id)
    .eq("id", studio.draft_message_id)
    .maybeSingle<{ meta: Record<string, unknown> | null }>();
  if (r.error) throw new Error(`generate-video: studio draft read failed: ${r.error.message}`);
  return r.data?.meta?.render_run_id === run_id;
}

export { CHANNEL_VIDEO_MAX_POLLS };
export const VIDEO_POLLS_PER_STEP = 60;
export const LEASE_RENEW_EVERY_POLLS = 12;
export const IN_FLIGHT_WINDOW_MS = 2 * 60 * 60 * 1000;

export async function renewChannelVideoLease(sb: Sb, tenant_id: string, target: ChannelActionDeliveryTarget): Promise<boolean> {
  const renewed = await sb
    .from("channel_actions")
    .update({ exec_claimed_at: new Date().toISOString() })
    .eq("id", target.action_id)
    .eq("tenant_id", tenant_id)
    .eq("exec_claim_id", target.claim_id)
    .eq("exec_status", "dispatching")
    .select("id");
  if (renewed.error) throw new Error(`card lease renew failed: ${renewed.error.message}`);
  if ((renewed.data ?? []).length > 0) return true;
  const row = await sb
    .from("channel_actions")
    .select("exec_status, exec_claim_id")
    .eq("id", target.action_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle<{ exec_status: string | null; exec_claim_id: string | null }>();
  if (row.error) throw new Error(`card lease read failed: ${row.error.message}`);
  return row.data?.exec_claim_id === target.claim_id && row.data?.exec_status === "executed";
}

type InFlightCard = {
  id: string;
  exec_status: string;
  exec_claim_id: string | null;
  exec_payload: { intake?: unknown } | null;
  cost_credits?: number | null;
};
const IN_FLIGHT_COLUMNS = "id, exec_status, exec_claim_id, exec_payload, cost_credits:body->cost_credits";

export async function inFlightCardVideoUsd(
  sb: Sb,
  tenant_id: string,
  target: ChannelActionDeliveryTarget,
  now: number = Date.now(),
): Promise<number> {
  const cards = await cardVideosAhead(sb, tenant_id, { action_id: target.action_id }, now);
  const chats = await studioVideosAhead(sb, tenant_id, { at: cards.mine }, now);
  const asked = await askedVideosAhead(sb, tenant_id, { at: cards.mine }, now);
  return cards.usd + chats.usd + asked.usd;
}

export async function inFlightStudioRenderUsd(sb: Sb, tenant_id: string, run_id: string, now: number = Date.now()): Promise<number> {
  const chats = await studioVideosAhead(sb, tenant_id, { run_id }, now);
  const cards = await cardVideosAhead(sb, tenant_id, { at: chats.mine }, now);
  const asked = await askedVideosAhead(sb, tenant_id, { at: chats.mine }, now);
  return chats.usd + cards.usd + asked.usd;
}

export async function inFlightVideoUsd(sb: Sb, tenant_id: string, now: number = Date.now()): Promise<number> {
  const [chats, cards, asked] = await Promise.all([
    studioVideosAhead(sb, tenant_id, { at: undefined }, now),
    cardVideosAhead(sb, tenant_id, { at: undefined }, now),
    askedVideosAhead(sb, tenant_id, { at: undefined }, now),
  ]);
  return chats.usd + cards.usd + asked.usd;
}

export const tenantInFlightVideoUsd = (tenant_id: string): Promise<number> => inFlightVideoUsd(serviceClient(), tenant_id);

export async function inFlightAskedVideoUsd(sb: Sb, tenant_id: string, run_id: string, now: number = Date.now()): Promise<number> {
  const asked = await askedVideosAhead(sb, tenant_id, { run_id }, now);
  const cards = await cardVideosAhead(sb, tenant_id, { at: asked.mine }, now);
  const chats = await studioVideosAhead(sb, tenant_id, { at: asked.mine }, now);
  return asked.usd + cards.usd + chats.usd;
}

export const VIDEO_HOLD_MODEL = "video-hold";
export const videoHoldKey = (run_id: string): string => `${run_id}:video-hold`;

export async function placeVideoHold(sb: Sb, tenant_id: string, run_id: string, usd: number): Promise<void> {
  const w = await sb
    .from("generative_video_jobs")
    .upsert(
      { tenant_id, run_id, meter_key: videoHoldKey(run_id), model: VIDEO_HOLD_MODEL, job_id: JSON.stringify({ usd }), status: "pending" },
      { onConflict: "run_id,meter_key", ignoreDuplicates: true },
    );
  if (w?.error) throw new Error(`video hold not placed: ${w.error.message}`);
}

export async function releaseVideoHold(sb: Sb, run_id: string): Promise<void> {
  const owed = await sb
    .from("generative_video_jobs")
    .select("pending_charges")
    .eq("run_id", run_id)
    .eq("meter_key", `${run_id}:gen-video:0`)
    .maybeSingle<{ pending_charges: unknown[] | null }>();
  if (owed?.error) throw new Error(`video hold release read failed: ${owed.error.message}`);
  if (Array.isArray(owed?.data?.pending_charges) && owed.data.pending_charges.length > 0) return;
  const w = await sb
    .from("generative_video_jobs")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("run_id", run_id)
    .eq("meter_key", videoHoldKey(run_id));
  if (w?.error) throw new Error(`video hold not released: ${w.error.message}`);
}

type HoldRow = { run_id: string; job_id: string | null; created_at: string | null };

async function askedVideosAhead(sb: Sb, tenant_id: string, me: { run_id: string } | { at: number | undefined }, now: number): Promise<RenderOrder> {
  const selfId = "run_id" in me ? me.run_id : null;
  const holds = await sb
    .from("generative_video_jobs")
    .select("run_id, job_id, created_at")
    .eq("tenant_id", tenant_id)
    .eq("model", VIDEO_HOLD_MODEL)
    .eq("status", "pending");
  if (holds.error) throw new Error(`in-flight asked videos read failed: ${holds.error.message}`);
  const atOf = (r: HoldRow): number | undefined => {
    const t = Date.parse(r.created_at ?? "");
    return Number.isFinite(t) ? t : undefined;
  };
  const rows = ((holds.data ?? []) as HoldRow[]).filter((r) => {
    const at = atOf(r);
    return at === undefined || at >= now - STUDIO_IN_FLIGHT_WINDOW_MS;
  });
  const self = selfId ? rows.find((r) => r.run_id === selfId) : undefined;
  const mine = selfId ? (self ? atOf(self) : undefined) : "at" in me ? me.at : undefined;
  const ahead = rows.filter((r) => {
    if (r.run_id === selfId) return false;
    const at = atOf(r);
    if (at === undefined || mine === undefined) return true;
    if (!selfId) return at <= mine;
    return at < mine || (at === mine && r.run_id < selfId);
  });
  if (ahead.length === 0) return { usd: 0, mine };
  const ledger = await sb
    .from("tenant_credit_ledger")
    .select("media_key")
    .eq("tenant_id", tenant_id)
    .eq("kind", "media")
    .in(
      "media_key",
      ahead.map((r) => `${r.run_id}:gen-video:0`),
    );
  if (ledger.error) throw new Error(`in-flight asked videos charges read failed: ${ledger.error.message}`);
  const charged = new Set(((ledger.data ?? []) as Array<{ media_key: string }>).map((r) => r.media_key));
  let usd = 0;
  for (const r of ahead) {
    if (charged.has(`${r.run_id}:gen-video:0`)) continue;
    let held = NaN;
    try {
      held = Number((JSON.parse(r.job_id ?? "{}") as { usd?: unknown }).usd);
    } catch {
      held = NaN;
    }
    if (!Number.isFinite(held) || held < 0) throw new Error(`in-flight asked video hold unreadable for run ${r.run_id}`);
    usd += held;
  }
  return { usd, mine };
}

type RenderOrder = { usd: number; mine: number | undefined };

async function cardVideosAhead(
  sb: Sb,
  tenant_id: string,
  me: { action_id: string } | { at: number | undefined },
  now: number,
): Promise<RenderOrder> {
  const selfId = "action_id" in me ? me.action_id : null;
  const since = new Date(now - IN_FLIGHT_WINDOW_MS).toISOString();
  const [open, done] = await Promise.all([
    sb
      .from("channel_actions")
      .select(IN_FLIGHT_COLUMNS)
      .eq("tenant_id", tenant_id)
      .eq("exec_class", GENERATED_VIDEO_RENDER_CLASS)
      .in("exec_status", ["queued", "dispatching"]),
    sb
      .from("channel_actions")
      .select(IN_FLIGHT_COLUMNS)
      .eq("tenant_id", tenant_id)
      .eq("exec_class", GENERATED_VIDEO_RENDER_CLASS)
      .eq("exec_status", "executed")
      .gte("executed_at", since),
  ]);
  if (open.error || done.error) throw new Error(`in-flight video read failed: ${(open.error ?? done.error)!.message}`);
  const others = [...((open.data ?? []) as InFlightCard[]), ...((done.data ?? []) as InFlightCard[])].filter((c) => c.id !== selfId);
  const asked = [...(selfId ? [selfId] : []), ...others.map((c) => c.id)];
  if (asked.length === 0) return { usd: 0, mine: "at" in me ? me.at : undefined };

  const approvals = await sb
    .from("channel_action_events")
    .select("action_id, at")
    .eq("tenant_id", tenant_id)
    .eq("event", "approved")
    .in("action_id", asked);
  if (approvals.error) throw new Error(`in-flight approvals read failed: ${approvals.error.message}`);
  const approvedAt = new Map<string, number>();
  for (const e of (approvals.data ?? []) as Array<{ action_id: string; at: string }>) {
    const t = Date.parse(e.at);
    if (Number.isFinite(t) && t > (approvedAt.get(e.action_id) ?? -Infinity)) approvedAt.set(e.action_id, t);
  }
  const mine = selfId ? approvedAt.get(selfId) : "at" in me ? me.at : undefined;
  const ahead = others.filter((c) => {
    const at = approvedAt.get(c.id);
    if (at === undefined) return true;
    if (at < now - IN_FLIGHT_WINDOW_MS) return false;
    if (mine === undefined) return true;
    if (!selfId) return at <= mine;
    return at < mine || (at === mine && c.id < selfId);
  });
  if (ahead.length === 0) return { usd: 0, mine };

  const legsOf = (c: InFlightCard, talking: boolean): string[] => {
    const base = renderKeyFor(c.id, c.exec_claim_id ?? "");
    return talking ? [`${base}:gen-image:0`, `${base}:gen-vo:0`, `${base}:gen-video:0`] : [`${base}:gen-video:0`];
  };
  const intakeOf = (c: InFlightCard) => generativeVideoIntakeSchema.safeParse(c.exec_payload?.intake);
  const executed = ahead.filter((c) => c.exec_status === "executed");
  let charged = new Set<string>();
  if (executed.length > 0) {
    const keys = executed.flatMap((c) => legsOf(c, true));
    const ledger = await sb.from("tenant_credit_ledger").select("media_key").eq("tenant_id", tenant_id).eq("kind", "media").in("media_key", keys);
    if (ledger.error) throw new Error(`in-flight charges read failed: ${ledger.error.message}`);
    charged = new Set(((ledger.data ?? []) as Array<{ media_key: string }>).map((r) => r.media_key));
  }

  let usd = 0;
  for (const c of ahead) {
    const parsed = intakeOf(c);
    const talking = parsed.success && parsed.data.intent === "talking_head";
    if (c.exec_status === "executed" && legsOf(c, talking).every((k) => charged.has(k))) continue;
    if (!parsed.success) continue;
    const shown = typeof c.cost_credits === "number" && Number.isFinite(c.cost_credits) ? creditsToUsd(c.cost_credits) : 0;
    usd += Math.max(await billedVideoUsd(parsed.data), shown);
  }
  return { usd, mine };
}

export const STUDIO_IN_FLIGHT_WINDOW_MS = 2 * VIDEO_RENDER_MAX_MS;

type StudioRunRow = { id: string; enqueued_at: string | null; payload: StudioRunPayload | null };

async function studioVideosAhead(sb: Sb, tenant_id: string, me: { run_id: string } | { at: number | undefined }, now: number): Promise<RenderOrder> {
  const selfId = "run_id" in me ? me.run_id : null;
  const since = new Date(now - STUDIO_IN_FLIGHT_WINDOW_MS).toISOString();
  const runs = await sb
    .from("agent_runs")
    .select("id, enqueued_at, payload")
    .eq("tenant_id", tenant_id)
    .eq("payload->>stage", STUDIO_RENDER_STAGE)
    .gte("enqueued_at", since);
  if (runs.error) throw new Error(`in-flight chat renders read failed: ${runs.error.message}`);
  const rows = (runs.data ?? []) as StudioRunRow[];
  const atOf = (r: StudioRunRow): number | undefined => {
    const t = Date.parse(r.enqueued_at ?? "");
    return Number.isFinite(t) ? t : undefined;
  };
  const self = selfId ? rows.find((r) => r.id === selfId) : undefined;
  const mine = selfId ? (self ? atOf(self) : undefined) : "at" in me ? me.at : undefined;
  const ahead = rows
    .filter((r) => {
      if (r.id === selfId) return false;
      const at = atOf(r);
      if (at === undefined || mine === undefined) return true;
      if (!selfId) return at < mine;
      return at < mine || (at === mine && r.id < selfId);
    })
    .map((r) => ({ id: r.id, studio: studioRenderOf(r.payload) }))
    .filter((r): r is { id: string; studio: StudioRender } => r.studio !== null);
  if (ahead.length === 0) return { usd: 0, mine };

  const ids = ahead.map((r) => r.id);
  const [drafts, failed, ledger] = await Promise.all([
    sb
      .from("agent_thread_messages")
      .select("id, meta")
      .eq("tenant_id", tenant_id)
      .in("id", [...new Set(ahead.map((r) => r.studio.draft_message_id))]),
    sb
      .from("agent_thread_messages")
      .select("meta, created_at")
      .eq("tenant_id", tenant_id)
      .in("meta->>kind", [FAILED_KIND, REQUEUED_KIND])
      .in("meta->>source_run_id", ids)
      .order("created_at", { ascending: true }),
    sb
      .from("tenant_credit_ledger")
      .select("media_key")
      .eq("tenant_id", tenant_id)
      .eq("kind", "media")
      .in(
        "media_key",
        ids.map((id) => `${id}:gen-video:0`),
      ),
  ]);
  const err = drafts.error ?? failed.error ?? ledger.error;
  if (err) throw new Error(`in-flight chat renders read failed: ${err.message}`);
  const draftMeta = new Map(((drafts.data ?? []) as Array<{ id: string; meta: Record<string, unknown> | null }>).map((m) => [m.id, m.meta ?? {}]));
  const ended = new Set<string>();
  for (const m of (failed.data ?? []) as Array<{ meta: Record<string, unknown> | null }>) {
    const src = String(m.meta?.source_run_id ?? "");
    if (m.meta?.kind === REQUEUED_KIND) ended.delete(src);
    else ended.add(src);
  }
  const charged = new Set(((ledger.data ?? []) as Array<{ media_key: string }>).map((r) => r.media_key));

  let usd = 0;
  for (const r of ahead) {
    if (ended.has(r.id) || charged.has(`${r.id}:gen-video:0`)) continue;
    const meta = draftMeta.get(r.studio.draft_message_id);
    if (!meta || meta.render_run_id !== r.id) continue;
    const draft = videoDraftSchema.safeParse(meta.video_draft);
    if (!draft.success) continue;
    const intake = draftToIntake(draft.data);
    if (!intake.ok) continue;
    usd += await billedVideoUsd(intake.intake);
  }
  return { usd, mine };
}

type ChannelVideoEventData = {
  run_id?: string;
  render_key?: string;
  intake?: unknown;
  delivery_target?: { kind?: string; action_id?: string; claim_id?: string };
};

function channelTargetOf(data: ChannelVideoEventData | undefined): ChannelActionDeliveryTarget | null {
  const t = data?.delivery_target;
  return t && t.kind === "channel_action" && typeof t.action_id === "string" && typeof t.claim_id === "string" && t.action_id && t.claim_id
    ? { kind: "channel_action", action_id: t.action_id, claim_id: t.claim_id }
    : null;
}

export async function settleChannelVideoFailure(data: ChannelVideoEventData, error: Error | undefined): Promise<void> {
  const target = channelTargetOf(data);
  if (!target || !data.run_id) return;
  const { data: runRow, error: runErr } = await serviceClient()
    .from("agent_runs")
    .select("tenant_id")
    .eq("id", data.run_id)
    .maybeSingle<{ tenant_id: string }>();
  if (runErr) throw new Error(`generate-channel-video onFailure: agent_runs read failed: ${runErr.message}`);
  if (!runRow?.tenant_id) return;
  if (await repairDeliveredCharges(runRow.tenant_id, data.run_id, target, data.render_key)) return;
  await setChannelActionVideoMedia(runRow.tenant_id, {
    actionId: target.action_id,
    runId: data.run_id,
    claimId: target.claim_id,
    ok: false,
    error: `Sorry, the video could not be made (${(error?.message ?? "unknown error").slice(0, 120)}). You were not charged for it.`,
  }).catch((e) => {
    console.error(`[generate-channel-video] onFailure settle failed for ${target.action_id}: ${(e as Error).message}`);
    throw e;
  });
}

export async function repairDeliveredCharges(
  tenant_id: string,
  run_id: string,
  target: ChannelActionDeliveryTarget,
  render_key: string | undefined,
  sb: Sb = serviceClient(),
): Promise<boolean> {
  const card = await sb
    .from("channel_actions")
    .select("exec_status, exec_claim_id")
    .eq("id", target.action_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle<{ exec_status: string | null; exec_claim_id: string | null }>();
  if (card.error) throw new Error(`charge repair: card read failed: ${card.error.message}`);
  if (card.data?.exec_status !== "executed" || card.data.exec_claim_id !== target.claim_id) return false;
  const key = `${render_key ?? renderKeyFor(target.action_id, target.claim_id)}:gen-video:0`;
  const row = await sb
    .from("generative_video_jobs")
    .select("pending_charges")
    .eq("run_id", run_id)
    .eq("meter_key", key)
    .maybeSingle<{ pending_charges: PendingCharge[] | null }>();
  if (row.error && /pending_charges/.test(row.error.message ?? "")) return true;
  if (row.error) throw new Error(`charge repair: job read failed: ${row.error.message}`);
  const owed = (row.data?.pending_charges ?? []).filter(
    (c) => c && typeof c.key === "string" && c.key.startsWith(`${key.slice(0, -":gen-video:0".length)}:`) && c.tenant_id === tenant_id,
  );
  if (owed.length > 0) {
    await flushCharges(owed.map((c) => ({ ...c, tenant_id, run_id })));
    void logEvent({ level: "warn", source: "workers.generate_video", code: "video_charge_repaired", tenant_id, run_id });
  }
  return true;
}

export const generateChannelVideoFn = inngest.createFunction(
  {
    id: "generate-channel-video",
    retries: 2,
    concurrency: { key: "event.data.tenant_id", limit: 5 },
    idempotency: "event.data.render_key",
    onFailure: async ({ event, error }) =>
      settleChannelVideoFailure((event.data?.event?.data ?? {}) as ChannelVideoEventData, error as Error),
  },
  { event: CHANNEL_VIDEO_EVENT },
  async ({ event, step, logger }) => {
    const data = (event.data ?? {}) as ChannelVideoEventData;
    const run_id = data.run_id;
    const target = channelTargetOf(data);
    const render_key = typeof data.render_key === "string" && data.render_key ? data.render_key : null;
    if (!run_id || !target || !render_key) throw new NonRetriableError("generate-channel-video: missing run_id, card or render key");

    const sb = serviceClient();
    const { data: runRow, error: runErr } = await step.run("derive-tenant-c8-reverified", async () =>
      sb.from("agent_runs").select("tenant_id").eq("id", run_id).maybeSingle<{ tenant_id: string }>(),
    );
    if (runErr) throw new Error(`generate-channel-video: agent_runs read failed: ${runErr.message}`);
    const tenant_id = runRow?.tenant_id;
    if (!tenant_id) throw new NonRetriableError(`generate-channel-video: no agent_runs row for ${run_id}`);

    const ready = await step.run("flag-and-router-check", async () =>
      (await isGenerativeVideoEnabled(tenant_id, sb)) && (await isMediaRouterEnabled()),
    );
    if (!ready) {
      await postRoutedFailure(tenant_id, target, run_id, "video making is switched off right now");
      return { skipped: "video_unavailable" };
    }
    const blocked = await step.run("channel-video-block", () => channelVideoBlock(tenant_id));
    if (blocked) {
      await postRoutedFailure(tenant_id, target, run_id, blocked);
      return { skipped: "not_entitled" };
    }
    const parsed = generativeVideoIntakeSchema.safeParse(data.intake);
    if (!parsed.success) {
      await postRoutedFailure(tenant_id, target, run_id, "the video request was incomplete");
      return { skipped: "invalid_intake" };
    }
    return runRoutedVideo(
      step,
      sb,
      { tenant_id, run_id, intake: parsed.data, target, logger, render_key },
      { maxPolls: CHANNEL_VIDEO_MAX_POLLS },
    );
  },
);

export type VideoFlowArgs = {
  tenant_id: string;
  run_id: string;
  intake: GenerativeVideoIntake;
  target: VideoRenderTarget;
  logger: { warn: (msg: string) => void };
  render_key?: string;
  studio?: StudioRender | null;
};
export type VideoFlowResult = { ok: true; model: string; intent: string } | { skipped: string };
type PollOpts = { pollDelayMs?: number; maxPolls?: number; pollsPerStep?: number };

export async function runVideoFlow(step: Step, sb: Sb, args: VideoFlowArgs, opts: PollOpts = {}): Promise<VideoFlowResult> {
  const routed = await step.run("router-check", () => isMediaRouterEnabled());
  return routed ? runRoutedVideo(step, sb, args, opts) : legacyFlow(step, sb, args);
}

async function legacyFlow(step: Step, sb: Sb, args: VideoFlowArgs): Promise<VideoFlowResult> {
  const { tenant_id, run_id, intake, logger } = args;
  if (args.target.kind === "channel_action") {
    await postFailure(tenant_id, args.target, run_id, "video making is not available right now");
    return { skipped: "legacy_rail_not_for_cards" };
  }
  const target = args.target;
  if (intake.intent === "animate") {
    await postFailure(tenant_id, target, run_id, "animating an image is not available right now");
    return { skipped: "legacy_rail_no_animate" };
  }
  {
    const descriptor = routeIntent(intake.intent, { premium: ESCALATION_ON && intake.premium });
    const aspect = intake.aspect_ratio ?? "16:9";

    let baseParams: Record<string, unknown> = {
      prompt: intake.prompt,
      aspect_ratio: aspect,
      duration: 10,
      resolution: "720p",
    };

    if (intake.intent === "talking_head") {
      const portrait = await genStep(step, sb, {
        tenant_id,
        run_id,
        surface: "gen-image",
        index: 0,
        descriptor: NANO_BANANA,
        params: { prompt: `${intake.prompt}. Photoreal upper-body portrait, looking at camera, studio lighting.`, aspect_ratio: aspect },
      });
      if (portrait.status === "meter_error") {
        await postFailure(tenant_id, target, run_id, "could not start the video (metering unavailable)");
        throw new Error("generate-video: meter_error on portrait — fail closed");
      }
      const startImage = portrait.status === "ok" ? { start_image: { id: portrait.jobId, type: "image_job" } } : {};
      const scriptLine = intake.script?.trim();

      const spoken = scriptLine ? ` The person says, at a natural pace: "${scriptLine}"` : "";
      baseParams = {
        prompt: `${intake.prompt}. The person speaks directly to camera, natural head movement, engaging.${spoken}`,
        aspect_ratio: aspect,
        duration: durationForScript(scriptLine),
        resolution: "720p",
        generate_audio: true,
        ...startImage,
      };

      if (ESCALATION_ON && scriptLine && portrait.status === "ok") {
        const voRes = await step.run("tts", async () => {
          const s = await submitGeneration(submitPathFor(TTS), {
            variant: "elevenlabs",
            voice_type: "preset",
            voice_id: "573e5163-59b3-4926-aab1-951ef2985f81",
            prompt: scriptLine,
          });
          if (!s.ok) return { ok: false as const };
          for (let i = 0; i < TTS.pollCeiling.attempts; i++) {
            await sleep(TTS.pollCeiling.delayMs);
            const p = await pollGenerationOnce(s.jobId);
            if (p.ok) return { ok: true as const, jobId: s.jobId };
            if (!("pending" in p) || p.pending !== true) return { ok: false as const };
          }
          return { ok: false as const };
        });
        if (voRes.ok) {
          baseParams = {
            prompt: `${intake.prompt}. The person speaks directly to camera, natural head movement, engaging.`,
            aspect_ratio: aspect,
            duration: durationForScript(scriptLine),
            resolution: "720p",
            generate_audio: false,
            ...startImage,
            audio_references: [{ id: voRes.jobId, type: "text2speech_job" }],
          };
        }
      }
    }

    const surface: PlatformGenerationSurface =
      intake.intent === "talking_head" && descriptor.model === "marketing_studio_video" ? "gen-avatar" : "gen-video";
    const video = await genStep(step, sb, {
      tenant_id,
      run_id,
      surface,
      index: 0,
      descriptor,
      params: baseParams,
    });

    if (video.status === "meter_error") {
      await postFailure(tenant_id, target, run_id, "could not start the video (metering unavailable)");
      throw new Error("generate-video: meter_error on video — fail closed");
    }
    if (video.status === "over_cap") {
      await postFailure(tenant_id, target, run_id, "you've hit today's video generation limit. Try again tomorrow");
      return { skipped: "over_cap" };
    }
    if (video.status !== "ok" || !video.resultUrl) {
      await postFailure(tenant_id, target, run_id, "the video generation didn't complete");
      throw new Error(`generate-video: video failed: ${video.status}`);
    }

    const deliveredStored = await step.run("deliver", async () => {
      const res = await fetch(video.resultUrl!, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`fetch mp4 ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const filename = `${intake.intent}-${run_id.slice(0, 8)}.mp4`;
      const name = videoDisplayName(intake);

      let storage_path = video.resultUrl!;
      let bucket = "generative-video";
      if (target.kind === "chat") {
        const path = `${tenant_id}/${run_id}/${filename}`;
        const { error: upErr } = await sb.storage
          .from(DURABLE_VIDEO_BUCKET)
          .upload(path, Buffer.from(bytes), { contentType: "video/mp4", upsert: true });
        if (upErr) throw new Error(`artifact upload failed (${filename}): ${upErr.message}`);
        storage_path = path;
        bucket = DURABLE_VIDEO_BUCKET;
      }

      const { error: rowErr } = await sb.from("run_artifacts").upsert(
        {
          tenant_id,
          run_id,
          storage_path,
          bucket,
          filename: name,
          mime: "video/mp4",
          bytes: bytes.byteLength,
          agent_slug: "operator",
        },
        { onConflict: "tenant_id,run_id,filename" },
      );
      let stored = true;
      if (rowErr) {
        if (target.kind === "chat") throw new Error(`run_artifacts upsert failed (${filename}): ${rowErr.message}`);
        logger.warn(`generate-video: run_artifacts upsert failed (${filename}): ${rowErr.message}`);
        stored = false;
      }

      if (target.kind === "chat") {
        await deliverArtifactToThread({
          tenant_id,
          thread_id: target.thread_id,
          run_id,
          body: "Your video is ready, attached below.",
          meta: { kind: "generative_video", intent: intake.intent },
        });
        return stored;
      }
      await uploadFileToThread({
        tenant_id,
        channel_id: target.channel_id,
        thread_ts: target.thread_ts,
        bytes,
        filename: name,
        title: name,
        team_id: target.team_id ?? undefined,
      });
      if (stored) {
        const { error: markErr } = await sb
          .from("run_artifacts")
          .update({ slack_delivered: true })
          .eq("tenant_id", tenant_id)
          .eq("run_id", run_id)
          .eq("filename", name);
        if (markErr) logger.warn(`generate-video: slack_delivered mark failed (${filename}): ${markErr.message}`);
      }
      return stored;
    });
    if (deliveredStored) trackMediaGenerated({ tenant_id, media: "video", kind: intake.intent });

    return { ok: true, model: descriptor.model, intent: intake.intent };
  }
}

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const FINISH_URL_TTL_S = 15 * 60;

async function storedVideoBytes(sb: Sb, path: string): Promise<number | null> {
  const cut = path.lastIndexOf("/");
  const listed = await sb.storage.from(DURABLE_VIDEO_BUCKET).list(path.slice(0, cut), { search: path.slice(cut + 1), limit: 5 });
  const hit = (listed.data ?? []).find((o: { name: string }) => o.name === path.slice(cut + 1)) as { metadata?: { size?: number } } | undefined;
  const size = Number(hit?.metadata?.size);
  return hit && Number.isFinite(size) && size > 0 ? size : null;
}

export type FinishOutcome = { finished: boolean; bytes?: number; duration_s?: number; reason?: string };

export async function finishStagedVideo(
  sb: Sb,
  a: {
    tenant_id: string;
    run_id: string;
    target: VideoRenderTarget;
    words?: SpokenWord[];
    videoSeconds?: number;
    hook?: string;
    rawPath: string;
    finishedPath: string;
    logger: { warn: (msg: string) => void };
  },
  run: typeof runFinishPass = runFinishPass,
): Promise<FinishOutcome> {
  const skip = (reason: string, detail?: string): FinishOutcome => {
    if (reason !== "switched_off") {
      a.logger.warn(`generate-video: finish pass skipped (${reason})${detail ? `: ${detail}` : ""}; delivering the unedited video`);
      void logEvent({
        level: reason === "lease_lost" ? "warn" : "error",
        source: "workers.generate_video",
        code: "video_finish_pass_skipped",
        tenant_id: a.tenant_id,
        run_id: a.run_id,
        meta: { failure_class: reason },
      });
    }
    return { finished: false, reason };
  };
  try {
    if (!(await getBoolSetting("ugc_video_finish_pass_enabled", a.tenant_id))) return skip("switched_off");
    const target = a.target;
    const stillOurs = async (): Promise<boolean> =>
      target.kind !== "channel_action" || renewChannelVideoLease(sb, a.tenant_id, target).catch(() => true);
    if (!(await stillOurs())) return skip("lease_lost");

    const bucket = sb.storage.from(DURABLE_VIDEO_BUCKET);
    const get = await bucket.createSignedUrl(a.rawPath, FINISH_URL_TTL_S);
    const put = await bucket.createSignedUploadUrl(a.finishedPath, { upsert: true });
    if (get.error || !get.data?.signedUrl || put.error || !put.data?.signedUrl) {
      return skip("sign", get.error?.message ?? put.error?.message);
    }
    const beat = target.kind === "channel_action" ? setInterval(() => void stillOurs().catch(() => undefined), 60_000) : null;
    try {
      const r = await run({
        tenant_id: a.tenant_id,
        rawUrl: get.data.signedUrl,
        uploadUrl: put.data.signedUrl,
        words: a.words ?? [],
        videoSeconds: a.videoSeconds,
        hook: a.hook,
        stillOurs,
      });
      if (!r.ok) return skip(r.reason, r.detail);
      return { finished: true, bytes: r.bytes, duration_s: r.duration_s };
    } finally {
      if (beat) clearInterval(beat);
    }
  } catch (e) {
    return skip("error", (e as Error).message.slice(0, 200));
  }
}

export async function runRoutedVideo(step: Step, sb: Sb, args: VideoFlowArgs, opts: PollOpts = {}): Promise<VideoFlowResult> {
  const out = await routedVideo(step, sb, args, opts);
  if (args.target.kind !== "channel_action" && !(args.target.kind === "chat" && args.studio)) {
    await step.run("release-video-hold", () => releaseVideoHold(sb, args.run_id));
  }
  return out;
}

async function routedVideo(step: Step, sb: Sb, args: VideoFlowArgs, opts: PollOpts = {}): Promise<VideoFlowResult> {
  const { tenant_id, run_id, intake, target, logger } = args;
  const keyBase = args.render_key ?? run_id;
  const studio = target.kind === "chat" ? (args.studio ?? null) : null;
  const guarded = target.kind === "channel_action" || !!studio;
  const held = async (): Promise<boolean> => {
    if (target.kind === "channel_action") return renewChannelVideoLease(sb, tenant_id, target);
    if (studio) return studioRenderCurrent(sb, tenant_id, run_id, studio);
    return true;
  };
  const aspect = narrowAspect(intake.aspect_ratio);
  const talkingHead = intake.intent === "talking_head";
  const { task, clipSeconds } = routedVideoPlan(intake);
  const estimate = await billedVideoUsd(intake);
  if (target.kind === "channel_action") {
    const held = await step.run("renew-card-lease", () => renewChannelVideoLease(sb, tenant_id, target));
    if (!held) {
      logger.warn(`generate-video: card ${target.action_id} is no longer this attempt's; nothing made, nothing charged`);
      return { skipped: "lease_lost" };
    }
  }
  const affordRaw = await step.run("afford-media", async (): Promise<AffordCheck> => {
    let othersUsd: number;
    try {
      if (target.kind !== "channel_action" && !studio) await placeVideoHold(sb, tenant_id, run_id, estimate);
      othersUsd =
        target.kind === "channel_action"
          ? await inFlightCardVideoUsd(sb, tenant_id, target)
          : studio
            ? await inFlightStudioRenderUsd(sb, tenant_id, run_id)
            : await inFlightAskedVideoUsd(sb, tenant_id, run_id);
    } catch (e) {
      logger.warn(`generate-video: ${(e as Error).message}`);
      return "unknown";
    }
    return checkAffordMedia(tenant_id, Math.round((estimate + othersUsd) * 10000) / 10000);
  });
  const afford: AffordCheck = affordRaw === true ? "ok" : affordRaw === false ? "short" : affordRaw;
  if (afford !== "ok") {
    await postRoutedFailure(
      tenant_id,
      target,
      run_id,
      afford === "short"
        ? target.kind === "channel_action" || studio
          ? `this video costs about ${videoCreditsOf(estimate).toLocaleString("en-US")} credits and your workspace doesn't have that many left once the videos already being made are paid for. Top up and try again`
          : `this video costs about ${videoCreditsOf(estimate).toLocaleString("en-US")} credits and your workspace doesn't have that many right now. Top up and try again`
        : "could not start the video (billing check unavailable). Nothing was charged, try again in a minute",
      undefined,
      afford === "short" ? "insufficient_credits" : undefined,
    );
    return { skipped: afford === "short" ? "insufficient_credits" : "afford_check_unavailable" };
  }

  const pending: PendingCharge[] = [];
  let request: MediaRequest;
  let spokenWords: SpokenWord[] | undefined;
  const meterKey = `${keyBase}:gen-video:0`;
  const intentKey = videoIntentKey(intake);

  let adopted: AdoptedVideo | null = null;
  if (target.kind === "channel_action") {
    const a = await step.run("adopt-prior-video", async () => {
      if (!(await renewChannelVideoLease(sb, tenant_id, target))) return { lost: true as const };
      return { adopted: await adoptPriorCardVideo(sb, { tenant_id, run_id, target, meterKey, intentKey, intake }) };
    });
    if ("lost" in a) {
      logger.warn(`generate-video: card ${target.action_id} was taken over before the render started; nothing made, nothing charged`);
      return { skipped: "lease_lost" };
    }
    adopted = (a.adopted ?? null) as AdoptedVideo | null;
  } else if (studio?.retry_of) {
    const priorRun = studio.retry_of;
    const a = await step.run("adopt-prior-studio-video", async () => {
      if (!(await held())) return { lost: true as const };
      return { adopted: await adoptPriorStudioVideo(sb, { tenant_id, run_id, prior_run_id: priorRun, draft_message_id: studio.draft_message_id, meterKey, intentKey, intake }) };
    });
    if ("lost" in a) {
      logger.warn(`generate-video: studio render ${run_id} was replaced by a newer Try again before it started; nothing made, nothing charged`);
      return { skipped: "lease_lost" };
    }
    adopted = (a.adopted ?? null) as AdoptedVideo | null;
  }

  const whileHeld =
    <T,>(gen: () => Promise<T>) =>
    async (): Promise<T | { lease_lost: true }> => {
      if (guarded && !(await held())) return { lease_lost: true };
      return gen();
    };

  if (adopted) {
    for (const leg of adopted.legs) {
      pending.push({ tenant_id, run_id, key: `${keyBase}:${leg.surface}:0`, cost_usd: leg.cost_usd, task: leg.task, model: leg.model });
    }
    request = talkingHead
      ? { duration_s: clipSeconds, aspect_ratio: aspect }
      : { prompt: intake.prompt, aspect_ratio: aspect, duration_s: DEFAULT_CLIP_SECONDS };
  } else if (talkingHead && intake.portrait_path) {
    const voice = await routedLeg(
      step,
      { tenant_id, run_id: keyBase, surface: "gen-vo" },
      whileHeld(() => resumableLeg(sb, { tenant_id, run_id, meter_key: `${keyBase}:gen-vo:0` }, "audio.voiceover", voiceRequest(intake))),
    );
    if (voice.decision === "meter_error") {
      await postRoutedFailure(tenant_id, target, run_id, "could not start the video (metering unavailable)");
      throw new NonRetriableError("generate-video: meter_error on voiceover — fail closed");
    }
    if (voice.decision === "over_cap") {
      await postRoutedFailure(tenant_id, target, run_id, "you've hit today's video generation limit. Try again tomorrow");
      return { skipped: "over_cap" };
    }
    if ("lease_lost" in voice.result) {
      logger.warn(`generate-video: card was taken over before the voiceover; nothing made, nothing charged`);
      return { skipped: "lease_lost" };
    }
    if (!voice.result.ok) {
      await postRoutedFailure(tenant_id, target, run_id, routedFailureCopy(voice.result.reason, intake.intent, target.kind), voice.result.reason, undefined, voice.result.http_status);
      return { skipped: "voice_failed" };
    }
    pending.push({ tenant_id, run_id, key: `${keyBase}:gen-vo:0`, cost_usd: voice.result.cost_usd, task: "audio.voiceover", model: voice.result.model });
    spokenWords = voice.result.words;
    request = { audio_url: voice.result.url, duration_s: clipSeconds, aspect_ratio: aspect };
  } else if (talkingHead) {
    const portrait = await routedLeg(
      step,
      { tenant_id, run_id: keyBase, surface: "gen-image" },
      whileHeld(() => resumableLeg(sb, { tenant_id, run_id, meter_key: `${keyBase}:gen-image:0` }, "image.photo", portraitRequest(intake))),
    );
    if (portrait.decision === "meter_error") {
      await postRoutedFailure(tenant_id, target, run_id, "could not start the video (metering unavailable)");
      throw new NonRetriableError("generate-video: meter_error on portrait — fail closed");
    }
    if (portrait.decision === "over_cap") {
      await postRoutedFailure(tenant_id, target, run_id, "you've hit today's video generation limit. Try again tomorrow");
      return { skipped: "over_cap" };
    }
    if ("lease_lost" in portrait.result) {
      logger.warn(`generate-video: card was taken over before the portrait; nothing made, nothing charged`);
      return { skipped: "lease_lost" };
    }
    if (!portrait.result.ok) {
      await postRoutedFailure(tenant_id, target, run_id, routedFailureCopy(portrait.result.reason, intake.intent, target.kind), portrait.result.reason, undefined, portrait.result.http_status);
      return { skipped: "portrait_failed" };
    }
    pending.push({ tenant_id, run_id, key: `${keyBase}:gen-image:0`, cost_usd: portrait.result.cost_usd, task: "image.photo", model: portrait.result.model });

    const portraitUrl = portrait.result.url;
    const seen = await step.run("look-at-portrait", () => lookAtPortraitUrl(portraitUrl));
    const voiced = seen?.gender ? { ...intake, presenter_gender: seen.gender } : intake;
    const voice = await routedLeg(
      step,
      { tenant_id, run_id: keyBase, surface: "gen-vo" },
      whileHeld(() => resumableLeg(sb, { tenant_id, run_id, meter_key: `${keyBase}:gen-vo:0` }, "audio.voiceover", voiceRequest(voiced))),
    );
    if (voice.decision === "meter_error") {
      await postRoutedFailure(tenant_id, target, run_id, "could not start the video (metering unavailable)");
      throw new NonRetriableError("generate-video: meter_error on voiceover — fail closed");
    }
    if (voice.decision === "over_cap") {
      await postRoutedFailure(tenant_id, target, run_id, "you've hit today's video generation limit. Try again tomorrow");
      return { skipped: "over_cap" };
    }
    if ("lease_lost" in voice.result) {
      logger.warn(`generate-video: card was taken over before the voiceover; nothing more made, nothing charged`);
      return { skipped: "lease_lost" };
    }
    if (!voice.result.ok) {
      await postRoutedFailure(tenant_id, target, run_id, routedFailureCopy(voice.result.reason, intake.intent, target.kind), voice.result.reason, undefined, voice.result.http_status);
      return { skipped: "voice_failed" };
    }
    pending.push({ tenant_id, run_id, key: `${keyBase}:gen-vo:0`, cost_usd: voice.result.cost_usd, task: "audio.voiceover", model: voice.result.model });
    spokenWords = voice.result.words;

    request = { image_url: portrait.result.url, audio_url: voice.result.url, duration_s: clipSeconds, aspect_ratio: aspect };
  } else {
    request = { prompt: intake.prompt, aspect_ratio: aspect, duration_s: DEFAULT_CLIP_SECONDS };
  }

  if (!adopted) {
    const gate = await step.run("meter-routed-gen-video-0", () =>
      meterPlatformGeneration({ tenant_id, run_id: keyBase, surface: "gen-video", index: 0 }),
    );
    if (gate.decision === "meter_error") {
      await postRoutedFailure(tenant_id, target, run_id, "could not start the video (metering unavailable)");
      throw new NonRetriableError("generate-video: meter_error on video — fail closed");
    }
    if (gate.decision === "over_cap") {
      await postRoutedFailure(tenant_id, target, run_id, "you've hit today's video generation limit. Try again tomorrow");
      return { skipped: "over_cap" };
    }
  }

  const submitted = await step.run("submit-routed-gen-video-0", async (): Promise<{ job: JobRef; unrecorded?: true } | { fail: MediaFailReason; error: string; copy?: string; http_status?: number } | { lost: true }> => {
    const existing = await sb
      .from("generative_video_jobs")
      .select("job_id,status,result_url")
      .eq("run_id", run_id)
      .eq("meter_key", meterKey)
      .maybeSingle<{ job_id: string | null; status: string; result_url: string | null }>();
    if (existing.error) throw new Error(`generate-video: job row read failed: ${existing.error.message}`);
    if (existing.data?.job_id) {
      const resumed = parseJobRef(existing.data.job_id);
      return resumed ? { job: resumed } : { fail: "vendor_error", error: "existing job row is not a router JobRef" };
    }
    if (guarded && !(await held())) return { lost: true };
    let submitRequest = request;
    const ownImage = intake.intent === "animate" ? intake.image_path : talkingHead ? intake.portrait_path : undefined;
    if (ownImage !== undefined) {
      const signed = await signAnimateImage(tenant_id, ownImage ?? "");
      if (!signed.ok) return { fail: "vendor_error", error: signed.error, copy: signed.copy };
      submitRequest = { ...request, image_url: signed.url };
    }
    const s = await submitMedia(task, submitRequest);
    if (!s.ok) return { fail: s.reason, error: s.error, ...(typeof s.http_status === "number" ? { http_status: s.http_status } : {}) };
    const stored: StoredJob = { ...s.job, intent: intentKey };
    const row = { tenant_id, run_id, meter_key: meterKey, model: s.job.model, job_id: JSON.stringify(stored), status: "pending" };
    let w = await sb.from("generative_video_jobs").upsert(row, { onConflict: "run_id,meter_key" });
    if (w?.error) w = await sb.from("generative_video_jobs").upsert(row, { onConflict: "run_id,meter_key" });
    if (w?.error) {
      logger.warn(`generate-video: video job not recorded yet (${w.error.message}); recording it in its own step`);
      return { job: s.job, unrecorded: true };
    }
    return { job: s.job };
  });
  if ("lost" in submitted) {
    logger.warn(`generate-video: card ${target.kind === "channel_action" ? target.action_id : run_id} was taken over before the video was submitted; not submitted, not charged`);
    return { skipped: "lease_lost" };
  }
  if ("fail" in submitted) {
    await postRoutedFailure(tenant_id, target, run_id, submitted.copy ?? routedFailureCopy(submitted.fail, intake.intent, target.kind), submitted.fail, undefined, submitted.http_status);
    return { skipped: "video_failed" };
  }
  const job = submitted.job as JobRef;
  await step.run("record-video-job", async () => {
    const stored: StoredJob = { ...job, intent: (job as StoredJob).intent ?? intentKey };
    const w = await sb
      .from("generative_video_jobs")
      .upsert(
        { tenant_id, run_id, meter_key: meterKey, model: job.model, job_id: JSON.stringify(stored), status: "pending" },
        { onConflict: "run_id,meter_key", ignoreDuplicates: true },
      );
    if (w?.error) throw new Error(`generate-video: video job still not recorded: ${w.error.message}`);
  });

  const maxPolls = opts.maxPolls ?? 120;
  const pollDelayMs = opts.pollDelayMs ?? VIDEO_POLL_DELAY_MS;
  const pollsPerStep = Math.max(1, opts.pollsPerStep ?? VIDEO_POLLS_PER_STEP);
  type PollStep = { url: string; duration_s?: number } | { fail: MediaFailReason; error: string; http_status?: number } | { pending: true } | { lost: true };
  let polled: { url: string; duration_s?: number } | { fail: MediaFailReason; error: string; http_status?: number } = {
    fail: "timeout",
    error: `${job.model} poll timeout`,
  };
  for (let chunk = 0, done = 0; done < maxPolls; chunk++) {
    const n = Math.min(pollsPerStep, maxPolls - done);
    done += n;
    const r = await step.run(chunk === 0 ? "poll-routed-gen-video-0" : `poll-routed-gen-video-0-${chunk}`, async (): Promise<PollStep> => {
      for (let i = 0; i < n; i++) {
        if (guarded && i % LEASE_RENEW_EVERY_POLLS === 0) {
          const stillHeld = await held().catch((e) => {
            logger.warn(`generate-video: ${(e as Error).message}`);
            return true;
          });
          if (!stillHeld) return { lost: true };
        }
        const p = await pollMediaOnce(job);
        if (p.state === "done") return { url: p.url, duration_s: p.duration_s };
        if (p.state === "failed") return { fail: p.reason, error: p.error, ...(typeof p.http_status === "number" ? { http_status: p.http_status } : {}) };
        await sleep(pollDelayMs);
      }
      return { pending: true };
    });
    if ("lost" in r) {
      logger.warn(`generate-video: card ${target.kind === "channel_action" ? target.action_id : run_id} was taken over while its video was rendering; the new attempt picks the job up, nothing charged here`);
      return { skipped: "lease_lost" };
    }
    if (!("pending" in r)) {
      polled = r;
      break;
    }
  }
  if ("fail" in polled && polled.fail === "timeout") {
    const late = await step.run("cancel-timed-out-video", async (): Promise<PollStep | { cancel: string }> => {
      if (guarded) {
        const stillHeld = await held().catch(() => null);
        if (stillHeld === false) return { lost: true };
        if (stillHeld === null) return { cancel: "skipped" };
      }
      const c = await cancelMedia(job);
      if (c === "too_late") {
        const p = await pollMediaOnce(job);
        if (p.state === "done") return { url: p.url, duration_s: p.duration_s };
        if (p.state === "failed") return { fail: p.reason, error: p.error, ...(typeof p.http_status === "number" ? { http_status: p.http_status } : {}) };
      }
      const stored: StoredJob = { ...job, intent: (job as StoredJob).intent ?? intentKey };
      const w = await sb.from("generative_video_jobs").upsert(
        {
          tenant_id,
          run_id,
          meter_key: meterKey,
          model: job.model,
          job_id: JSON.stringify(stored),
          status: "pending",
          error: `poll timeout; cancel ${c}`,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "run_id,meter_key" },
      );
      if (w?.error) throw new Error(`generate-video: timed-out job not recorded: ${w.error.message}`);
      return { cancel: c };
    });
    if ("lost" in late) {
      logger.warn(`generate-video: card was taken over as its video timed out; left the job running for the new attempt, nothing charged here`);
      return { skipped: "lease_lost" };
    }
    if ("url" in late || "fail" in late) polled = late;
  }
  if ("fail" in polled) {
    if (polled.fail !== "timeout") {
      await sb
        .from("generative_video_jobs")
        .update({ status: "failed", error: polled.error, updated_at: new Date().toISOString() })
        .eq("run_id", run_id)
        .eq("meter_key", meterKey);
    }
    await postRoutedFailure(tenant_id, target, run_id, routedFailureCopy(polled.fail, intake.intent, target.kind), polled.fail, undefined, polled.http_status);
    return { skipped: "video_failed" };
  }
  await sb
    .from("generative_video_jobs")
    .update({ status: "completed", result_url: polled.url, updated_at: new Date().toISOString() })
    .eq("run_id", run_id)
    .eq("meter_key", meterKey);

  const quotedSeconds = request.duration_s;
  const billedSeconds =
    quotedSeconds != null && polled.duration_s != null ? Math.min(polled.duration_s, quotedSeconds) : (polled.duration_s ?? quotedSeconds);
  const videoCost = costForJob(job, request, { duration_s: billedSeconds });
  const filename =
    target.kind === "channel_action"
      ? `ai-ugc-video-${target.action_id.slice(0, 8)}-${target.claim_id.slice(0, 8)}.mp4`
      : `${intake.intent}-${run_id.slice(0, 8)}.mp4`;
  const storagePath = `${tenant_id}/${run_id}/${filename}`;
  const name = videoDisplayName(intake, target.kind === "channel_action" ? target.action_id.slice(0, 8) : undefined);

  const charges: PendingCharge[] = [...pending, { tenant_id, run_id, key: meterKey, cost_usd: videoCost, task, model: job.model }];
  await step.run("record-pending-charges", async () => {
    const stored: StoredJob = { ...job, intent: (job as StoredJob).intent ?? intentKey };
    const owed: StoredCharge[] = charges.map((c) => ({ ...c, delivery: target.kind }));
    const w = await sb.from("generative_video_jobs").upsert(
      {
        tenant_id,
        run_id,
        meter_key: meterKey,
        model: job.model,
        job_id: JSON.stringify(stored),
        status: "completed",
        result_url: polled.url,
        pending_charges: owed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "run_id,meter_key" },
    );
    if (w?.error && /pending_charges/.test(w.error.message ?? "")) {
      logger.warn(`generate-video: pending_charges not recorded (migration not applied?): ${w.error.message}`);
      return;
    }
    if (w?.error) throw new Error(`generate-video: could not record what the video owes: ${w.error.message}`);
  });

  const rawPath = storagePath;
  const editedPath = `${tenant_id}/${run_id}/edited-${filename}`;
  const cardLost = async (): Promise<boolean> => guarded && !(await held());
  const staged = await step.run("stage-routed-video", async (): Promise<{ bytes: number } | { lost: true }> => {
    if (await cardLost()) return { lost: true };
    const bytes = await downloadMedia(polled.url, MAX_VIDEO_BYTES);
    if (!bytes) {
      const have = await storedVideoBytes(sb, rawPath);
      if (have) return { bytes: have };
      throw new Error(`generate-video: could not download the mp4 (${filename})`);
    }
    const { error: upErr } = await sb.storage
      .from(DURABLE_VIDEO_BUCKET)
      .upload(rawPath, Buffer.from(bytes), { contentType: "video/mp4", upsert: true });
    if (upErr) throw new Error(`artifact upload failed (${filename}): ${upErr.message}`);
    return { bytes: bytes.byteLength };
  });
  if ("lost" in staged) {
    logger.warn(`generate-video: card was taken over before its video was stored; not delivered, not charged`);
    return { skipped: "lease_lost" };
  }

  const finish: FinishOutcome =
    finishMode(intake) !== "full"
      ? { finished: false, reason: "not_needed" }
      : await step.run("finish-routed-video", () =>
          finishStagedVideo(sb, {
            tenant_id,
            run_id,
            target,
            words: spokenWords,
            videoSeconds: polled.duration_s,
            hook: intake.hook,
            rawPath,
            finishedPath: editedPath,
            logger,
          }),
        );
  const deliveredPath = finish.finished ? editedPath : rawPath;
  const deliveredBytes = finish.finished && finish.bytes ? finish.bytes : staged.bytes;

  const deliveredRaw = await step.run("deliver-routed", async (): Promise<{ stored: boolean; card: string | null }> => {
    if (await cardLost()) return { stored: false, card: "lease_lost" };
    const deliveredBy = studio?.retry_of ? await priorStudioRunDelivered(sb, tenant_id, studio) : null;
    if (studio && deliveredBy) {
      await handDraftBackToDeliveredRun(sb, tenant_id, run_id, studio, deliveredBy);
      return { stored: false, card: "already_delivered" };
    }
    const storeRow = async (): Promise<boolean> => {
      const { error: rowErr } = await sb.from("run_artifacts").upsert(
        {
          tenant_id,
          run_id,
          storage_path: deliveredPath,
          bucket: DURABLE_VIDEO_BUCKET,
          filename: name,
          mime: "video/mp4",
          bytes: deliveredBytes,
          agent_slug: "operator",
        },
        { onConflict: "tenant_id,run_id,filename" },
      );
      if (!rowErr) return true;
      if (target.kind === "chat") throw new Error(`run_artifacts upsert failed (${filename}): ${rowErr.message}`);
      logger.warn(`generate-video: run_artifacts upsert failed (${filename}): ${rowErr.message}`);
      return false;
    };

    if (target.kind === "channel_action") {
      const settled = await setChannelActionVideoMedia(tenant_id, {
        actionId: target.action_id,
        runId: run_id,
        claimId: target.claim_id,
        ok: true,
        media: {
          kind: "video",
          storage_path: deliveredPath,
          bucket: DURABLE_VIDEO_BUCKET,
          filename: name,
          alt: "AI-generated video",
          ai_generated: true,
        },
      });
      if (settled.ok && finish.finished) {
        await sb.storage
          .from(DURABLE_VIDEO_BUCKET)
          .remove([rawPath])
          .catch(() => undefined);
      }
      if (!settled.ok) return { stored: false, card: settled.code ?? "refused" };
      return { stored: await storeRow(), card: "delivered" };
    }
    const stored = await storeRow();
    if (target.kind === "chat") {
      await deliverArtifactToThread({
        tenant_id,
        thread_id: target.thread_id,
        run_id,
        body: "Your video is ready, attached below.",
        meta: { kind: "generative_video", intent: intake.intent },
      });
      return { stored, card: null };
    }
    const file = await sb.storage.from(DURABLE_VIDEO_BUCKET).download(deliveredPath);
    if (file.error || !file.data) throw new Error(`generate-video: could not read the stored mp4 (${filename}): ${file.error?.message ?? "empty"}`);
    await uploadFileToThread({
      tenant_id,
      channel_id: target.channel_id,
      thread_ts: target.thread_ts,
      bytes: new Uint8Array(await file.data.arrayBuffer()),
      filename: name,
      title: name,
      team_id: target.team_id ?? undefined,
    });
    if (stored) {
      const { error: markErr } = await sb
        .from("run_artifacts")
        .update({ slack_delivered: true })
        .eq("tenant_id", tenant_id)
        .eq("run_id", run_id)
        .eq("filename", name);
      if (markErr) logger.warn(`generate-video: slack_delivered mark failed (${filename}): ${markErr.message}`);
    }
    return { stored, card: null };
  });
  const delivered =
    typeof deliveredRaw === "boolean" ? { stored: deliveredRaw, card: null } : (deliveredRaw as { stored: boolean; card: string | null });

  if (target.kind === "channel_action" && delivered.card !== "delivered") {
    logger.warn(`generate-video: card ${target.action_id} refused the video (${delivered.card}); not charged`);
    return { skipped: "card_refused" };
  }
  if (delivered.card === "lease_lost") {
    logger.warn(`generate-video: run ${run_id} was replaced before delivery; not charged`);
    return { skipped: "lease_lost" };
  }
  if (delivered.card === "already_delivered") {
    await step.run("clear-pending-charges", () => clearPendingCharges(sb, run_id, meterKey));
    logger.warn(`generate-video: run ${run_id}'s video was already delivered and charged by the run it replaced; not delivered again, not charged`);
    return { skipped: "already_delivered" };
  }

  if (delivered.stored) {
    await step.run("track-media-generated", () => {
      trackMediaGenerated({ tenant_id, media: "video", kind: intake.intent });
    });
  }

  await step.run("flush-media-charges", () => flushCharges(charges));
  await step.run("clear-pending-charges", () => clearPendingCharges(sb, run_id, meterKey));

  if (target.kind === "channel_action") {
    await step.run("stage-youtube-upload", async () => {
      try {
        return await stageYouTubeUploadForCard(sb as unknown as UploadSb, {
          tenant_id,
          action_id: target.action_id,
          video_path: deliveredPath,
        });
      } catch (e) {
        logger.warn(`generate-video: YouTube upload card for ${target.action_id} not staged: ${(e as Error).message}`);
        return { staged: false, reason: "error" };
      }
    });
  }

  return { ok: true, model: job.model, intent: intake.intent };
}

export type StoredJob = JobRef & { intent?: string; origin?: string };

export const ADOPT_COMPLETED_MAX_AGE_MS = 45 * 60 * 1000;

export function videoDisplayName(intake: Partial<Pick<GenerativeVideoIntake, "hook" | "script" | "prompt">>, tag?: string): string {
  const firstLine = intake.script?.trim().split(/(?<=[.!?])\s+/)[0];
  const source = [intake.hook, firstLine, intake.prompt].find((t) => t?.trim()) ?? "";
  let title = source
    .replace(/[\u0000-\u001f\u007f/\\:*"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.,;!?-]+|[\s.,;-]+$/g, "");
  if (title.length > 60) {
    const cut = title.slice(0, 60);
    const space = cut.lastIndexOf(" ");
    title = `${(space >= 20 ? cut.slice(0, space) : cut).replace(/[\s.,;!?-]+$/, "")}\u2026`;
  }
  if (!title) title = "Video";
  return `${tag ? `${title} ${tag}` : title}.mp4`;
}

export function videoIntentKey(intake: GenerativeVideoIntake): string {
  const parts = ["v1", intake.intent, intake.prompt, intake.script ?? "", narrowAspect(intake.aspect_ratio), intake.premium ? "1" : "0"];
  if (intake.image_path) parts.push(intake.image_path);
  if (intake.portrait_path) parts.push(`portrait:${intake.portrait_path}`);
  return mediaSlotHash(...parts);
}

export function parseJobRef(raw: string | null | undefined): StoredJob | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as StoredJob;
    return j && typeof j === "object" && typeof j.vendor === "string" && typeof j.model === "string" && typeof j.id === "string" ? j : null;
  } catch {
    return null;
  }
}

function portraitRequest(intake: GenerativeVideoIntake): MediaRequest {
  return {
    prompt: talkingHeadPortraitPrompt(intake.prompt, intake.presenter_gender),
    aspect_ratio: narrowAspect(intake.aspect_ratio),
  };
}
function voiceRequest(intake: GenerativeVideoIntake): MediaRequest {
  return {
    text: intake.script ?? "",
    voice: resolvePresenterVoice({ gender: intake.presenter_gender, voice: intake.voice }),
    voice_stability: TALKING_HEAD_VOICE_STABILITY,
    voice_timestamps: true,
  };
}

export type AdoptedVideo = {
  job: StoredJob;
  legs: Array<{ surface: "gen-image" | "gen-vo"; task: MediaTask; model: string; cost_usd: number }>;
};

type JobRowLite = { meter_key: string; job_id: string | null; status: string; error: string | null; updated_at: string | null };

export async function adoptPriorCardVideo(
  sb: Sb,
  a: {
    tenant_id: string;
    run_id: string;
    target: ChannelActionDeliveryTarget;
    meterKey: string;
    intentKey: string;
    intake: GenerativeVideoIntake;
    now?: number;
  },
): Promise<AdoptedVideo | null> {
  const now = a.now ?? Date.now();
  const prior = await sb
    .from("generative_video_jobs")
    .select("meter_key,job_id,status,error,updated_at")
    .eq("tenant_id", a.tenant_id)
    .eq("run_id", a.run_id)
    .like("meter_key", `ca-${a.target.action_id}-%:gen-video:0`)
    .order("updated_at", { ascending: false })
    .limit(10);
  if (prior.error) throw new Error(`generate-video: prior attempts read failed: ${prior.error.message}`);
  const rows = ((prior.data ?? []) as JobRowLite[]).map((r): PriorJobRow => ({ ...r, run_id: a.run_id }));
  return adoptFirstLive(sb, rows, { ...a, now }, () => a.run_id);
}

type PriorJobRow = JobRowLite & { run_id: string };

export async function studioRetryChain(sb: Sb, tenant_id: string, draft_message_id: string, first: string): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let next: string | null = first;
  while (next && !seen.has(next) && seen.size < STUDIO_RETRY_CHAIN_MAX) {
    seen.add(next);
    const r = await sb
      .from("agent_runs")
      .select("payload")
      .eq("id", next)
      .eq("tenant_id", tenant_id)
      .maybeSingle<{ payload: StudioRunPayload | null }>();
    if (r.error) throw new Error(`generate-video: prior studio run read failed: ${r.error.message}`);
    const prior = studioRenderOf(r.data?.payload);
    if (!prior || prior.draft_message_id !== draft_message_id) break;
    ids.push(next);
    next = prior.retry_of;
  }
  return ids;
}

export async function priorStudioRunDelivered(sb: Sb, tenant_id: string, studio: StudioRender): Promise<string | null> {
  if (!studio.retry_of) return null;
  const chain = await studioRetryChain(sb, tenant_id, studio.draft_message_id, studio.retry_of);
  if (chain.length === 0) return null;
  const hit = await sb.from("run_artifacts").select("run_id").eq("tenant_id", tenant_id).in("run_id", chain).like("mime", "video/%").limit(1);
  if (hit.error) throw new Error(`generate-video: prior studio delivery read failed: ${hit.error.message}`);
  return ((hit.data ?? []) as Array<{ run_id: string }>)[0]?.run_id ?? null;
}

export async function handDraftBackToDeliveredRun(sb: Sb, tenant_id: string, run_id: string, studio: StudioRender, delivered_run_id: string): Promise<void> {
  const r = await sb
    .from("agent_thread_messages")
    .select("meta")
    .eq("tenant_id", tenant_id)
    .eq("thread_id", studio.thread_id)
    .eq("id", studio.draft_message_id)
    .maybeSingle<{ meta: Record<string, unknown> | null }>();
  if (r.error) throw new Error(`generate-video: studio draft read failed: ${r.error.message}`);
  const meta = r.data?.meta ?? null;
  if (!meta || meta.render_run_id !== run_id) return;
  const w = await sb
    .from("agent_thread_messages")
    .update({ meta: { ...meta, render_run_id: delivered_run_id } })
    .eq("tenant_id", tenant_id)
    .eq("thread_id", studio.thread_id)
    .eq("id", studio.draft_message_id)
    .eq("meta->>render_run_id", run_id);
  if (w?.error) throw new Error(`generate-video: studio draft update failed: ${w.error.message}`);
}

export async function adoptPriorStudioVideo(
  sb: Sb,
  a: {
    tenant_id: string;
    run_id: string;
    prior_run_id: string;
    draft_message_id: string;
    meterKey: string;
    intentKey: string;
    intake: GenerativeVideoIntake;
    now?: number;
  },
): Promise<AdoptedVideo | null> {
  const now = a.now ?? Date.now();
  const chain = await studioRetryChain(sb, a.tenant_id, a.draft_message_id, a.prior_run_id);
  if (chain.length === 0) return null;
  const prior = await sb
    .from("generative_video_jobs")
    .select("run_id,meter_key,job_id,status,error,updated_at")
    .eq("tenant_id", a.tenant_id)
    .in("run_id", chain)
    .order("updated_at", { ascending: false })
    .limit(STUDIO_RETRY_CHAIN_MAX * 4);
  if (prior.error) throw new Error(`generate-video: prior attempts read failed: ${prior.error.message}`);
  const rows = ((prior.data ?? []) as PriorJobRow[]).filter((r) => r.meter_key === `${r.run_id}:gen-video:0`);
  return adoptFirstLive(sb, rows, { ...a, now }, (_row, origin) => origin);
}

async function adoptFirstLive(
  sb: Sb,
  rows: PriorJobRow[],
  a: { tenant_id: string; run_id: string; meterKey: string; intentKey: string; intake: GenerativeVideoIntake; now: number },
  legsRunOf: (row: PriorJobRow, origin: string) => string,
): Promise<AdoptedVideo | null> {
  const now = a.now;
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.meter_key === a.meterKey) continue;
    const job = parseJobRef(row.job_id);
    if (!job || (job.intent !== undefined && job.intent !== a.intentKey)) continue;
    if (row.status === "failed" && !/poll timeout/.test(row.error ?? "")) continue;
    if (row.status !== "pending" && row.status !== "completed" && row.status !== "failed") continue;
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    const at = Date.parse(row.updated_at ?? "");
    const maxAge = row.status === "pending" ? IN_FLIGHT_WINDOW_MS : ADOPT_COMPLETED_MAX_AGE_MS;
    if (!Number.isFinite(at) || now - at > maxAge) continue;
    const p = await pollMediaOnce(job);
    if (p.state === "failed") {
      const f = await sb
        .from("generative_video_jobs")
        .update({ status: "failed", error: `adopt check: ${p.error}`.slice(0, 300), updated_at: new Date(now).toISOString() })
        .eq("run_id", row.run_id)
        .eq("meter_key", row.meter_key);
      if (f?.error) throw new Error(`generate-video: prior attempt update failed: ${f.error.message}`);
      continue;
    }
    const origin = job.origin ?? row.meter_key.replace(/:gen-video:0$/, "");
    const stored: StoredJob = { ...job, intent: a.intentKey, origin };
    const w = await sb
      .from("generative_video_jobs")
      .upsert(
        { tenant_id: a.tenant_id, run_id: a.run_id, meter_key: a.meterKey, model: job.model, job_id: JSON.stringify(stored), status: "pending" },
        { onConflict: "run_id,meter_key" },
      );
    if (w?.error) throw new Error(`generate-video: adopt write failed: ${w.error.message}`);
    return { job: stored, legs: a.intake.intent === "talking_head" ? await priorLegs(sb, legsRunOf(row, origin), origin, a.intake) : [] };
  }
  return null;
}

async function priorLegs(sb: Sb, run_id: string, origin: string, intake: GenerativeVideoIntake): Promise<AdoptedVideo["legs"]> {
  const legs: AdoptedVideo["legs"] = [];
  const specs = [
    { surface: "gen-image" as const, task: "image.photo" as MediaTask, req: portraitRequest(intake) },
    { surface: "gen-vo" as const, task: "audio.voiceover" as MediaTask, req: voiceRequest(intake) },
  ];
  for (const s of specs) {
    const r = await sb
      .from("generative_video_jobs")
      .select("job_id,status")
      .eq("run_id", run_id)
      .eq("meter_key", `${origin}:${s.surface}:0`)
      .maybeSingle<{ job_id: string | null; status: string }>();
    if (r.error) throw new Error(`generate-video: prior leg read failed: ${r.error.message}`);
    const job = parseJobRef(r.data?.job_id);
    if (!job || r.data?.status !== "completed") continue;
    legs.push({ surface: s.surface, task: s.task, model: job.model, cost_usd: costForJob(job, s.req, {}) });
  }
  return legs;
}

async function resumableLeg(
  sb: Sb,
  k: { tenant_id: string; run_id: string; meter_key: string },
  task: MediaTask,
  req: MediaRequest,
): Promise<MediaResult> {
  const prior = await sb
    .from("generative_video_jobs")
    .select("job_id,status")
    .eq("run_id", k.run_id)
    .eq("meter_key", k.meter_key)
    .maybeSingle<{ job_id: string | null; status: string }>();
  if (prior?.error) throw new Error(`generate-video: leg row read failed: ${prior.error.message}`);
  const resume = parseJobRef(prior?.data?.job_id) ?? undefined;
  let persisted = !!resume;
  const r = await generateMedia(task, req, {
    resume,
    onSubmitted: async (job) => {
      if (job.inline) return;
      const w = await sb
        .from("generative_video_jobs")
        .upsert(
          { tenant_id: k.tenant_id, run_id: k.run_id, meter_key: k.meter_key, model: job.model, job_id: JSON.stringify(job), status: "pending" },
          { onConflict: "run_id,meter_key" },
        );
      if (w?.error) throw new Error(w.error.message);
      persisted = true;
    },
  });
  if (persisted && r) {
    await sb
      .from("generative_video_jobs")
      .update({
        status: r.ok ? "completed" : "failed",
        result_url: r.ok && !r.url.startsWith("data:") ? r.url : null,
        error: r.ok ? null : r.error.slice(0, 300),
        updated_at: new Date().toISOString(),
      })
      .eq("run_id", k.run_id)
      .eq("meter_key", k.meter_key);
  }
  return r;
}

async function routedLeg<T>(
  step: Step,
  spec: { tenant_id: string; run_id: string; surface: PlatformGenerationSurface },
  gen: () => Promise<T>,
): Promise<{ decision: "charged"; result: T } | { decision: "meter_error" | "over_cap"; result: never }> {
  const gate = await step.run(`meter-routed-${spec.surface}-0`, () =>
    meterPlatformGeneration({ tenant_id: spec.tenant_id, run_id: spec.run_id, surface: spec.surface, index: 0 }),
  );
  if (gate.decision === "meter_error" || gate.decision === "over_cap") {
    return { decision: gate.decision } as { decision: "meter_error" | "over_cap"; result: never };
  }
  return { decision: "charged", result: (await step.run(`gen-routed-${spec.surface}-0`, gen)) as T };
}

export const ANIMATE_IMAGE_TTL_SECONDS = 60 * 60;

async function signAnimateImage(
  tenant_id: string,
  image_path: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string; copy: string }> {
  try {
    return { ok: true, url: await signOwnImageForVendor(tenant_id, image_path, ANIMATE_IMAGE_TTL_SECONDS) };
  } catch (e) {
    return { ok: false, error: `animate image: ${(e as Error).message}`, copy: "the image could not be read. Upload it again" };
  }
}

function routedFailureCopy(reason: MediaFailReason, intent: string, targetKind: VideoRenderTarget["kind"]): string {
  if (intent === "animate" && reason === "refused") {
    return "the video model will not animate photos of real people. Ask for a presenter video with this photo instead, for example \"make her the presenter for our business\"";
  }
  if (intent === "talking_head" && reason === "not_configured") return "talking-head videos aren't available yet";
  if (intent === "talking_head" && reason === "refused") {
    return targetKind === "channel_action"
      ? "the video model turned down the AI presenter it was given. Press Try again and Zavi will make a new presenter"
      : "the video model turned down the AI presenter it was given";
  }
  if (reason === "refused") return "the video model declined this request under its content policy";
  if (reason === "timeout") return "the video took too long to generate";
  if (reason === "out_of_credits") return "video generation is temporarily unavailable on our side. The team has been alerted, and this is not a limit on your workspace";
  return "the video generation didn't complete";
}

async function postRoutedFailure(
  tenant_id: string,
  target: VideoRenderTarget,
  run_id: string,
  msg: string,
  reason?: MediaFailReason,
  code?: string,
  httpStatus?: number,
): Promise<void> {
  if (reason === "out_of_credits") {
    void logEvent({
      level: "error",
      source: "workers.generate_video",
      code: "video_vendor_out_of_credits",
      tenant_id,
      run_id,
      meta: { failure_class: "vendor_out_of_credits", http_status: httpStatus ?? null },
    });
  }
  return postText(tenant_id, target, run_id, `Sorry, ${msg}. You were not charged for it.`, code);
}

type GenSpec = {
  tenant_id: string;
  run_id: string;
  surface: PlatformGenerationSurface;
  index: number;
  descriptor: ModelDescriptor;
  params: Record<string, unknown>;
};
type GenResult =
  | { status: "ok"; jobId: string; resultUrl: string }
  | { status: "meter_error" }
  | { status: "over_cap" }
  | { status: "failed"; error: string };

async function genStep(step: Step, sb: Sb, spec: GenSpec): Promise<GenResult> {
  const meter_key = `${spec.run_id}:${spec.surface}:${spec.index}`;

  const gate = await step.run(`meter-${spec.surface}-${spec.index}`, () =>
    meterPlatformGeneration({ tenant_id: spec.tenant_id, run_id: spec.run_id, surface: spec.surface, index: spec.index }),
  );
  if (gate.decision === "meter_error") return { status: "meter_error" };
  if (gate.decision === "over_cap") return { status: "over_cap" };

  const submit = await step.run(`submit-${spec.surface}-${spec.index}`, async (): Promise<{ jobId: string; resultUrl?: string } | { error: string }> => {
    const existing = await sb
      .from("generative_video_jobs")
      .select("job_id,status,result_url")
      .eq("run_id", spec.run_id)
      .eq("meter_key", meter_key)
      .maybeSingle<{ job_id: string | null; status: string; result_url: string | null }>();
    if (existing.data?.status === "completed" && existing.data.result_url) {
      return { jobId: existing.data.job_id ?? "", resultUrl: existing.data.result_url };
    }
    if (existing.data?.job_id) {
      return { jobId: existing.data.job_id };
    }
    const s = await submitGeneration(submitPathFor(spec.descriptor), spec.params);
    if (!s.ok) return { error: s.error };
    await sb.from("generative_video_jobs").upsert(
      { tenant_id: spec.tenant_id, run_id: spec.run_id, meter_key, model: spec.descriptor.model, job_id: s.jobId, status: "pending" },
      { onConflict: "run_id,meter_key" },
    );
    return { jobId: s.jobId };
  });
  if ("error" in submit) return { status: "failed", error: submit.error };
  if (submit.resultUrl) return { status: "ok", jobId: submit.jobId, resultUrl: submit.resultUrl };

  const poll = await step.run(`poll-${spec.surface}-${spec.index}`, async (): Promise<{ resultUrl: string } | { error: string }> => {
    for (let i = 0; i < spec.descriptor.pollCeiling.attempts; i++) {
      await sleep(spec.descriptor.pollCeiling.delayMs);
      const r = await pollGenerationOnce(submit.jobId);
      if (r.ok) return { resultUrl: r.resultUrl };
      if (!("pending" in r) || r.pending !== true) return { error: r.error };
    }
    return { error: "poll timeout" };
  });
  if ("error" in poll) {
    await sb.from("generative_video_jobs").update({ status: "failed", error: poll.error, updated_at: new Date().toISOString() }).eq("run_id", spec.run_id).eq("meter_key", meter_key);
    return { status: "failed", error: poll.error };
  }
  await sb.from("generative_video_jobs").update({ status: "completed", result_url: poll.resultUrl, updated_at: new Date().toISOString() }).eq("run_id", spec.run_id).eq("meter_key", meter_key);
  return { status: "ok", jobId: submit.jobId, resultUrl: poll.resultUrl };
}

async function postFailure(
  tenant_id: string,
  target: VideoRenderTarget,
  run_id: string,
  msg: string,
): Promise<void> {
  return postText(tenant_id, target, run_id, `Sorry, ${msg}. No credits were used for a failed generation.`);
}

async function postText(tenant_id: string, target: VideoRenderTarget, run_id: string, text: string, code?: string): Promise<void> {
  if (target.kind === "channel_action") {
    await setChannelActionVideoMedia(tenant_id, {
      actionId: target.action_id,
      runId: run_id,
      claimId: target.claim_id,
      ok: false,
      error: text,
      code: code ?? null,
    });
    return;
  }
  try {
    if (target.kind === "chat") {
      await deliverArtifactToThread({
        tenant_id,
        thread_id: target.thread_id,
        run_id,
        body: text,
        meta: code ? { kind: "generative_video_failed", code } : { kind: "generative_video_failed" },
      });
      return;
    }
    await callSlackTool(
      tenant_id,
      "post_message",
      { channel_id: target.channel_id, thread_ts: target.thread_ts, text },
      target.team_id ?? undefined,
    );
  } catch {
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
