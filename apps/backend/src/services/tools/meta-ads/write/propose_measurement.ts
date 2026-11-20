
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { isMetaAdsWriteEnabled } from "./_flag-check";
import { createCustomConversionBodySchema, metaConversionEventSchema } from "./_decision-bodies";

const input = z.object({
  name: z.string().min(1).max(200),
  pixel_id: z.string().describe("From list_measurement kind pixels this turn."),
  custom_event_type: metaConversionEventSchema,
  url_contains: z.string().describe("Text in the URL of the page that proves the conversion, e.g. 'thank-you'."),
  about: z.string().optional(),
  rationale: rationaleInput(),
});

export const metaProposeCustomConversionTool: ToolSpec = {
  name: "meta_ads_propose_custom_conversion",
  effect: "write",
  description:
    "Propose a custom conversion: a pixel event narrowed to the URL that proves it, so ad sets can optimise for the real outcome. Spends nothing. A card the founder, or cgo on Autopilot with an ad budget, approves.",
  input_schema: input,
  async execute(ctx, raw) {
    if (!(await isMetaAdsWriteEnabled())) {
      throw new ExpectedToolError("meta_ads_write_disabled", "Meta Ads write is disabled at the platform level.");
    }
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError("meta_ads_propose_no_emit", "Cannot emit a decision in this context (no emit_decision plumbed).");
    }
    const a = input.parse(raw);
    const r = createCustomConversionBodySchema.safeParse({
      ...a,
      ...(isHumanAuthoredCommand(ctx, "budget") ? { origin: "user_initiated_chat" } : {}),
    });
    if (!r.success) {
      throw new ExpectedToolError("meta_ads_invalid_conversion_body", r.error.issues.map((i) => i.message).join(" | "));
    }
    const decision_id = await ctx.emit_decision("meta_ads.create_custom_conversion", r.data);
    return { decision_id, decision_class: "meta_ads.create_custom_conversion", notice: "Sent to approvals." };
  },
};
