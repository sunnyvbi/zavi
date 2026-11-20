import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { recordChannelExecAction } from "@/services/channels/exec-actions";
import { resolveChannelExecEmit } from "@/services/channels/exec-emit";
import { isChatAnswerTurnEmit } from "@/services/agents/redo-mode";
import { billedVideoCredits, DEFAULT_CLIP_SECONDS } from "@/services/launch-video/video-estimate";
import { asksForCustomerEndorsement, generativeVideoIntakeSchema, speaksAsCustomer, type GenerativeVideoIntake } from "@/services/launch-video/generative-video-intake";
import { checkOwnImageForVendor } from "@/services/chat-images/sign-own-image";
import { lookAtPresenterPhoto } from "@/services/video-studio/photo-look";
import { DEFAULT_ANIMATE_PROMPT } from "@/services/video-studio/draft";
import { GENERATED_VIDEO_RENDER_CLASS, makeButtonFor, whereToApprove } from "./propose_video";
import { CARD_IN_CHAT_NEXT, ONE_CARD_NEXT, chatVideoCardFiled, showVideoCardInChat } from "./chat-card";

const CARD_CHANNELS = new Set(["generated_video", "youtube_organic"]);

const inputSchema = z.object({
  image_path: z
    .string()
    .min(1)
    .max(300)
    .describe("The exact image_path of a photo the founder attached in this workspace. It becomes the first frame of the video."),
  motion: z
    .string()
    .max(600)
    .optional()
    .describe("How the image should move: camera movement, what moves in the scene, mood. Leave out to use gentle natural motion."),
  caption: z.string().min(1).max(2200).describe("The social caption to post with it, ready as-is."),
});

export type AnimateImageInput = z.infer<typeof inputSchema>;

export function animateIntakeFor(input: AnimateImageInput): GenerativeVideoIntake {
  return generativeVideoIntakeSchema.parse({
    prompt: input.motion?.trim() || DEFAULT_ANIMATE_PROMPT,
    intent: "animate",
    premium: false,
    image_path: input.image_path,
  });
}

export function buildAnimateCard(input: AnimateImageInput, credits: number, channelSlug: string | null = "generated_video"): { title: string; body: Record<string, unknown> } {
  const title = "Animate your image";
  const costLine = `${credits.toLocaleString("en-US")} credits, charged only when the video arrives`;
  const motion = input.motion?.trim() || DEFAULT_ANIMATE_PROMPT;
  return {
    title,
    body: {
      step: {
        title,
        body: `Press ${makeButtonFor(channelSlug)} to turn your image into a video of about ${DEFAULT_CLIP_SECONDS} seconds that starts from your picture. It costs about ${costLine}. If it fails you are not charged.`,
        blocking: false,
        effort: "minutes",
        evidence: [],
        deliverable: { kind: "script", label: "How it moves", content: `${motion}\n\nCaption: ${input.caption}` },
      },
      exact_change: {
        rows: [
          { item: "Video", before: "Your image", after: `About ${DEFAULT_CLIP_SECONDS} seconds, starting from your image` },
          { item: "Cost", before: "Nothing yet", after: costLine },
        ],
      },
      video_format: "animate",
      image_path: input.image_path,
      cost_credits: credits,
      link: null,
    },
  };
}

type ProposeCtx = { tenant_id: string; run_id?: string; run_trigger?: string; writes_suppressed?: boolean; redo?: boolean; emit_decision?: unknown };

export const generatedVideoAnimateTool: ToolSpec = {
  name: "generated_video_animate",
  effect: "write",
  description:
    "Write ONE approvable card that turns a photo the founder attached into a short video starting from that photo. Pass the photo's exact image_path. Shows the credit cost; nothing is made until the founder presses Make video on it (Approve on a YouTube card), and credits are charged only when the video arrives.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    const input = inputSchema.parse(rawInput);
    if (speaksAsCustomer(input.motion ?? "") || asksForCustomerEndorsement(input.motion ?? "")) {
      throw new ExpectedToolError(
        "generated_video_customer_voice",
        "This motion has someone speak as a customer. Describe how the image moves, or have them explain the product in their own voice.",
      );
    }
    const pctx = ctx as unknown as ProposeCtx;
    await checkOwnImageForVendor(pctx.tenant_id, input.image_path);
    if ((await lookAtPresenterPhoto(pctx.tenant_id, input.image_path))?.has_person) {
      return { action_id: null, proposed: false, person_in_photo: true, note: `Nothing was written. This photo shows a person, so write a script with generated_video_propose and pass portrait_path "${input.image_path}". That person presents the video.` };
    }
    if (pctx.run_id && (await chatVideoCardFiled(pctx.tenant_id, pctx.run_id, GENERATED_VIDEO_RENDER_CLASS))) {
      return { action_id: null, proposed: false, one_card: true, note: ONE_CARD_NEXT };
    }
    const notThisChannel = async (): Promise<string> => "";
    let filedOn: string | null = null;
    const emit = await resolveChannelExecEmit(
      CARD_CHANNELS,
      { tenant_id: pctx.tenant_id, run_id: pctx.run_id, run_trigger: pctx.run_trigger, writes_suppressed: pctx.writes_suppressed, redo: pctx.redo, chat_answer_turn: isChatAnswerTurnEmit(pctx.emit_decision), emit_decision: notThisChannel },
      async (a) => {
        const intake = animateIntakeFor(input);
        const credits = await billedVideoCredits(intake);
        const { title, body } = buildAnimateCard(input, credits, a.channel_slug);
        const out = await recordChannelExecAction({
          tenantId: a.tenant_id,
          runId: a.run_id,
          channelSlug: a.channel_slug,
          execClass: GENERATED_VIDEO_RENDER_CLASS,
          execPayload: { intake, format: "animate", post: { title, description: input.caption } },
          actionType: "video_post",
          title,
          body,
        });
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
    if (filedOn === "generated_video" && pctx.run_id && (await showVideoCardInChat(pctx.tenant_id, pctx.run_id, action_id)) === "shown") {
      return { action_id, proposed: true, rendered: false, in_chat: true, note: `Card written and shown in this chat. NOTHING has been made and no credits were spent. ${CARD_IN_CHAT_NEXT}` };
    }
    return {
      action_id,
      proposed: true,
      rendered: false,
      note: `Card written. NOTHING has been made and no credits were spent. Tell the founder the animation is ready; it is made only after they press ${makeButtonFor(filedOn)} on it. ${whereToApprove(filedOn)}`,
    };
  },
};
