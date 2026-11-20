
import { z } from "zod";
import { serviceClient } from "@/services/supabase";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isOutsidePaidChannel, paidChannelForAgent } from "@/services/agents/paid-channel-scope";

const inputSchema = z.object({
  provider: z.enum(["google_ads", "meta_ads", "tiktok_ads", "linkedin_ads", "chatgpt_ads"]),
  max_age_days: z.number().int().min(1).max(60).default(14),
});

export const getLatestSnapshotTool: ToolSpec = {
  name: "paid_acquisition_get_latest_snapshot",
  effect: "read",
  description:
    "Read the operator's most recent pasted ad-spend snapshot for a given provider when live data is unavailable, or for historical comparison. Paid specialists can read only their own channel or its declared provider. A pasted snapshot is historical evidence, not a live API read. Returns snapshot_missing if no snapshot within max_age_days.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { provider, max_age_days } = inputSchema.parse(input);
    if (isOutsidePaidChannel(ctx.agent_slug, provider)) {
      throw new ExpectedToolError(
        "channel_scope_mismatch",
        `This run is scoped to ${paidChannelForAgent(ctx.agent_slug)!.name}; read your own channel's snapshot. ${provider} belongs to its own specialist.`,
      );
    }
    const { data, error } = await serviceClient().rpc("get_latest_ad_snapshot", {
      p_tenant_id: ctx.tenant_id,
      p_provider: provider,
      p_max_age_days: max_age_days,
    });
    if (error) {
      throw new ExpectedToolError("snapshot_read_failed", error.message);
    }
    if (!data) {
      throw new ExpectedToolError(
        "snapshot_missing",
        `No ${provider} snapshot in the last ${max_age_days} days. The operator can paste one from the ${provider} tile in the channel drawer ("Paste ad snapshot")${
          provider === "tiktok_ads" || provider === "chatgpt_ads"
            ? ""
            : `, or connect ${provider}: if the user asked about ${provider} in chat, call connectors__request with slug "${provider}" instead of pointing them to Settings`
        }.`,
        { provider, max_age_days, next_step: "operator_action" },
      );
    }
    return data;
  },
};
