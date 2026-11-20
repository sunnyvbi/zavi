
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { channelForAgent } from "@/services/agents/channel-agents";
import {
  STANDING_ORDER_PROMPT_MAX,
  findSecretLiteral,
} from "@/services/agents/standing-orders";
import { getSchedule } from "@/services/agents/schedules";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { isValidTimeZone, validateCronExpression } from "../../../../workers/functions/cron-match";

export const CHANNEL_STANDING_ORDER_CLASS = "channel.create-standing-order";

const CONVERSATIONAL_TRIGGERS = new Set(["handoff", "chat"]);

const inputSchema = z.object({
  cron_expression: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Standard 5-field cron evaluated in `timezone`, e.g. '0 13 * * *' = every day at 13:00 local. Minimum cadence 5 minutes; daily is the normal case.",
    ),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .describe("IANA zone the cron runs in, e.g. 'Asia/Calcutta' or 'America/Los_Angeles'."),
  prompt: z
    .string()
    .min(1)
    .max(STANDING_ORDER_PROMPT_MAX)
    .describe(
      `The daily brief a run reads as its prompt, under ${STANDING_ORDER_PROMPT_MAX} characters. It must stand alone: the voice rules, the sources and tools by name, the window each run covers, the destination link, how many posts/threads a day, and the exact readback format. Never include credentials.`,
    ),
});

export async function resolveDeliveryThread(tenant_id: string, run_id: string): Promise<string | null> {
  const { data } = await tenantClient(asTenantId(tenant_id))
    .from("agent_runs")
    .select("payload")
    .eq("id", run_id)
    .maybeSingle();
  const p = (data as { payload?: Record<string, unknown> } | null)?.payload;
  if (!p || typeof p !== "object") return null;
  for (const k of ["operator_thread_id", "thread_id"]) {
    const v = p[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export const socialProposeStandingOrderTool: ToolSpec = {
  name: "social_propose_standing_order",
  effect: "write",
  description:
    "Propose this channel's daily brief as a schedule: a cron + timezone and the prompt each run starts from. Schedules NOTHING — it stages one approval card; the founder's approval creates the schedule, and a new one replaces the old (one per channel). Call it once, at the end of a set-up conversation, after the founder has answered the voice questions and seen the first week.",
  input_schema: inputSchema,
  execute: async (ctx, rawInput) => {
    if (!ctx.emit_decision) {
      throw new ExpectedToolError(
        "standing_order_no_emit",
        "Cannot propose a schedule in this context — the runner did not plumb emit_decision.",
      );
    }
    const slug = ctx.agent_slug ?? "";
    const channel = channelForAgent(slug);
    if (!channel) {
      throw new ExpectedToolError(
        "standing_order_not_channel_agent",
        "Only a channel agent can propose its own schedule.",
      );
    }
    if (!ctx.run_trigger || !CONVERSATIONAL_TRIGGERS.has(ctx.run_trigger)) {
      throw new ExpectedToolError(
        "standing_order_wrong_surface",
        "A schedule is proposed from a conversation with the founder, not from a scheduled run.",
      );
    }
    const input = inputSchema.parse(rawInput);
    const cron = input.cron_expression.trim();
    const cronErr = validateCronExpression(cron);
    if (cronErr) throw new ExpectedToolError("standing_order_bad_cron", cronErr);
    const timezone = input.timezone.trim();
    if (!isValidTimeZone(timezone)) {
      throw new ExpectedToolError(
        "standing_order_bad_timezone",
        `${timezone} is not an IANA zone (e.g. Asia/Calcutta).`,
      );
    }
    const secret = findSecretLiteral(input.prompt);
    if (secret) {
      throw new ExpectedToolError(
        "standing_order_secret_in_prompt",
        `The prompt appears to contain a secret (${secret}); scheduled runs must never carry credentials.`,
      );
    }
    if (!ctx.run_id) {
      throw new ExpectedToolError("standing_order_no_run", "No run context.");
    }
    const thread_id = await resolveDeliveryThread(ctx.tenant_id, ctx.run_id);
    if (!thread_id) {
      throw new ExpectedToolError(
        "standing_order_no_thread",
        "This conversation has no chat thread to deliver the daily brief into.",
      );
    }

    let replaces_existing = false;
    try {
      replaces_existing = (await getSchedule(ctx.tenant_id, slug)) !== null;
    } catch {
    }

    const decision_id = await ctx.emit_decision(CHANNEL_STANDING_ORDER_CLASS, {
      cron_expression: cron,
      timezone,
      standing_order: {
        prompt: input.prompt,
        deliver: { kind: "chat_thread", thread_id },
      },
      channel_slug: channel.channel_slug,
      channel_name: channel.name,
      replaces_existing,
    });

    return {
      decision_id,
      decision_class: CHANNEL_STANDING_ORDER_CLASS,
      channel: channel.channel_slug,
      cron_expression: cron,
      timezone,
      replaces_existing,
      scheduled: false,
      note: replaces_existing
        ? `Proposed for approval. This replaces the existing ${channel.name} schedule once the founder approves it; nothing changes until then.`
        : "Proposed for approval. The schedule exists only after the founder approves it.",
    };
  },
};
