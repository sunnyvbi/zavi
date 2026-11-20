
import { parseDirectAdAsk } from "@/services/growth/direct-ad-ask";
import { z } from "zod";
import { ExpectedToolError, type ToolContext, type ToolSpec } from "@/services/tools/types";
import { isFounderChatOrder } from "@/services/agents/untrusted-context";
import { WILL_QUEUE, type ChatAskRequest } from "@/services/growth/chat-ask";

export const startChannelWorkInputSchema = z
  .object({
    ask: z.string().trim().min(1).max(400).describe("One line: the channel work the founder asked for, in plain words."),
    channels: z
      .array(z.string().trim().regex(/^[a-z0-9_-]{1,40}$/))
      .max(10)
      .optional()
      .describe("Channel slugs the founder named, if any."),
  })
  .strict();

export type StartChannelWorkStatus = typeof WILL_QUEUE | "already_queued" | "daily_cap" | "autopilot_off" | "no_active_goals" | "linkedin_order_elsewhere";

export type StartChannelWorkResult = {
  status: StartChannelWorkStatus;
  say: string;
  request?: ChatAskRequest;
};

export type StartChannelWorkDeps = {
  founderWords: (tenant_id: string, run_id: string, user_id: string | null) => Promise<string | null>;
  admission: (tenant_id: string) => Promise<"no_active_goals" | "autopilot_off" | "daily_cap" | null>;
  pending: (tenant_id: string) => Promise<{ id: string; key: string } | null>;
};

export const START_CHANNEL_WORK_SAY: Record<StartChannelWorkStatus, string> = {
  [WILL_QUEUE]:
    "I'll queue a goal review with your ask as soon as this reply is saved. It hands out the channel work your goals and plan allow, as cards on the Growth page (under Autopilot some channels may start on their own); it may hand out none, and it will say why.",
  already_queued:
    "A goal review with an earlier ask from this chat is already queued or running, and this ask is not in it. Ask again once its cards are on the Growth page.",
  daily_cap: "Today's goal reviews are used up, so I can't start one for this. Ask me again tomorrow, or run the channel from its own page now.",
  autopilot_off:
    "Autopilot is off, so I can't hand out channel work from here. Turn Autopilot on from the Growth page, or run the channel from its own page.",
  no_active_goals: "There is no active goal for a review to work on, so I can't hand out channel work. Set a goal on the Growth page first.",
  linkedin_order_elsewhere:
    "I can't start a LinkedIn launch with a set amount from this chat, so nothing was started. Send the same message in the main Zavi chat or on the LinkedIn Ads page, where it stays your order and waits for your approval.",
};

export async function runStartChannelWork(ctx: ToolContext, raw: unknown, deps: StartChannelWorkDeps): Promise<StartChannelWorkResult> {
  if (
    ctx.agent_slug !== "cgo" ||
    ctx.writes_suppressed ||
    typeof ctx.run_id !== "string" ||
    !ctx.run_id ||
    ctx.run_trigger !== "chat" ||
    !isFounderChatOrder(ctx) ||
    ctx.founder_order_unverified === true
  ) {
    throw new ExpectedToolError(
      "start_channel_work_unavailable",
      "Channel work can be started only from a Growth chat message the workspace owner or an admin typed.",
    );
  }
  const input = startChannelWorkInputSchema.parse(raw);
  const run_id = ctx.run_id;
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    console.info(JSON.stringify({ event: "cgo.chat_ask.start_channel_work", tenant_id: ctx.tenant_id, run_id, outcome, ...extra }));

  let words: string | null;
  try {
    words = await deps.founderWords(ctx.tenant_id, run_id, ctx.actor?.actor_user_id ?? null);
  } catch (e) {
    log("words_unreadable", { error: (e as Error).message.slice(0, 200) });
    throw new ExpectedToolError("start_channel_work_unavailable", "Your message could not be read just now. Tell the founder to ask again in a few minutes.");
  }
  if (!words) {
    log("not_founder_message");
    throw new ExpectedToolError(
      "start_channel_work_unavailable",
      "Channel work can be started only from a Growth chat message the workspace owner or an admin typed.",
    );
  }

  if (parseDirectAdAsk(words, { adWordOptional: true })?.channel_slug === "linkedin_ads") {
    log("linkedin_order_elsewhere");
    return { status: "linkedin_order_elsewhere", say: START_CHANNEL_WORK_SAY.linkedin_order_elsewhere };
  }
  const blocked = await deps.admission(ctx.tenant_id);
  if (blocked) {
    log(blocked);
    return { status: blocked, say: START_CHANNEL_WORK_SAY[blocked] };
  }
  const pending = await deps.pending(ctx.tenant_id);
  if (pending) {
    log("already_queued", { review_run_id: pending.id });
    return { status: "already_queued", say: START_CHANNEL_WORK_SAY.already_queued };
  }
  const request: ChatAskRequest = { ask: input.ask, channels: [...new Set(input.channels ?? [])] };
  log(WILL_QUEUE);
  return { status: WILL_QUEUE, say: START_CHANNEL_WORK_SAY[WILL_QUEUE], request };
}

const realDeps: StartChannelWorkDeps = {
  founderWords: async (t, r, u) => (await import("@/services/growth/chat-ask")).readChatAskWords(t, r, u),
  admission: async (t) => (await import("@/services/growth/goal-owner")).chatAskAdmission(t),
  pending: async (t) => (await import("@/services/growth/chat-ask")).pendingChatAsk(t),
};

export const startChannelWorkTool: ToolSpec = {
  name: "growth_start_channel_work",
  effect: "write",
  description:
    "Start channel work the founder asks for in this chat (run, rerun or reset a channel's content, build campaigns, make posts; not one AI video, which is praxis__render_video with generative_intent). It checks the founder may start it now; when the answer is will_queue, a goal review with their ask is queued right after this reply and hands the work out as cards on the Growth page. Call it once per ask, then tell the founder the returned `say` line in your words. Never say the work is done or that cards exist.",
  input_schema: startChannelWorkInputSchema,
  execute: (ctx, raw) => runStartChannelWork(ctx, raw, realDeps),
};
