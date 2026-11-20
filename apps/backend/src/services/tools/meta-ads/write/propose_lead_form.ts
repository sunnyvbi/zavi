
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";
import { isMetaAdsWriteEnabled } from "./_flag-check";
import { createLeadFormBodySchema } from "./_decision-bodies";

const input = z.object({
  page_id: z.string().describe("From list_pages this turn."),
  page_name: z.string().optional(),
  name: z.string().min(1).max(200),
  questions: z
    .array(z.object({ type: z.string(), key: z.string().optional(), label: z.string().optional() }))
    .describe("Standard types (EMAIL, FULL_NAME, PHONE, CITY, ZIP, COMPANY_NAME, JOB_TITLE, ...) or {type:'CUSTOM', key, label}. Ask only what the business needs."),
  privacy_policy_url: z.string().describe("The founder's own https privacy policy. Never invent one."),
  privacy_link_text: z.string().optional(),
  follow_up_action_url: z.string().describe("The https page the thank-you screen links to."),
  about: z.string().optional(),
  rationale: rationaleInput(),
});

export const metaProposeLeadFormTool: ToolSpec = {
  name: "meta_ads_propose_lead_form",
  effect: "write",
  description:
    "Propose a lead form on one of the founder's Facebook Pages, for lead ads. It collects people's contact details under the founder's privacy policy, so only the founder approves it.",
  input_schema: input,
  async execute(ctx, raw) {
    if (!(await isMetaAdsWriteEnabled())) {
      throw new ExpectedToolError("meta_ads_write_disabled", "Meta Ads write is disabled at the platform level.");
    }
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError("meta_ads_propose_no_emit", "Cannot emit a decision in this context (no emit_decision plumbed).");
    }
    const a = input.parse(raw);
    const r = createLeadFormBodySchema.safeParse({ ...a, ...(isHumanAuthoredCommand(ctx, "budget") ? { origin: "user_initiated_chat" } : {}) });
    if (!r.success) {
      throw new ExpectedToolError("meta_ads_invalid_lead_form", r.error.issues.map((i) => i.message).join(" | "));
    }
    const decision_id = await ctx.emit_decision("meta_ads.create_lead_form", r.data);
    return { decision_id, decision_class: "meta_ads.create_lead_form", notice: "Sent to the founder for approval." };
  },
};
