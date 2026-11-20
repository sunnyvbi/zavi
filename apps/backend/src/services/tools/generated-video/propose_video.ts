
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { asTenantId, clearTenantMarker, consumeTenantRateLimit, tenantClient } from "@/services/tenant-client";
import { resolveChannelExecEmit } from "@/services/channels/exec-emit";
import { isChatAnswerTurnEmit } from "@/services/agents/redo-mode";
import { REQUESTED_VIDEO_RUN_STAGE } from "@/services/channels/record-only-run";
import {
  billedVideoCredits,
  DEFAULT_CLIP_SECONDS,
  STARTER_SCRIPT_MAX_CHARS,
  STARTER_SCRIPT_MAX_WORDS,
  STARTER_SCRIPT_MIN_WORDS,
  voiceoverSeconds,
} from "@/services/launch-video/video-estimate";
import { altHooks } from "@/services/video-studio/draft";
import { autostartChatVideo, autostartStarterVideo } from "./starter-autostart";
import { checkOwnImageForVendor } from "@/services/chat-images/sign-own-image";
import { CARD_IN_CHAT_NEXT, ONE_CARD_NEXT, chatVideoCardFiled, showVideoCardInChat, type VideoCardInChat } from "./chat-card";
import {
  asksPresenterToSpeakAsCustomer,
  generativeVideoIntakeSchema,
  narrowAspect,
  shouldRedirectTestimonialFromTalkingHead,
  speaksAsCustomer,
  type GenerativeVideoIntake,
} from "@/services/launch-video/generative-video-intake";
import { PRESENTER_GENDERS, PRESENTER_VOICES, resolvePresenterVoice } from "@/services/launch-video/presenter";
import { lookAtPresenterPhoto } from "@/services/video-studio/photo-look";

export const GENERATED_VIDEO_RENDER_CLASS = "generated_video.render.v1";

const CARD_CHANNEL_NAME: Readonly<Record<string, string>> = {
  generated_video: "AI UGC Videos",
  youtube_organic: "YouTube",
};

export function whereToApprove(channelSlug: string | null): string {
  const name = channelSlug && Object.prototype.hasOwnProperty.call(CARD_CHANNEL_NAME, channelSlug) ? CARD_CHANNEL_NAME[channelSlug] : null;
  if (!name) return "The card waits on its channel page, not in Needs you now.";
  const where =
    channelSlug === "youtube_organic"
      ? `The card waits on the ${name} channel page (Channels → ${name}), not in Needs you now. Tell the founder to approve it there.`
      : `The card waits in Suggested ads on the ${name} channel's Overview tab (Channels → ${name}), not in Needs you now. Tell the founder to press Make video on it there.`;
  return channelSlug === "youtube_organic"
    ? `${where} Once the video is made, a YouTube upload card for it appears on the same page; nothing is uploaded until they approve that one too.`
    : where;
}

export function makeButtonFor(channelSlug: string | null): string {
  return channelSlug === "youtube_organic" ? "Approve" : "Make video";
}

export const VIDEO_FORMATS = ["product_demo", "explainer", "hook", "behind_the_scenes", "offer"] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

const FORMAT_LABEL: Record<VideoFormat, string> = {
  product_demo: "Product demo",
  explainer: "Explainer",
  hook: "Hook",
  behind_the_scenes: "Behind the scenes",
  offer: "Offer",
};

const MIN_WORDS = STARTER_SCRIPT_MIN_WORDS;
const MAX_WORDS = STARTER_SCRIPT_MAX_WORDS;
const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const voicesFor = (g: (typeof PRESENTER_GENDERS)[number]): string =>
  Object.keys(PRESENTER_VOICES)
    .filter((v) => PRESENTER_VOICES[v] === g)
    .join(", ");

const inputSchema = z.object({
  format: z
    .enum(VIDEO_FORMATS)
    .describe(
      "product_demo = the product doing the thing, narrated; explainer = the result first, then how it works; hook = the problem in one line, then why this answers it; behind_the_scenes = how the product or service is made or delivered, shown step by step; offer = one concrete reason to act now, using only a price, offer or guarantee the business publishes.",
    ),
  hook: z
    .string()
    .min(1)
    .max(200)
    .describe("The first line, spoken in the first ~3 seconds. Specific: a number, a price, a named annoyance or a result."),
  alt_hooks: z
    .array(z.string().min(1).max(200))
    .max(2)
    .optional()
    .describe("Two other first lines the founder can swap in for `hook`, each opening the same script against the same objection from a different angle."),
  script: z
    .string()
    .min(1)
    .max(STARTER_SCRIPT_MAX_CHARS)
    .refine((s) => words(s) >= MIN_WORDS && words(s) <= MAX_WORDS, {
      message: `script must be ${MIN_WORDS}-${MAX_WORDS} words`,
    })
    .describe(
      "Everything the AI presenter says, word for word, starting with the hook. Aim for 40-55 words. Written to be SPOKEN: clauses joined with commas so it runs as one person talking, not a row of short sentences. The presenter explains or demonstrates; it never speaks as a customer.",
    ),
  scene: z
    .string()
    .min(1)
    .max(600)
    .describe(
      "One still frame of the presenter before they speak: who they are (age range, look, clothes; a generic AI presenter, never a real or named person) and where they are. No object in their hands, no screen, no on-screen text. Self-contained.",
    ),
  presenter_gender: z.enum(PRESENTER_GENDERS).describe("The presenter in `scene`. The portrait and the voice are both made from this, so they match."),
  voice: z
    .string()
    .max(40)
    .optional()
    .describe(
      `The voice that reads the script, picked to suit this presenter and this business. male: ${voicesFor("male")}. female: ${voicesFor("female")}. A voice of the other gender is replaced.`,
    ),
  caption: z.string().min(1).max(2200).describe("The social caption to post with it, ready as-is."),
  objection: z
    .string()
    .min(1)
    .max(500)
    .describe("ONE sentence: the buyer objection this video tests a hook against, and where you found it."),
  portrait_path: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe("The exact image_path of a photo the founder attached that shows a person. That person presents the video. Omit otherwise."),
});

export type VideoProposeInput = z.infer<typeof inputSchema>;

export function renderIntakeFor(input: VideoProposeInput): GenerativeVideoIntake {
  return generativeVideoIntakeSchema.parse({
    prompt: input.scene,
    intent: "talking_head",
    premium: false,
    aspect_ratio: "9:16",
    script: input.script,
    presenter_gender: input.presenter_gender,
    voice: resolvePresenterVoice({ gender: input.presenter_gender, voice: input.voice }),
    hook: input.hook,
    ...(input.portrait_path ? { portrait_path: input.portrait_path } : {}),
  });
}

export function buildVideoCard(
  input: VideoProposeInput,
  credits: number,
  channelSlug: string | null = "generated_video",
): { title: string; body: Record<string, unknown> } {
  const label = FORMAT_LABEL[input.format];
  const title = `${label}: ${input.hook}`.slice(0, 300);
  const costLine = `${credits.toLocaleString("en-US")} credits, charged only when the video arrives`;
  const seconds = voiceoverSeconds(input.script);
  return {
    title,
    body: {
      step: {
        title,
        body: `${input.objection}\n\nPress ${makeButtonFor(channelSlug)} to make this as a vertical video of about ${seconds} seconds with an AI presenter. It costs about ${costLine}. If it fails you are not charged.`,
        blocking: false,
        effort: "minutes",
        evidence: [],
        deliverable: {
          kind: "script",
          label: "The script",
          content: `${input.script}\n\nCaption: ${input.caption}`,
        },
      },
      exact_change: {
        rows: [
          { item: "Video", before: "Script only", after: `${label}, about ${seconds} seconds, 9:16` },
          { item: "Cost", before: "Nothing yet", after: costLine },
        ],
      },
      hooks: [input.hook, ...(altHooks(input.alt_hooks, input.hook) ?? [])],
      video_format: input.format,
      ...(input.portrait_path ? { portrait_path: input.portrait_path } : {}),
      cost_credits: credits,
      link: null,
    },
  };
}

const REQUEST_LABEL: Record<GenerativeVideoIntake["intent"], string> = {
  talking_head: "AI presenter video",
  cinematic: "Cinematic clip",
  social: "Social clip",
  animate: "Animated image",
};

export function buildRequestedVideoCard(
  intake: GenerativeVideoIntake,
  credits: number,
): { title: string; body: Record<string, unknown> } {
  const label = REQUEST_LABEL[intake.intent];
  const ask = (intake.hook ?? intake.script ?? intake.prompt).trim().split(/\s+/).slice(0, 14).join(" ");
  const title = `${label}: ${ask}`.slice(0, 300);
  const costLine = `${credits.toLocaleString("en-US")} credits, charged only when the video arrives`;
  const seconds = intake.intent === "talking_head" && intake.script ? voiceoverSeconds(intake.script) : DEFAULT_CLIP_SECONDS;
  const aspect = narrowAspect(intake.aspect_ratio);
  return {
    title,
    body: {
      step: {
        title,
        body: `Asked for in chat: a ${aspect} video of about ${seconds} seconds. It costs about ${costLine}. If it fails you are not charged.`,
        blocking: false,
        effort: "minutes",
        evidence: [],
        deliverable: {
          kind: "script",
          label: intake.script ? "The script" : "What to show",
          content: intake.script ?? intake.prompt,
        },
      },
      exact_change: {
        rows: [
          { item: "Video", before: "Not made", after: `${label}, about ${seconds} seconds, ${aspect}` },
          { item: "Cost", before: "Nothing yet", after: costLine },
        ],
      },
      hooks: intake.hook ? [intake.hook] : [],
      video_format: intake.intent,
      scene: intake.prompt,
      cost_credits: credits,
      link: null,
    },
  };
}

export async function fileGeneratedVideoCard(a: {
  tenantId: string;
  runId: string;
  channelSlug: string;
  intake: GenerativeVideoIntake;
  card: (credits: number) => { title: string; body: Record<string, unknown> };
  payload?: Record<string, unknown>;
}): Promise<{ id: string; kept: boolean; credits: number }> {
  const credits = await billedVideoCredits(a.intake);
  const { title, body } = a.card(credits);
  const out = await recordChannelExecAction({
    tenantId: a.tenantId,
    runId: a.runId,
    channelSlug: a.channelSlug,
    execClass: GENERATED_VIDEO_RENDER_CLASS,
    execPayload: { intake: a.intake, ...(a.payload ?? {}) },
    actionType: "video_post",
    title,
    body,
  });
  return { id: out.id, kept: out.kept === true, credits };
}

export { REQUESTED_VIDEO_RUN_STAGE };

export async function createRequestedVideoRun(tenantId: string, requestedByRunId: string): Promise<string> {
  const db = tenantClient(asTenantId(tenantId));
  const prior = await db
    .from("agent_runs")
    .select("id")
    .eq("agent_slug", "generated_video")
    .eq("agent_definition_hash", REQUESTED_VIDEO_RUN_STAGE)
    .eq("payload->>requested_by_run_id", requestedByRunId)
    .eq("status", "success")
    .limit(1);
  const priorId = prior.error ? null : ((prior.data ?? []) as Array<{ id?: unknown }>)[0]?.id;
  if (typeof priorId === "string" && priorId) return priorId;
  const at = new Date().toISOString();
  const { data, error } = await db
    .from("agent_runs")
    .insert({
      id: randomUUID(),
      agent_slug: "generated_video",
      channel_slug: "generated_video",
      agent_definition_hash: REQUESTED_VIDEO_RUN_STAGE,
      trigger: "chat",
      status: "success",
      enqueued_at: at,
      started_at: at,
      finished_at: at,
      parse_ok: true,
      cost_tokens: 0,
      cost_usd: 0,
      tool_calls: [],
      output_text: "A video card asked for in chat (no model run).",
      payload: { stage: REQUESTED_VIDEO_RUN_STAGE, requested_by_run_id: requestedByRunId },
    })
    .select("id")
    .single();
  if (error) throw new Error(`generated-video: card run insert failed: ${error.message}`);
  const id = (data as { id?: string } | null)?.id;
  if (typeof id !== "string" || !id) throw new Error("generated-video: card run insert returned no id");
  return id;
}

export const REQUESTED_VIDEO_DAILY_CAP = 20;
const REQUESTED_VIDEO_RUN_SCAN = 500;
const REQUESTED_VIDEO_ID_CHUNK = 100;

export async function countRequestedVideoCardsToday(tenantId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const db = tenantClient(asTenantId(tenantId));
  const runs = await db
    .from("agent_runs")
    .select("id")
    .eq("agent_slug", "generated_video")
    .eq("agent_definition_hash", REQUESTED_VIDEO_RUN_STAGE)
    .gte("enqueued_at", since)
    .limit(REQUESTED_VIDEO_RUN_SCAN);
  if (runs.error) throw new Error(`generated-video: card count read failed: ${runs.error.message}`);
  const ids = ((runs.data ?? []) as Array<{ id?: unknown }>).map((r) => r.id).filter((id): id is string => typeof id === "string");
  let filed = 0;
  for (let i = 0; i < ids.length && filed <= REQUESTED_VIDEO_DAILY_CAP; i += REQUESTED_VIDEO_ID_CHUNK) {
    const cards = await db
      .from("channel_actions")
      .select("id")
      .in("run_id", ids.slice(i, i + REQUESTED_VIDEO_ID_CHUNK))
      .neq("status", "stale")
      .limit(REQUESTED_VIDEO_DAILY_CAP + 1);
    if (cards.error) throw new Error(`generated-video: card count read failed: ${cards.error.message}`);
    filed += (cards.data ?? []).length;
  }
  return ids.length >= REQUESTED_VIDEO_RUN_SCAN ? Math.max(filed, REQUESTED_VIDEO_DAILY_CAP) : filed;
}

const REQUESTED_VIDEO_LOCK_BUCKET = "requested_video_card_lock";
const REQUESTED_VIDEO_LOCK_SECONDS = 60;
const REQUESTED_VIDEO_LOCK_TRIES = 20;
const REQUESTED_VIDEO_LOCK_WAIT_MS = 250;

export async function holdRequestedVideoLock(tenantId: string): Promise<boolean> {
  for (let i = 0; i < REQUESTED_VIDEO_LOCK_TRIES; i++) {
    if (await consumeTenantRateLimit(asTenantId(tenantId), REQUESTED_VIDEO_LOCK_BUCKET, 1, REQUESTED_VIDEO_LOCK_SECONDS)) return true;
    await new Promise((r) => setTimeout(r, REQUESTED_VIDEO_LOCK_WAIT_MS));
  }
  return false;
}

export async function releaseRequestedVideoLock(tenantId: string): Promise<void> {
  await clearTenantMarker(asTenantId(tenantId), REQUESTED_VIDEO_LOCK_BUCKET).catch(() => undefined);
}

export async function failRequestedVideoRun(tenantId: string, runId: string): Promise<void> {
  try {
    const db = tenantClient(asTenantId(tenantId));
    const filed = await db.from("channel_actions").select("id").eq("run_id", runId).limit(1);
    if (filed.error || (filed.data ?? []).length > 0) return;
    await db
      .from("agent_runs")
      .update({ status: "failed", output_text: "The video card could not be filed, so nothing was made or charged." })
      .eq("id", runId);
  } catch {
    return;
  }
}

type ProposeCtx = {
  tenant_id: string;
  run_id?: string;
  run_trigger?: string;
  writes_suppressed?: boolean;
  redo?: boolean;
  emit_decision?: unknown;
  founder_chat_order?: boolean;
  founder_order_unverified?: boolean;
  actor_user_id?: string | null;
};

export const generatedVideoProposeTool: ToolSpec = {
  name: "generated_video_propose",
  effect: "write",
  description:
    "Write ONE hook-test script as an approvable card showing its credit cost. In a web chat the card appears in that chat and the video is made when the founder presses Make video on it there. Otherwise it waits in Suggested ads (Approve on a YouTube card), or starts at once for the first card when they asked from Slack or pressed Suggest new ads; the result note says which. Charged only when it arrives. Call it once per script (five per run, one per format: product_demo, explainer, hook, behind_the_scenes, offer). Never a testimonial or a customer review.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    const input = inputSchema.parse(rawInput);
    if (speaksAsCustomer(input.script) || [input.hook, ...(input.alt_hooks ?? [])].some(speaksAsCustomer) || asksPresenterToSpeakAsCustomer(input.scene)) {
      throw new ExpectedToolError(
        "generated_video_customer_voice",
        "This script has the presenter speak as a customer. An AI presenter may explain or demonstrate, never testify. Rewrite it in the presenter's own voice.",
      );
    }
    if (shouldRedirectTestimonialFromTalkingHead("talking_head", [input.script, input.hook, ...(input.alt_hooks ?? []), input.scene].join(" "))) {
      throw new ExpectedToolError(
        "generated_video_testimonial",
        "This card frames the presenter as a customer endorsement (a testimonial, customer reviews, a star rating or a happy customer). An AI presenter may explain or demonstrate, never testify. Rewrite the script, hook and scene without it.",
      );
    }
    const pctx = ctx as unknown as ProposeCtx;
    const notThisChannel = async (): Promise<string> => "";
    let kept = false;
    let filedOn: string | null = null;
    if (input.portrait_path) await checkOwnImageForVendor(pctx.tenant_id, input.portrait_path);
    if (pctx.run_id && (await chatVideoCardFiled(pctx.tenant_id, pctx.run_id, GENERATED_VIDEO_RENDER_CLASS))) {
      return { action_id: null, proposed: false, one_card: true, note: ONE_CARD_NEXT };
    }
    const photo = input.portrait_path ? await lookAtPresenterPhoto(pctx.tenant_id, input.portrait_path) : null;
    const filed = photo?.gender ? { ...input, presenter_gender: photo.gender } : input;
    const emit = await resolveChannelExecEmit(
      new Set(Object.keys(CARD_CHANNEL_NAME)),
      {
        tenant_id: pctx.tenant_id,
        run_id: pctx.run_id,
        run_trigger: pctx.run_trigger,
        writes_suppressed: pctx.writes_suppressed,
        redo: pctx.redo,
        chat_answer_turn: isChatAnswerTurnEmit(pctx.emit_decision),
        emit_decision: notThisChannel,
      },
      async (a) => {
        const out = await fileGeneratedVideoCard({
          tenantId: a.tenant_id,
          runId: a.run_id,
          channelSlug: a.channel_slug,
          intake: renderIntakeFor(filed),
          card: (credits) => buildVideoCard(filed, credits, a.channel_slug),
          payload: { format: input.format, post: { title: input.hook, description: input.caption } },
        });
        kept = out.kept;
        filedOn = a.channel_slug;
        return out.id;
      },
    );
    if (!emit || emit === notThisChannel) {
      throw new ExpectedToolError(
        "generated_video_propose_wrong_run",
        "Video cards can only be written from an AI UGC Videos or YouTube channel run. Nothing was written.",
      );
    }
    const action_id = await emit(GENERATED_VIDEO_RENDER_CLASS, {});
    if (action_id === "channel_action_suppressed") {
      return { action_id: null, proposed: false, note: "Draft run: nothing was written." };
    }
    const starter = pctx.run_id ? await autostartStarterVideo(pctx.tenant_id, pctx.run_id, { actionId: action_id, kept }) : "not_starter";
    if (starter === "started") {
      return {
        action_id,
        proposed: true,
        rendered: false,
        starter: true,
        note: "Starter card written and its video is being made now, because the founder pressed Suggest new ads. Credits are charged only when the video arrives. Do not ask the founder to press Make video on it.",
      };
    }
    const inChat: VideoCardInChat =
      starter === "not_starter" && filedOn === "generated_video" && pctx.run_id ? await showVideoCardInChat(pctx.tenant_id, pctx.run_id, action_id) : "not_chat";
    if (inChat === "shown") {
      return { action_id, proposed: true, rendered: false, in_chat: true, note: `Card written and shown in this chat. NOTHING has been made and no credits were spent. ${CARD_IN_CHAT_NEXT}` };
    }
    if (inChat === "not_chat" && starter === "not_starter" && filedOn === "generated_video" && pctx.run_id) {
      const chat = await autostartChatVideo(pctx.tenant_id, pctx.run_id, { actionId: action_id, kept }, {
        founder: pctx.founder_chat_order === true,
        unverified: pctx.founder_order_unverified === true,
        userId: pctx.actor_user_id ?? null,
      });
      if (chat === "started") {
        return {
          action_id,
          proposed: true,
          rendered: false,
          started: true,
          note: "Card written and its video is being made now, because the founder asked for it in chat. Credits are charged only when the video arrives. Do not ask the founder to press Make video on it; tell them the video will appear on the AI UGC Videos channel when it is ready.",
        };
      }
    }
    if (starter === "capped") {
      return {
        action_id,
        proposed: true,
        rendered: false,
        starter: true,
        note: `Starter card written. Only the first starter video is made automatically; this one waits for the founder to press ${makeButtonFor(filedOn)}. NOTHING has been made and no credits were spent. Tell the founder they can make it with one tap. ${whereToApprove(filedOn)}`,
      };
    }
    return {
      action_id,
      proposed: true,
      rendered: false,
      note: `Card written. NOTHING has been made and no credits were spent. Tell the founder the script is ready; the video is made only after they press ${makeButtonFor(filedOn)} on it. ${whereToApprove(filedOn)}`,
    };
  },
};
