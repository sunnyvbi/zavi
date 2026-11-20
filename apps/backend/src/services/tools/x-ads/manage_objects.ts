import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import {
  managementInput,
  X_MANAGE_CLASS,
} from "@/services/connectors/x-ads/management-schema";
import { readXManagementSnapshot } from "@/services/connectors/x-ads/management";
import { rationaleField, requireEmit } from "./_shared";

const inputSchema = z.object({
  request: managementInput,
  rationale: rationaleField,
});
export const xAdsProposeManageObjectsTool: ToolSpec = {
  name: "x_ads_propose_manage_objects",
  effect: "write",
  input_schema: inputSchema,
  description:
    "Propose campaign deletion; paused ad-group creation; ad-group deletion, status, bid, budget or schedule edits; attaching or removing existing promoted posts; adding or removing targeting criteria. Every operation requires human approval and fresh account permission/version checks. Promoted posts cannot be updated; removal disassociates the post and does not delete the original post. Use promoted entity ids for removals. Supported targeting is locations, keywords, follower seeds, language, interests and gender; obtain valid ids from X. End dates cannot be cleared by this tool.",
  async execute(ctx, input) {
    const emit = requireEmit(ctx.emit_decision);
    const { request, rationale } = inputSchema.parse(input);
    const snapshot = await readXManagementSnapshot(ctx.tenant_id, request);
    const description = request.operation.replaceAll("_", " ");
    const objectId =
      "promoted_tweet_id" in request
        ? request.promoted_tweet_id
        : "targeting_criterion_id" in request
          ? request.targeting_criterion_id
          : "line_item_id" in request
            ? request.line_item_id
            : request.campaign_id;
    const rows =
      request.operation === "update_ad_group"
        ? Object.entries(request.changes).map(([key, value]) => {
            const parent = snapshot.parent!;
            const prior =
              key === "daily_budget"
                ? parent.daily_budget_amount_local_micro == null
                  ? null
                  : parent.daily_budget_amount_local_micro / 1000000
                : key === "total_budget"
                  ? parent.total_budget_amount_local_micro == null
                    ? null
                    : parent.total_budget_amount_local_micro / 1000000
                  : key === "bid_amount"
                    ? parent.bid_amount_local_micro == null
                      ? null
                      : parent.bid_amount_local_micro / 1000000
                    : (parent as unknown as Record<string, unknown>)[key];
            return {
              item: key.replaceAll("_", " "),
              before: prior == null ? "not set" : String(prior),
              after: String(value),
            };
          })
        : [
            {
              item: description,
              before: `${snapshot.parent?.name ?? snapshot.campaign.name} (${objectId})`,
              after: JSON.stringify(request),
            },
          ];
    const body = {
      request,
      before: snapshot.before,
      name: snapshot.campaign.name,
      currency: snapshot.campaign.currency,
      rationale,
      summary: `Zavi will ${description} in campaign "${snapshot.campaign.name}".`,
      exact_change: {
        rows,
      },
    };
    const action_id = await emit(X_MANAGE_CLASS, body);
    return { action_id, status: "waiting_for_founder" };
  },
};
