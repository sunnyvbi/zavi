import { createHash, randomUUID } from "node:crypto";
import { isGenerativeVideoEnabled } from "@/services/agents/_render-launch-video-flag-check";
import { checkAgentTier, planUpgradeMessage } from "@/services/agents/entitlement";
import { getCompanyFacts } from "@/services/company/facts";
import { isMediaRouterEnabled } from "@/services/media-router/router";
import { checkOwnImageForVendor } from "@/services/chat-images/sign-own-image";
import { isChannelLockedStrict } from "@/services/channels/lock";
import { checkAffordMedia, type AffordCheck } from "@/services/media-router/charge";
import { refusalFor } from "@/services/agents/refusal";
import { lookAtPresenterPhoto, type PresenterPhotoLook } from "./photo-look";
import { VIDEO_RENDER_MAX_MS } from "@/services/launch-video/render-budget";
import { mentionsPresenter, TALKING_HEAD_MAX_WORDS, TALKING_HEAD_MIN_WORDS, type GenerativeVideoIntake } from "@/services/launch-video/generative-video-intake";
import { billedVideoCredits, billedVideoUsd, videoCreditsOf } from "@/services/launch-video/video-estimate";
import { NOT_ENOUGH_CREDITS } from "@/services/channels/generated-video-render";
import {
  ANIMATE_REPLY,
  ANIMATE_WITH_PROMPT_REPLY,
  animateDraft,
  asksForNewVideo,
  asksForDifferentPresenter,
  DIFFERENT_PRESENTER_REPLY,
  keepScriptNewPresenter,
  PHOTO_PRESENTER_HINT,
  PHOTO_PRESENTER_REPLY,
  SCRIPT_WRITER_HINT,
  scriptWords,
  VERBATIM_REPLY,
  VERBATIM_SCRIPT_HINT,
  verbatimDraft,
  DraftFailedError,
  reviseAnimateMotion,
  draftPolicyRefusal,
  draftToIntake,
  draftVideo,
  videoDraftSchema,
  type BusinessContext,
  type DraftDeps,
  type VideoDraft,
} from "./draft";

export const STUDIO_AGENT_SLUG = "generated_video_studio";
export const STUDIO_RUN_AGENT_SLUG = "generated_video";
export const MAX_PROMPT_CHARS = 2000;
export const HISTORY_LIMIT = 200;
export const RENDER_STALL_MS = 2 * VIDEO_RENDER_MAX_MS;
export const RENDER_QUEUE_MAX_MS = 6 * RENDER_STALL_MS;

export const DRAFT_FAILED_REPLY = "I couldn't turn that into a video. Try describing it another way.";
export const RENDERING_REPLY = "Making your video now. It usually takes a few minutes and appears here when it's ready.";
export const START_FAILED_REPLY =
  "Zavi could not confirm this video started. If it did, it will show on this ad in a few minutes, and you are only charged for a video that is made. If nothing shows, press Try again.";
export const VIDEO_OFF_REPLY = "Video making is switched off right now, so nothing was made and nothing was charged.";
export const CHANNEL_OFF_REPLY = "AI UGC Videos is switched off right now, so nothing was made and nothing was charged.";
export const LOCK_UNKNOWN_REPLY = "Zavi could not check whether video making is on, so nothing was made. Try again in a minute.";
export const FAILED_KIND = "generative_video_failed";
export const REQUEUED_KIND = "video_studio_requeued";
export const ENQUEUE_ATTEMPTS = 3;
export const DUPLICATE_SEND_REPLY = "This ad is already being made from another tab or request. It will show in your Overview in a moment.";
export const RENDER_CHECK_UNAVAILABLE_REPLY = "Zavi could not check this video just now. Try again in a minute.";
export const SUPERSEDED_REPLY = "A newer version of this ad exists. Nothing was made or charged.";
export const SEND_GUARD_UNAVAILABLE_REPLY = "Zavi could not send this safely, so nothing was made. Try again in a minute.";
export const SEND_WAIT_MS = 60_000;
export const SEND_POLL_MS = 250;
export const SEND_REPLAY_MS = 30_000;
export const SEND_STALE_MS = 10 * 60_000;

export type StudioMessageRow = {
  id: string;
  sender_role: "user" | "assistant" | "system";
  body: string;
  meta: Record<string, unknown>;
  attachments?: unknown;
  agent_run_id: string | null;
  created_at: string;
};

export type VideoArtifactRow = { id: string; run_id: string; filename: string | null };

export type StartedRunRow = { run_id: string; created_at: string };

export type StudioThreadRow = { id: string; title: string | null; created_at: string; last_message_at: string | null };

export type VideoKind = VideoDraft["intent"];

export type GalleryRunRow = { id: string; created_at: string; enqueued_by: string | null; studio_thread_id: string | null; intent?: VideoKind | null };

export type GalleryArtifactRow = { id: string; run_id: string; filename: string | null; created_at: string };

export type SendClaimRow = {
  token: string;
  claimed_at: string;
  status: "in_progress" | "done";
  result: unknown;
  completed_at: string | null;
};

export interface SendClaims {
  claim(user_id: string, key: string): Promise<string | null>;
  read(user_id: string, key: string): Promise<SendClaimRow | null>;
  settle(user_id: string, key: string, token: string, result: unknown): Promise<void>;
  release(user_id: string, key: string, token: string): Promise<void>;
  takeOver(user_id: string, key: string, seen_token: string): Promise<string | null>;
}

export interface StudioStore {
  sendClaims?: SendClaims;
  findThread(user_id: string): Promise<string | null>;
  getOwnThread?(user_id: string, thread_id: string): Promise<string | null>;
  listThreads?(user_id: string, limit: number): Promise<StudioThreadRow[]>;
  setThreadTitle?(thread_id: string, title: string): Promise<void>;
  listVideoRuns?(limit: number): Promise<GalleryRunRow[]>;
  listGalleryArtifacts?(run_ids: string[]): Promise<GalleryArtifactRow[]>;
  createThread(user_id: string): Promise<string>;
  listMessages(thread_id: string, limit: number): Promise<StudioMessageRow[]>;
  listRunMessages?(thread_id: string, run_id: string): Promise<StudioMessageRow[]>;
  getMessage(thread_id: string, message_id: string): Promise<StudioMessageRow | null>;
  insertMessage(m: {
    thread_id: string;
    sender_role: "user" | "assistant";
    body: string;
    meta?: Record<string, unknown>;
    attachments?: Array<{ path: string; kind: "image" }>;
    agent_run_id?: string | null;
  }): Promise<StudioMessageRow>;
  claimRender(thread_id: string, message_id: string, run_id: string | null, previous_run_id: string | null): Promise<boolean>;
  createRenderRun(a: { id: string; user_id: string; thread_id: string; message_id: string; retry_of?: string | null }): Promise<string>;
  listVideoArtifacts(run_ids: string[]): Promise<VideoArtifactRow[]>;
  listStartedRuns?(run_ids: string[]): Promise<StartedRunRow[]>;
}

export type StudioDeps = {
  store: StudioStore;
  draft: Partial<DraftDeps>;
  business: (tenant_id: string) => Promise<BusinessContext | null>;
  videoEnabled: (tenant_id: string) => Promise<boolean>;
  routerEnabled: () => Promise<boolean>;
  tier: (tenant_id: string) => Promise<{ allowed: boolean; required_tier: string; unverified?: boolean }>;
  send: (evt: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>;
  checkImage?: (tenant_id: string, image_path: string) => Promise<void>;
  lookAtPhoto?: (tenant_id: string, image_path: string) => Promise<PresenterPhotoLook | null>;
  channelLocked?: () => Promise<boolean>;
  now?: () => number;
  afford?: (tenant_id: string, cost_usd: number) => Promise<AffordCheck>;
  inFlightVideoUsd?: (tenant_id: string) => Promise<number>;
  sendWaitMs?: number;
};

export class StudioError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function defaultSend(evt: { id: string; name: string; data: Record<string, unknown> }): Promise<unknown> {
  const { inngest } = await import("@/../workers/client");
  return inngest.send(evt as never);
}

export async function readBusinessContext(tenant_id: string): Promise<BusinessContext | null> {
  try {
    const f = await getCompanyFacts(tenant_id);
    const ctx: BusinessContext = {
      name: f.name,
      what_we_sell: f.facts.what_we_sell?.value ?? null,
      website: f.website,
    };
    return ctx.name || ctx.what_we_sell || ctx.website ? ctx : null;
  } catch (e) {
    console.warn(`[video-studio] company facts read failed: ${(e as Error).message}`);
    return null;
  }
}

export function defaultStudioDeps(store: StudioStore): StudioDeps {
  return {
    store,
    draft: {},
    business: readBusinessContext,
    videoEnabled: (t) => isGenerativeVideoEnabled(t),
    routerEnabled: isMediaRouterEnabled,
    tier: (t) => checkAgentTier(t, STUDIO_RUN_AGENT_SLUG),
    send: defaultSend,
    checkImage: checkOwnImageForVendor,
    lookAtPhoto: lookAtPresenterPhoto,
    channelLocked: () => isChannelLockedStrict(STUDIO_RUN_AGENT_SLUG),
    afford: checkAffordMedia,
    inFlightVideoUsd: defaultInFlightVideoUsd,
  };
}

async function defaultInFlightVideoUsd(tenant_id: string): Promise<number> {
  const { tenantInFlightVideoUsd } = await import("@/../workers/functions/generate-video");
  return tenantInFlightVideoUsd(tenant_id);
}

export const MIN_CREDIT_USD = 0.0025;

function assertScriptLength(script: string): void {
  const words = scriptWords(script);
  if (words >= TALKING_HEAD_MIN_WORDS && words <= TALKING_HEAD_MAX_WORDS) return;
  throw new StudioError(
    400,
    "script_length",
    `A word-for-word script needs ${TALKING_HEAD_MIN_WORDS} to ${TALKING_HEAD_MAX_WORDS} words. This one has ${words}.`,
  );
}

async function assertHasCredits(deps: StudioDeps, tenant_id: string): Promise<void> {
  if (!deps.afford) return;
  if ((await deps.afford(tenant_id, MIN_CREDIT_USD)) !== "short") return;
  const r = refusalFor({ kind: "credits" });
  throw new StudioError(402, r.code, r.message);
}

export const NOT_ENOUGH_WITH_VIDEOS_AHEAD = (credits: number) =>
  `This video costs about ${credits.toLocaleString("en-US")} credits and your workspace doesn't have that many left once the videos already being made are paid for. Top up credits, then press Try again. Nothing was made and nothing was charged.`;

async function videosAheadUsd(deps: StudioDeps, tenant_id: string): Promise<number> {
  if (!deps.inFlightVideoUsd) return 0;
  try {
    const usd = await deps.inFlightVideoUsd(tenant_id);
    return Number.isFinite(usd) && usd > 0 ? usd : 0;
  } catch (e) {
    console.warn(`[video-studio] in-flight videos read failed: ${(e as Error).message}`);
    return 0;
  }
}

async function assertCanAffordVideo(deps: StudioDeps, tenant_id: string, intake: GenerativeVideoIntake): Promise<void> {
  if (!deps.afford) return;
  const usd = await billedVideoUsd(intake);
  const ahead = await videosAheadUsd(deps, tenant_id);
  if ((await deps.afford(tenant_id, Math.round((usd + ahead) * 10000) / 10000)) !== "short") return;
  const credits = videoCreditsOf(usd);
  if (ahead > 0 && (await deps.afford(tenant_id, usd)) !== "short") {
    throw new StudioError(402, "insufficient_credits", NOT_ENOUGH_WITH_VIDEOS_AHEAD(credits), {
      required_credits: credits,
      reason: "videos_ahead",
      ahead_credits: videoCreditsOf(ahead),
    });
  }
  throw new StudioError(402, "insufficient_credits", NOT_ENOUGH_CREDITS(credits), { required_credits: credits });
}

const CHEAPEST_STUDIO_INTAKES: GenerativeVideoIntake[] = [
  { prompt: "x", intent: "animate", premium: false, image_path: "x" },
  { prompt: "x", intent: "social", premium: false, aspect_ratio: "9:16" },
  { prompt: "x", intent: "cinematic", premium: false, aspect_ratio: "9:16" },
  { prompt: "x", intent: "talking_head", premium: false, aspect_ratio: "9:16", script: "w", avatar_tier: "standard", portrait_path: "x" },
];

export async function cheapestStudioVideoUsd(): Promise<number> {
  return Math.min(...(await Promise.all(CHEAPEST_STUDIO_INTAKES.map((i) => billedVideoUsd(i)))));
}

export const NOT_ENOUGH_FOR_ANY_VIDEO = (credits: number) =>
  `A video costs at least ${credits.toLocaleString("en-US")} credits and your workspace has fewer than that right now. Top up credits, then press Try again. Nothing was made and nothing was charged.`;

async function assertCanAffordAnyVideo(deps: StudioDeps, tenant_id: string): Promise<void> {
  if (!deps.afford) return;
  const usd = await cheapestStudioVideoUsd();
  if ((await deps.afford(tenant_id, usd)) !== "short") return;
  const credits = videoCreditsOf(usd);
  throw new StudioError(402, "insufficient_credits", NOT_ENOUGH_FOR_ANY_VIDEO(credits), { required_credits: credits });
}

async function assertDraftAffordable(deps: StudioDeps, tenant_id: string, draft: VideoDraft, request: string | null): Promise<void> {
  if (draftPolicyRefusal(draft, "") || (request !== null && draftPolicyRefusal(draft, request))) return;
  const intake = draftToIntake(draft);
  if (intake.ok) await assertCanAffordVideo(deps, tenant_id, intake.intake);
}

export type VideoGateDeps = Pick<StudioDeps, "tier" | "videoEnabled" | "routerEnabled" | "channelLocked">;

export async function assertCanMakeVideo(deps: VideoGateDeps, tenant_id: string): Promise<void> {
  const d = await deps.tier(tenant_id);
  if (d.unverified) throw new StudioError(503, "video_unavailable", LOCK_UNKNOWN_REPLY);
  if (!d.allowed) {
    throw new StudioError(403, "plan_upgrade_required", planUpgradeMessage(STUDIO_RUN_AGENT_SLUG, d.required_tier as never), {
      required_tier: d.required_tier,
    });
  }
  if (!(await deps.routerEnabled()) || !(await deps.videoEnabled(tenant_id))) {
    throw new StudioError(503, "video_unavailable", VIDEO_OFF_REPLY);
  }
  if (deps.channelLocked) {
    let locked: boolean;
    try {
      locked = await deps.channelLocked();
    } catch {
      throw new StudioError(503, "video_unavailable", LOCK_UNKNOWN_REPLY);
    }
    if (locked) throw new StudioError(503, "video_unavailable", CHANNEL_OFF_REPLY);
  }
}

export type ThreadChoice = { thread_id?: string | null; new_thread?: boolean };

async function ownThread(store: StudioStore, user_id: string, thread_id: string): Promise<string> {
  const own = store.getOwnThread ? await store.getOwnThread(user_id, thread_id) : null;
  if (!own) throw new StudioError(404, "thread_not_found", "That ad is not yours or no longer exists.");
  return own;
}

export const MAX_TITLE_CHARS = 60;

export function threadTitle(text: string, hasImage: boolean, presenter = false): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return presenter ? "Presenter video" : hasImage ? "Animated image" : "New video";
  const sentence = t.match(new RegExp(`^[\\s\\S]{1,${MAX_TITLE_CHARS - 1}}?[.!?](?=\\s|$)`));
  if (sentence) return sentence[0];
  if (t.length <= MAX_TITLE_CHARS) return t;
  const head = t.slice(0, MAX_TITLE_CHARS);
  const words = head.replace(/\s+\S*$/, "");
  const cut = words === head ? t.slice(0, MAX_TITLE_CHARS - 1) : words;
  return `${cut.replace(/[\s,;:]+$/, "")}…`;
}

export function storedDraft(m: StudioMessageRow | null | undefined): VideoDraft | null {
  if (!m || m.sender_role !== "assistant") return null;
  const parsed = videoDraftSchema.safeParse(m.meta?.video_draft);
  return parsed.success ? parsed.data : null;
}

export function latestDraftMessage(rows: StudioMessageRow[]): StudioMessageRow | null {
  const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return sorted.find((r) => storedDraft(r) !== null) ?? null;
}

export function latestDraft(rows: StudioMessageRow[]): VideoDraft | null {
  return storedDraft(latestDraftMessage(rows));
}

export type RenderOutcome = { run_id: string; rendering_message: StudioMessageRow } | { error: string; code: string };

function renderIntake(draft: VideoDraft): { intake: GenerativeVideoIntake } | { error: string; code: string } {
  const refusal = draftPolicyRefusal(draft, "");
  if (refusal) return { error: refusal.message, code: `refused_${refusal.code}` };
  const intake = draftToIntake(draft);
  if (!intake.ok) return { error: intake.message, code: "invalid_draft" };
  return { intake: intake.intake };
}

async function renderDraft(
  deps: StudioDeps,
  a: { tenant_id: string; user_id: string; thread_id: string; message_id: string; draft: VideoDraft; previous_run_id: string | null },
): Promise<RenderOutcome> {
  const intake = renderIntake(a.draft);
  if ("error" in intake) return intake;

  const run_id = randomUUID();
  if (!(await deps.store.claimRender(a.thread_id, a.message_id, run_id, a.previous_run_id))) {
    return { error: "This video is already being made.", code: "already_rendered" };
  }
  let rendering_message: StudioMessageRow;
  try {
    await deps.store.createRenderRun({ id: run_id, user_id: a.user_id, thread_id: a.thread_id, message_id: a.message_id, retry_of: a.previous_run_id });
    rendering_message = await deps.store.insertMessage({
      thread_id: a.thread_id,
      sender_role: "assistant",
      body: RENDERING_REPLY,
      agent_run_id: run_id,
      meta: { kind: "video_studio_rendering", draft_message_id: a.message_id },
    });
  } catch (e) {
    await deps.store.claimRender(a.thread_id, a.message_id, a.previous_run_id, run_id).catch(() => false);
    throw e;
  }
  return enqueueRender(deps, { tenant_id: a.tenant_id, thread_id: a.thread_id, run_id, intake: intake.intake, rendering_message });
}

async function enqueueRender(
  deps: StudioDeps,
  a: { tenant_id: string; thread_id: string; run_id: string; intake: unknown; rendering_message: StudioMessageRow },
): Promise<RenderOutcome> {
  const event = {
    id: `video-generate-${a.run_id}`,
    name: "video.generate.requested",
    data: {
      run_id: a.run_id,
      tenant_id: a.tenant_id,
      intake: a.intake as Record<string, unknown>,
      delivery_target: { kind: "chat", thread_id: a.thread_id },
    },
  };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < ENQUEUE_ATTEMPTS; attempt++) {
    try {
      await deps.send(event);
      return { run_id: a.run_id, rendering_message: a.rendering_message };
    } catch (e) {
      lastError = e;
    }
  }
  console.warn(`[video-studio] enqueue failed: ${(lastError as Error)?.message}`);
  await deps.store.insertMessage({
    thread_id: a.thread_id,
    sender_role: "assistant",
    body: START_FAILED_REPLY,
    meta: { artifact_delivery: true, source_run_id: a.run_id, kind: FAILED_KIND, code: "enqueue_failed" },
  });
  return { error: START_FAILED_REPLY, code: "enqueue_failed" };
}

async function requeueRender(
  deps: StudioDeps,
  a: { tenant_id: string; thread_id: string; run_id: string; intake: GenerativeVideoIntake; rendering_message: StudioMessageRow },
): Promise<RenderOutcome> {
  const out = await enqueueRender(deps, a);
  if ("error" in out) return out;
  await deps.store.insertMessage({ thread_id: a.thread_id, sender_role: "assistant", body: RENDERING_REPLY, meta: { kind: REQUEUED_KIND, source_run_id: a.run_id } });
  return out;
}

async function assertOwnImage(deps: StudioDeps, tenant_id: string, image_path: string): Promise<void> {
  try {
    await (deps.checkImage ?? checkOwnImageForVendor)(tenant_id, image_path);
  } catch (e) {
    const code = typeof (e as { code?: unknown }).code === "string" ? ((e as { code: string }).code) : "image_unavailable";
    throw new StudioError(400, code, (e as Error).message || "That image could not be read. Upload it again.");
  }
}

async function insertDraftAndRender(
  deps: StudioDeps,
  a: { tenant_id: string; user_id: string; thread_id: string; user_message: StudioMessageRow; reply: string; draft: VideoDraft; request: string },
): Promise<{ thread_id: string; user_message: StudioMessageRow; reply: StudioMessageRow; render: RenderOutcome | null }> {
  const refusal = draftPolicyRefusal(a.draft, a.request);
  if (refusal) {
    const reply = await deps.store.insertMessage({ thread_id: a.thread_id, sender_role: "assistant", body: refusal.message, meta: { kind: "video_studio_refused", code: refusal.code } });
    return { thread_id: a.thread_id, user_message: a.user_message, reply, render: null };
  }
  const reply = await deps.store.insertMessage({
    thread_id: a.thread_id,
    sender_role: "assistant",
    body: a.reply,
    meta: { kind: "video_studio_draft", video_draft: a.draft },
  });
  const render = await renderDraft(deps, {
    tenant_id: a.tenant_id,
    user_id: a.user_id,
    thread_id: a.thread_id,
    message_id: reply.id,
    draft: a.draft,
    previous_run_id: null,
  });
  return { thread_id: a.thread_id, user_message: a.user_message, reply, render };
}

export type SendResult = { thread_id: string; user_message: StudioMessageRow; reply: StudioMessageRow; render: RenderOutcome | null };

export function sendKey(a: { text: string; image_path: string | null; verbatim?: boolean } & ThreadChoice): string {
  const target = a.new_thread ? "new" : a.thread_id || "latest";
  const parts: unknown[] = [target, a.text, a.image_path];
  if (a.verbatim) parts.push("verbatim");
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function startedRender(result: unknown): boolean {
  const render = (result as { render?: unknown } | null)?.render;
  return !!render && typeof (render as { run_id?: unknown }).run_id === "string";
}

const ageMs = (now: number, at: string | null): number => (at ? now - Date.parse(at) : Number.POSITIVE_INFINITY);

async function holdSend(deps: StudioDeps, claims: SendClaims, user_id: string, key: string): Promise<{ token: string } | { replay: SendResult }> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.sendWaitMs ?? SEND_WAIT_MS);
  let sawInProgress = false;
  for (;;) {
    const token = await claims.claim(user_id, key);
    if (token) return { token };
    const row = await claims.read(user_id, key);
    if (row?.status === "done") {
      if (sawInProgress || (startedRender(row.result) && ageMs(now(), row.completed_at) < SEND_REPLAY_MS)) return { replay: row.result as SendResult };
      const taken = await claims.takeOver(user_id, key, row.token);
      if (taken) return { token: taken };
    } else if (row && ageMs(now(), row.claimed_at) > SEND_STALE_MS) {
      const taken = await claims.takeOver(user_id, key, row.token);
      if (taken) return { token: taken };
    } else if (row) {
      sawInProgress = true;
    }
    if (now() >= deadline) throw new StudioError(409, "duplicate_send", DUPLICATE_SEND_REPLY);
    if (row?.status === "in_progress") await new Promise((r) => setTimeout(r, SEND_POLL_MS));
  }
}

export async function sendStudioMessage(
  deps: StudioDeps,
  a: { tenant_id: string; user_id: string; text: string; image_path?: string | null; verbatim?: boolean } & ThreadChoice,
): Promise<SendResult> {
  const text = a.text.trim();
  const image_path = a.image_path?.trim() || null;
  const verbatim = a.verbatim === true && !image_path;
  if (!text && !image_path) throw new StudioError(400, "empty_message", "Type what the video should be, or attach an image.");
  if (text.length > MAX_PROMPT_CHARS) throw new StudioError(400, "message_too_long", `Keep it under ${MAX_PROMPT_CHARS} characters.`);
  if (verbatim) assertScriptLength(text);
  await assertCanMakeVideo(deps, a.tenant_id);
  await assertCanAffordAnyVideo(deps, a.tenant_id);
  if (image_path) await assertOwnImage(deps, a.tenant_id, image_path);
  const claims = deps.store.sendClaims;
  if (!claims) return composeAndRender(deps, a, text, image_path, verbatim);
  const key = sendKey({ text, image_path, verbatim, thread_id: a.thread_id, new_thread: a.new_thread });
  let held: { token: string } | { replay: SendResult };
  try {
    held = await holdSend(deps, claims, a.user_id, key);
  } catch (e) {
    if (e instanceof StudioError) throw e;
    console.warn(`[video-studio] send claim failed: ${(e as Error).message}`);
    throw new StudioError(503, "send_guard_unavailable", SEND_GUARD_UNAVAILABLE_REPLY);
  }
  if ("replay" in held) return held.replay;
  let out: SendResult;
  try {
    out = await composeAndRender(deps, a, text, image_path, verbatim);
  } catch (e) {
    await claims.release(a.user_id, key, held.token).catch(() => undefined);
    throw e;
  }
  await settleWithRetry(claims, a.user_id, key, held.token, out);
  return out;
}

const PROMPT_SELLS_CHARS = 300;

const PROMPT_ANGLES: ReadonlyArray<(site: string | null) => string> = [
  (site) => "Open with the problem our customer has, show how we solve it, and end with one clear next step" + (site ? ` (visit ${site}).` : "."),
  (site) => "Start in a real moment from a customer's day, show where we fit in, and close by inviting them to try us" + (site ? ` at ${site}.` : "."),
  (site) => "Name the doubt that stops people from buying, answer it plainly, and end with an easy way to get started" + (site ? ` (go to ${site}).` : "."),
  (site) => "Lead with what someone gets today, say why now is a good time, and finish with one simple next step" + (site ? ` (visit ${site}).` : "."),
  (site) => "Take viewers behind the scenes of how we make or deliver it, share the detail we care about most, and end with where to find us" + (site ? ` (${site}).` : "."),
];

export const PROMPT_VARIANTS = PROMPT_ANGLES.length;

export function nextPromptVariant(after: number | null | undefined): number {
  if (after === null || after === undefined || !Number.isInteger(after) || after < 0) return 0;
  return (after + 1) % PROMPT_VARIANTS;
}

export function businessPrompt(b: BusinessContext | null, variant = 0): string {
  const name = b?.name?.trim() || null;
  const sells = b?.what_we_sell?.trim().replace(/\s+/g, " ").slice(0, PROMPT_SELLS_CHARS) || null;
  const site = b?.website?.trim() || null;
  const who = name ?? "my business";
  const lines = [`A short talking-head ad for ${who}.`];
  if (sells) lines.push(`${name ?? "We"} ${name ? "sells" : "sell"}: ${sells}`);
  const angle = PROMPT_ANGLES[Number.isInteger(variant) && variant >= 0 ? variant % PROMPT_VARIANTS : 0];
  lines.push(angle(site));
  return lines.join("\n");
}

export async function readStudioPrompt(deps: StudioDeps, a: { tenant_id: string; after?: number | null }): Promise<{ prompt: string; variant: number }> {
  const variant = nextPromptVariant(a.after);
  return { prompt: businessPrompt(await deps.business(a.tenant_id), variant), variant };
}

export const SCRIPT_FAILED_REPLY = "Zavi couldn't write a script for that. Try describing it another way.";
export const NO_SCRIPT_REPLY = "That reads like a scene, not something a presenter says. Tell Zavi what the presenter should talk about.";

export async function writeStudioScript(deps: StudioDeps, a: { tenant_id: string; prompt: string }): Promise<{ script: string }> {
  const prompt = a.prompt.trim();
  if (!prompt) throw new StudioError(400, "empty_prompt", "Type what the script should be about.");
  if (prompt.length > MAX_PROMPT_CHARS) throw new StudioError(400, "message_too_long", `Keep it under ${MAX_PROMPT_CHARS} characters.`);
  await assertCanMakeVideo(deps, a.tenant_id);
  await assertHasCredits(deps, a.tenant_id);
  const business = await deps.business(a.tenant_id);
  let outcome: Awaited<ReturnType<typeof draftVideo>>;
  try {
    outcome = await draftVideo(`${prompt}\n${SCRIPT_WRITER_HINT}`, null, business, deps.draft);
  } catch (e) {
    if (!(e instanceof DraftFailedError)) console.warn(`[video-studio] script call failed: ${(e as Error).message}`);
    throw new StudioError(502, "script_failed", SCRIPT_FAILED_REPLY);
  }
  if (outcome.kind === "refused") throw new StudioError(422, `refused_${outcome.code}`, outcome.reply);
  if (!outcome.draft.script) throw new StudioError(422, "no_script", NO_SCRIPT_REPLY);
  return { script: outcome.draft.script };
}

export const SEND_SETTLE_ATTEMPTS = 3;

async function settleWithRetry(claims: SendClaims, user_id: string, key: string, token: string, out: SendResult): Promise<void> {
  for (let attempt = 1; attempt <= SEND_SETTLE_ATTEMPTS; attempt++) {
    try {
      await claims.settle(user_id, key, token, out);
      return;
    } catch (e) {
      if (attempt === SEND_SETTLE_ATTEMPTS) {
        console.warn(`[video-studio] send settle failed after ${attempt} tries: ${(e as Error).message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
}

type ComposePlan =
  | { kind: "failed" }
  | { kind: "refused"; reply: string; code: string }
  | { kind: "draft"; reply: string; draft: VideoDraft; request: string | null };

async function planCompose(
  deps: StudioDeps,
  tenant_id: string,
  text: string,
  image_path: string | null,
  verbatim: boolean,
  previous: VideoDraft | null,
  history: StudioMessageRow[],
): Promise<ComposePlan> {
  let photoPresenter: { image_path: string; gender: "male" | "female" | null } | null = null;
  if (image_path) {
    const look = deps.lookAtPhoto ? await deps.lookAtPhoto(tenant_id, image_path) : null;
    if (look ? look.has_person : mentionsPresenter(text)) photoPresenter = { image_path, gender: look?.gender ?? null };
  }
  const swapPresenter = !verbatim && !image_path && asksForDifferentPresenter(text);
  if (!verbatim && !image_path && !swapPresenter && previous?.intent === "animate" && previous.image_path && mentionsPresenter(text)) {
    const look = deps.lookAtPhoto ? await deps.lookAtPhoto(tenant_id, previous.image_path) : null;
    photoPresenter = { image_path: previous.image_path, gender: look?.gender ?? null };
  }
  if (image_path && !photoPresenter) {
    return { kind: "draft", reply: text ? ANIMATE_WITH_PROMPT_REPLY : ANIMATE_REPLY, draft: animateDraft(text, image_path), request: text };
  }
  const newVideo = !image_path && previous?.intent === "animate" && asksForNewVideo(text);
  if (!verbatim && !image_path && previous?.intent === "animate" && previous.image_path && !mentionsPresenter(text) && !newVideo) {
    return { kind: "draft", reply: ANIMATE_WITH_PROMPT_REPLY, draft: animateDraft(reviseAnimateMotion(previous, text), previous.image_path), request: text };
  }

  const business = await deps.business(tenant_id);

  const carriedPhoto =
    photoPresenter ??
    (!swapPresenter && previous?.intent === "talking_head" && previous.image_path ? { image_path: previous.image_path, gender: previous.presenter_gender } : null);
  const request = photoPresenter
    ? `${text || "A short presenter video about the business."}\n${PHOTO_PRESENTER_HINT}`
    : verbatim
      ? `${text}\n${VERBATIM_SCRIPT_HINT}`
      : text;
  let outcome: Awaited<ReturnType<typeof draftVideo>> | null = null;
  try {
    outcome = await draftVideo(
      request,
      photoPresenter || previous?.intent === "animate" ? null : previous,
      business,
      deps.draft,
      earlierRequests(history),
    );
    if (outcome?.kind === "draft" && verbatim) {
      const draft = verbatimDraft(outcome.draft, text);
      const refusal = draftPolicyRefusal(draft, text);
      outcome = refusal ? { kind: "refused", reply: refusal.message, code: refusal.code } : { kind: "draft", reply: VERBATIM_REPLY, draft };
    }
    if (outcome?.kind === "draft" && swapPresenter && previous?.intent === "talking_head" && previous.script) {
      outcome = { ...outcome, reply: DIFFERENT_PRESENTER_REPLY, draft: keepScriptNewPresenter(previous, outcome.draft) };
    }
    if (outcome?.kind === "draft" && carriedPhoto && (photoPresenter || outcome.draft.intent === "talking_head")) {
      if (outcome.draft.intent !== "talking_head" || !outcome.draft.script) outcome = null;
      else
        outcome = {
          ...outcome,
          reply: PHOTO_PRESENTER_REPLY,
          draft: {
            ...outcome.draft,
            image_path: carriedPhoto.image_path,
            presenter_gender: carriedPhoto.gender ?? outcome.draft.presenter_gender,
          },
        };
    }
  } catch (e) {
    if (!(e instanceof DraftFailedError)) console.warn(`[video-studio] draft call failed: ${(e as Error).message}`);
  }
  if (!outcome) return { kind: "failed" };
  if (outcome.kind === "refused") return { kind: "refused", reply: outcome.reply, code: outcome.code };
  return { kind: "draft", reply: outcome.reply, draft: outcome.draft, request: null };
}

async function composeAndRender(
  deps: StudioDeps,
  a: { tenant_id: string; user_id: string } & ThreadChoice,
  text: string,
  image_path: string | null,
  verbatim = false,
): Promise<SendResult> {
  const existing = a.new_thread ? null : a.thread_id ? await ownThread(deps.store, a.user_id, a.thread_id) : await deps.store.findThread(a.user_id);
  const history = existing ? await deps.store.listMessages(existing, HISTORY_LIMIT) : [];
  const plan = await planCompose(deps, a.tenant_id, text, image_path, verbatim, latestDraft(history), history);
  if (plan.kind === "draft") await assertDraftAffordable(deps, a.tenant_id, plan.draft, plan.request);

  const thread_id = existing ?? (await deps.store.createThread(a.user_id));
  if (history.length === 0 && deps.store.setThreadTitle) await deps.store.setThreadTitle(thread_id, threadTitle(text, !!image_path, plan.kind === "draft" && plan.draft.intent === "talking_head" && !!image_path));
  const user_message = await deps.store.insertMessage({
    thread_id,
    sender_role: "user",
    body: text,
    ...(verbatim ? { meta: { verbatim: true } } : {}),
    ...(image_path ? { attachments: [{ path: image_path, kind: "image" as const }] } : {}),
  });

  if (plan.kind === "failed") {
    const reply = await deps.store.insertMessage({ thread_id, sender_role: "assistant", body: DRAFT_FAILED_REPLY, meta: { kind: "video_studio_draft_failed" } });
    return { thread_id, user_message, reply, render: null };
  }
  if (plan.kind === "refused") {
    const reply = await deps.store.insertMessage({ thread_id, sender_role: "assistant", body: plan.reply, meta: { kind: "video_studio_refused", code: plan.code } });
    return { thread_id, user_message, reply, render: null };
  }
  if (plan.request !== null) {
    return insertDraftAndRender(deps, { tenant_id: a.tenant_id, user_id: a.user_id, thread_id, user_message, reply: plan.reply, draft: plan.draft, request: plan.request });
  }
  const reply = await deps.store.insertMessage({
    thread_id,
    sender_role: "assistant",
    body: plan.reply,
    meta: { kind: "video_studio_draft", video_draft: plan.draft },
  });
  const render = await renderDraft(deps, {
    tenant_id: a.tenant_id,
    user_id: a.user_id,
    thread_id,
    message_id: reply.id,
    draft: plan.draft,
    previous_run_id: null,
  });
  return { thread_id, user_message, reply, render };
}

function earlierRequests(rows: StudioMessageRow[]): string[] {
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return sorted
    .filter((r, i) => {
      if (r.sender_role !== "user" || !r.body.trim()) return false;
      const answer = sorted.slice(i + 1).find((n) => n.sender_role === "assistant");
      return answer?.meta?.kind !== "video_studio_refused";
    })
    .map((r) => r.body);
}

async function priorRender(deps: StudioDeps, thread_id: string, run_id: string): Promise<{ status: RenderStatus | undefined; rendering: StudioMessageRow | undefined }> {
  const rows = deps.store.listRunMessages ? await deps.store.listRunMessages(thread_id, run_id) : await deps.store.listMessages(thread_id, HISTORY_LIMIT);
  const artifacts = await deps.store.listVideoArtifacts([run_id]);
  const started = deps.store.listStartedRuns
    ? await deps.store.listStartedRuns([run_id]).catch(() => {
        throw new StudioError(503, "render_check_unavailable", RENDER_CHECK_UNAVAILABLE_REPLY);
      })
    : null;
  return {
    status: buildStudioView(thread_id, rows, artifacts, (deps.now ?? Date.now)(), started).renders[run_id],
    rendering: rows.find((r) => r.meta?.kind === "video_studio_rendering" && r.agent_run_id === run_id),
  };
}

function renderError(out: { error: string; code: string }): StudioError {
  const status = out.code === "already_rendered" ? 409 : out.code === "enqueue_failed" ? 502 : out.code.startsWith("refused") ? 422 : 400;
  return new StudioError(status, out.code, out.error);
}

export async function retryStudioRender(
  deps: StudioDeps,
  a: { tenant_id: string; user_id: string; message_id: string; thread_id?: string | null },
): Promise<{ thread_id: string; run_id: string; rendering_message: StudioMessageRow }> {
  const thread_id = a.thread_id ? await ownThread(deps.store, a.user_id, a.thread_id) : await deps.store.findThread(a.user_id);
  if (!thread_id) throw new StudioError(404, "draft_not_found", "That ad is not yours or no longer exists.");
  const message = await deps.store.getMessage(thread_id, a.message_id);
  const draft = storedDraft(message);
  if (!message || !draft) throw new StudioError(404, "draft_not_found", "That ad is not yours or no longer exists.");
  const previous = typeof message.meta?.render_run_id === "string" ? message.meta.render_run_id : null;
  const prior = previous ? await priorRender(deps, thread_id, previous) : null;
  if (prior && prior.status?.status !== "failed" && prior.status?.status !== "stalled") {
    throw new StudioError(409, "already_rendered", "This video is already being made or is done. Press Edit to change the ad.");
  }
  const recent = await deps.store.listMessages(thread_id, HISTORY_LIMIT).catch(() => {
    throw new StudioError(503, "render_check_unavailable", RENDER_CHECK_UNAVAILABLE_REPLY);
  });
  if (latestDraftMessage(recent)?.id !== message.id) throw new StudioError(409, "superseded", SUPERSEDED_REPLY);
  await assertCanMakeVideo(deps, a.tenant_id);
  const intake = renderIntake(draft);
  if ("error" in intake) throw renderError(intake);
  await assertCanAffordVideo(deps, a.tenant_id, intake.intake);
  const unsent = prior?.status?.status === "failed" && prior.status.code === "enqueue_failed" ? prior.rendering : undefined;
  const out =
    previous && unsent
      ? await requeueRender(deps, { tenant_id: a.tenant_id, thread_id, run_id: previous, intake: intake.intake, rendering_message: unsent })
      : await renderDraft(deps, { tenant_id: a.tenant_id, user_id: a.user_id, thread_id, message_id: a.message_id, draft, previous_run_id: previous });
  if ("error" in out) throw renderError(out);
  return { thread_id, ...out };
}

export type RenderStatus = {
  status: "rendering" | "stalled" | "done" | "failed";
  started_at: string;
  videos: Array<{ artifact_id: string; filename: string | null }>;
  queued?: boolean;
  working_since?: string;
  code?: string | null;
};

export type StudioView = {
  thread_id: string | null;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    body: string;
    created_at: string;
    kind: string | null;
    draft_id?: string | null;
    draft: VideoDraft | null;
    render_run_id: string | null;
    run_id: string | null;
    image_path: string | null;
    verbatim?: boolean;
    credits?: number | null;
  }>;
  renders: Record<string, RenderStatus>;
};

export function buildStudioView(
  thread_id: string | null,
  rows: StudioMessageRow[],
  artifacts: VideoArtifactRow[],
  now: number = Date.now(),
  started: StartedRunRow[] | null = null,
): StudioView {
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const renders: Record<string, RenderStatus> = {};
  const startedRuns = new Set((started ?? []).map((s) => s.run_id));
  for (const r of sorted) {
    if (r.meta?.kind === "video_studio_rendering" && r.agent_run_id) renders[r.agent_run_id] = { status: "rendering", started_at: r.created_at, videos: [] };
  }
  for (const r of sorted) {
    const src = r.meta?.source_run_id;
    if (typeof src !== "string" || !renders[src]) continue;
    if (r.meta?.kind === REQUEUED_KIND && renders[src].code === "enqueue_failed") renders[src] = { status: "rendering", started_at: r.created_at, videos: [] };
    if (r.meta?.kind !== FAILED_KIND) continue;
    if (r.meta?.code === "enqueue_failed" && startedRuns.has(src)) continue;
    renders[src].status = "failed";
    renders[src].code = typeof r.meta?.code === "string" ? r.meta.code : null;
  }
  for (const art of artifacts) {
    const entry = renders[art.run_id];
    if (!entry) continue;
    entry.videos.push({ artifact_id: art.id, filename: art.filename });
    entry.status = "done";
  }
  const firstWork = new Map<string, string>();
  for (const s of started ?? []) if (!firstWork.has(s.run_id) || s.created_at < firstWork.get(s.run_id)!) firstWork.set(s.run_id, s.created_at);
  for (const [run_id, entry] of Object.entries(renders)) {
    if (entry.status !== "rendering") continue;
    const at = firstWork.get(run_id);
    if (!started) {
      if (now - Date.parse(entry.started_at) > RENDER_STALL_MS) entry.status = "stalled";
    } else if (at) {
      if (now - Date.parse(at) > RENDER_STALL_MS) entry.status = "stalled";
      else entry.working_since = at;
    } else if (now - Date.parse(entry.started_at) > RENDER_QUEUE_MAX_MS) {
      entry.status = "stalled";
    } else {
      entry.queued = true;
    }
  }
  return {
    thread_id,
    messages: sorted.filter((r) => r.meta?.kind !== REQUEUED_KIND).map((r) => {
      const kind = typeof r.meta?.kind === "string" ? r.meta.kind : null;
      const src = typeof r.meta?.source_run_id === "string" ? r.meta.source_run_id : null;
      return {
        id: r.id,
        role: r.sender_role,
        body: r.body,
        created_at: r.created_at,
        kind,
        draft_id: kind === "video_studio_rendering" && typeof r.meta?.draft_message_id === "string" ? r.meta.draft_message_id : null,
        draft: storedDraft(r),
        render_run_id: typeof r.meta?.render_run_id === "string" ? r.meta.render_run_id : null,
        run_id: kind === "video_studio_rendering" ? r.agent_run_id : src,
        image_path: r.sender_role === "user" ? attachedImage(r.attachments) : null,
        ...(r.sender_role === "user" ? { verbatim: r.meta?.verbatim === true } : {}),
      };
    }),
    renders,
  };
}

function attachedImage(attachments: unknown): string | null {
  if (!Array.isArray(attachments)) return null;
  const hit = attachments.find((a) => a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string");
  return hit ? (hit as { path: string }).path : null;
}

export async function readStudio(store: StudioStore, user_id: string, requested: string | null = null): Promise<StudioView> {
  const thread_id = requested ? await ownThread(store, user_id, requested) : await store.findThread(user_id);
  if (!thread_id) return { thread_id: null, messages: [], renders: {} };
  const rows = await store.listMessages(thread_id, HISTORY_LIMIT);
  const runIds = rows
    .filter((r) => r.meta?.kind === "video_studio_rendering" && r.agent_run_id)
    .map((r) => r.agent_run_id as string);
  const artifacts = runIds.length ? await store.listVideoArtifacts(runIds) : [];
  const started = runIds.length && store.listStartedRuns ? await store.listStartedRuns(runIds).catch(() => null) : null;
  const view = buildStudioView(thread_id, rows, artifacts, Date.now(), started);
  const latest = [...view.messages].reverse().find((m) => m.draft);
  if (latest?.draft) latest.credits = await draftCredits(latest.draft);
  return view;
}

async function draftCredits(draft: VideoDraft): Promise<number | null> {
  try {
    const out = renderIntake(draft);
    return "error" in out ? null : await billedVideoCredits(out.intake);
  } catch {
    return null;
  }
}

export const THREAD_LIST_LIMIT = 50;
export const GALLERY_RUN_LIMIT = 300;

export type StudioThreadSummary = { id: string; title: string; last_message_at: string };

export async function listStudioThreads(store: StudioStore, user_id: string): Promise<StudioThreadSummary[]> {
  if (!store.listThreads) return [];
  const rows = await store.listThreads(user_id, THREAD_LIST_LIMIT);
  return rows.map((r) => ({ id: r.id, title: r.title?.trim() || "New video", last_message_at: r.last_message_at ?? r.created_at }));
}

export type GalleryVideo = {
  artifact_id: string;
  filename: string | null;
  created_at: string;
  source: "chat" | "card";
  thread_id: string | null;
  intent: VideoKind | null;
  posted_on: string[];
  posting_on: string[];
  check_on: string[];
  failed_on: string[];
};

type GalleryPostState = Pick<GalleryVideo, "posted_on" | "posting_on" | "check_on" | "failed_on">;

export async function readGallery(
  store: StudioStore,
  user_id: string,
  postStates?: (ids: string[]) => Promise<Record<string, GalleryPostState>>,
): Promise<{ videos: GalleryVideo[] }> {
  if (!store.listVideoRuns || !store.listGalleryArtifacts) return { videos: [] };
  const runs = await store.listVideoRuns(GALLERY_RUN_LIMIT);
  if (runs.length === 0) return { videos: [] };
  const byRun = new Map(runs.map((r) => [r.id, r]));
  const artifacts = await store.listGalleryArtifacts(runs.map((r) => r.id));
  const videos = artifacts
    .filter((a) => byRun.has(a.run_id))
    .map((a): Omit<GalleryVideo, keyof GalleryPostState> => {
      const run = byRun.get(a.run_id)!;
      const chat = !!run.studio_thread_id;
      return {
        artifact_id: a.id,
        filename: a.filename,
        created_at: a.created_at,
        source: chat ? "chat" : "card",
        thread_id: chat && run.enqueued_by === user_id ? run.studio_thread_id : null,
        intent: run.intent ?? null,
      };
    })
    .sort((x, y) => y.created_at.localeCompare(x.created_at));
  const states: Record<string, GalleryPostState> = postStates
    ? await postStates(videos.map((v) => v.artifact_id)).catch(() => ({}))
    : {};
  return {
    videos: videos.map((v) => {
      const st = states[v.artifact_id];
      return { ...v, posted_on: st?.posted_on ?? [], posting_on: st?.posting_on ?? [], check_on: st?.check_on ?? [], failed_on: st?.failed_on ?? [] };
    }),
  };
}
