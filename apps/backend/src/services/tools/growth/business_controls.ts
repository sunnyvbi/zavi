import { z } from "zod";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import {
  readBusinessPolicy,
  recommendBusinessPolicy,
} from "@/services/growth/business-control-policy";
import { readExperiments } from "@/services/growth/experiment-controls";
import { businessPolicySchema } from "@/services/growth/business-control-policy";
import { isHumanAuthoredChat } from "@/services/agents/untrusted-context";
import { BUSINESS_CONTROLS_CLASS } from "@/services/growth/business-control-proposal";

const proposalInputSchema = z
  .object({
    policy: businessPolicySchema,
    rationale: z.string().trim().min(1).max(2000),
  })
  .strict();

export const proposeBusinessControlsTool: ToolSpec = {
  name: "growth_propose_business_controls",
  effect: "write",
  description:
    "Propose editable Business results and experiments settings in this chat. Call when the user asks to set/save recommended limits. Read saved controls first; supply all values and explain evidence versus assumptions. Creates an approval card only: an owner/admin must review and click Approve and save. Never claims saved, enables Autopilot, changes the monthly budget, registers experiments or launches ads.",
  input_schema: proposalInputSchema,
  async execute(ctx, raw) {
    if (
      ctx.writes_suppressed ||
      !ctx.emit_decision ||
      !ctx.run_id ||
      !isHumanAuthoredChat(ctx)
    )
      throw new ExpectedToolError(
        "business_controls_proposal_unavailable",
        "An approval proposal requires a live run.",
      );
    const input = proposalInputSchema.parse(raw);
    const saved = await readBusinessPolicy(ctx.tenant_id);
    const { revision: _revision, updated_at: _at, ...previous } = saved ?? {};
    const decision_id = await ctx.emit_decision(BUSINESS_CONTROLS_CLASS, {
      ...input,
      revision: saved?.revision ?? 0,
      previous_policy: saved ? businessPolicySchema.parse(previous) : null,
    });
    return {
      decision_id,
      decision_class: BUSINESS_CONTROLS_CLASS,
      status: "pending_approval",
      saved: false,
      notice:
        "The editable approval card is in this chat. Nothing is saved until an owner/admin clicks Approve and save. No experiment was registered.",
    };
  },
};

export const readBusinessControlsTool: ToolSpec = {
  name: "growth_read_business_controls",
  effect: "read",
  description:
    "Read saved owner business-result limits, stop permission and enforced experiment budgets/status. Recommendations are editable starting points, not permission. A queued stop is not confirmed stopped. This is separate from measured experiment readouts.",
  input_schema: z.object({}).strict(),
  async execute(ctx) {
    const [policy, experiments] = await Promise.all([
      readBusinessPolicy(ctx.tenant_id),
      readExperiments(ctx.tenant_id),
    ]);
    return { policy, recommendation: recommendBusinessPolicy([]), experiments };
  },
};
