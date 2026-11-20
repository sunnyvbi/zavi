import { ExpectedToolError } from "@/services/tools/types";
import {
  createXLineItem,
  deleteXCampaign,
  getXCampaign,
  promoteXTweets,
  writeData,
  xAdsTenantToken,
} from "./client";
import { managementBody, type XManagementInput } from "./management-schema";
import {
  assertXLineChanges,
  assertXWriteAccess,
  deleteXResource,
  getXResource,
  listXResources,
  updateXLineItem,
  type XLineItem,
  type XPromotedAd,
  type XTarget,
} from "./resources";
import {
  fail,
  isResult,
  prepare,
  type XExecRow,
  type XExecResult,
} from "./execute";
import { reserveXSpend, settleXSpend } from "./spend";
import { releaseAdSpendForObject } from "@/services/decisions/ad-budget";

export async function readXManagementSnapshot(
  tenantId: string,
  request: XManagementInput,
) {
  const token = await xAdsTenantToken(tenantId);
  await assertXWriteAccess(token, request.account_id);
  const campaign = await getXCampaign(
    token,
    request.account_id,
    request.campaign_id,
  );
  if (!campaign?.updated_at)
    throw new ExpectedToolError(
      "x_ads_snapshot_missing",
      "Cannot verify the campaign version. Read it again before proposing a change.",
    );
  let objectUpdatedAt: string | null = null;
  let parent: XLineItem | null = null;
  if ("line_item_id" in request) {
    parent = await getXResource<XLineItem>(
      token,
      request.account_id,
      "line_items",
      request.line_item_id,
    );
    if (parent.campaign_id !== request.campaign_id || !parent.updated_at)
      throw new ExpectedToolError(
        "x_ads_parent_mismatch",
        "The ad group does not belong to this campaign or its version is missing.",
      );
    objectUpdatedAt = parent.updated_at;
    if (request.operation === "update_ad_group")
      assertXLineChanges(parent, request.changes);
    if (
      request.operation === "remove_promoted_ad" ||
      request.operation === "remove_target"
    ) {
      const resource =
        request.operation === "remove_promoted_ad"
          ? "promoted_tweets"
          : "targeting_criteria";
      const id =
        request.operation === "remove_promoted_ad"
          ? request.promoted_tweet_id
          : request.targeting_criterion_id;
      const obj = await getXResource<XPromotedAd | XTarget>(
        token,
        request.account_id,
        resource,
        id,
      );
      if (obj.line_item_id !== request.line_item_id || !obj.updated_at)
        throw new ExpectedToolError(
          "x_ads_parent_mismatch",
          "The object does not belong to this ad group or its version is missing.",
        );
      objectUpdatedAt = obj.updated_at;
    }
  }
  if (request.operation === "create_ad_group") {
    if (
      Date.parse(request.end_time) <=
      Math.max(Date.parse(request.start_time), Date.now())
    )
      throw new ExpectedToolError(
        "x_ads_dates_invalid",
        "End time must be in the future and after start time.",
      );
    const groups = await listXResources<XLineItem>(
      token,
      request.account_id,
      "line_items",
      { campaign_ids: request.campaign_id },
    );
    if (
      groups.length >= 100 ||
      groups.some(
        (g) =>
          g.objective !== request.objective ||
          g.product_type !==
            (request.objective === "FOLLOWERS"
              ? "PROMOTED_ACCOUNT"
              : "PROMOTED_TWEETS"),
      )
    )
      throw new ExpectedToolError(
        "x_ads_ad_group_incompatible",
        "Campaigns require matching objectives and product types, and allow at most 100 ad groups.",
      );
  }
  if (
    request.operation === "add_target" &&
    request.targeting_type !== "LOCATION" &&
    !request.targeting_type.includes("KEYWORD") &&
    request.operator_type !== "EQ"
  )
    throw new ExpectedToolError(
      "x_ads_target_unsupported",
      "Exclusions in this tool are limited to location and keyword targeting.",
    );
  return {
    campaign,
    parent,
    before: {
      campaign_updated_at: campaign.updated_at,
      object_updated_at: objectUpdatedAt,
      parent_updated_at: parent?.updated_at ?? null,
    },
  };
}

export async function executeXManageObjects(
  row: XExecRow,
): Promise<XExecResult> {
  const ready = await prepare(row, managementBody, () => false);
  if (isResult(ready)) return ready;
  const { b, t } = ready;
  const p = b.request;
  let spend: Awaited<ReturnType<typeof reserveXSpend>> | undefined;
  let wrote = false;
  try {
    const live = await readXManagementSnapshot(row.tenant_id, p);
    if (JSON.stringify(live.before) !== JSON.stringify(b.before))
      throw new ExpectedToolError(
        "x_ads_object_drifted",
        "This campaign or ad group changed since approval was requested. Propose it again.",
      );
    if (p.operation === "update_ad_group") {
      const parent = live.parent!;
      const daily =
        parent.daily_budget_amount_local_micro == null
          ? null
          : parent.daily_budget_amount_local_micro / 1000000;
      const delta =
        p.changes.entity_status === "ACTIVE" &&
        parent.entity_status !== "ACTIVE"
          ? (p.changes.daily_budget ?? daily ?? live.campaign.daily_budget)
          : p.changes.daily_budget === undefined
            ? 0
            : Math.max(0, p.changes.daily_budget - (daily ?? 0));
      if (delta === null)
        throw new ExpectedToolError(
          "x_ads_budget_unknown",
          "Cannot activate an ad group without a readable daily cap.",
        );
      if (delta > 0)
        spend = await reserveXSpend(
          row,
          "resume",
          p.campaign_id,
          delta,
          live.campaign.currency,
        );
      wrote = true;
      await updateXLineItem(t, p.account_id, p.line_item_id, p.changes);
    } else if (p.operation === "create_ad_group") {
      wrote = true;
      const group = await createXLineItem(t, p.account_id, {
        ...p,
        entity_status: "PAUSED",
      });
      if (group.entity_status !== "PAUSED")
        throw new ExpectedToolError(
          "x_ads_outcome_unknown",
          `Ad group ${group.id} was not confirmed paused. Check Ads Manager before retrying.`,
        );
      return {
        ok: true,
        notice:
          "Created the ad group paused. Activation requires another approval.",
        agent_outcome: JSON.stringify({
          line_item_id: group.id,
          status: "PAUSED",
        }),
        created: {
          platform: "x",
          object_type: "ad_group",
          id: group.id,
          status: "PAUSED",
        },
      };
    } else {
      wrote = true;
      if (p.operation === "delete_campaign")
        await deleteXCampaign(t, p.account_id, p.campaign_id);
      if (p.operation === "delete_ad_group")
        await deleteXResource(t, p.account_id, "line_items", p.line_item_id);
      if (p.operation === "remove_promoted_ad")
        await deleteXResource(
          t,
          p.account_id,
          "promoted_tweets",
          p.promoted_tweet_id,
        );
      if (p.operation === "remove_target")
        await deleteXResource(
          t,
          p.account_id,
          "targeting_criteria",
          p.targeting_criterion_id,
        );
      if (p.operation === "add_promoted_ads")
        await promoteXTweets(t, p.account_id, p.line_item_id, p.tweet_ids);
      if (p.operation === "add_target")
        await writeData<XTarget>(
          t,
          "POST",
          `accounts/${p.account_id}/targeting_criteria`,
          {
            line_item_id: p.line_item_id,
            targeting_type: p.targeting_type,
            targeting_value: p.targeting_value,
            operator_type: p.operator_type,
          },
        );
    }
    if (spend) await settleXSpend(spend, p.campaign_id);
    if (p.operation === "delete_campaign")
      await releaseAdSpendForObject(row.tenant_id, "x", p.campaign_id);
    return {
      ok: true,
      notice: `Applied ${p.operation.replaceAll("_", " ")} in X Ads. Delivery is not yet verified.`,
    };
  } catch (e) {
    if (spend) await settleXSpend(spend, null, e, wrote);
    const r = fail(e);
    return wrote &&
      ["create_ad_group", "add_promoted_ads", "add_target"].includes(
        p.operation,
      ) &&
      r.outcome_unknown
      ? { ...r, code: "exec_outcome_unknown" }
      : r;
  }
}
