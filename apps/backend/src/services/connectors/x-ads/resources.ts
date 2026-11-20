import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";
import {
  assertId,
  toMicros,
  writeData,
  xAdsGet,
  deleteXEntity,
  type UserToken,
} from "./client";

const accessSchema = z.object({
  data: z.object({ user_id: z.string(), permissions: z.array(z.string()) }),
});
export async function readXAccess(token: UserToken, accountId: string) {
  const { data } = accessSchema.parse(
    await xAdsGet(
      token,
      `accounts/${assertId(accountId, "account_id")}/authenticated_user_access`,
    ),
  );
  return {
    ...data,
    can_read_campaigns: data.permissions.some((p) =>
      ["ACCOUNT_ADMIN", "AD_MANAGER", "CAMPAIGN_ANALYST"].includes(p),
    ),
    can_manage_campaigns: data.permissions.some((p) =>
      ["ACCOUNT_ADMIN", "AD_MANAGER"].includes(p),
    ),
    can_compose_posts: data.permissions.includes("TWEET_COMPOSER"),
    app_write_access: "unverified",
  };
}
export async function assertXComposeAccess(token: UserToken, accountId: string) {
  if (!(await readXAccess(token, accountId)).can_compose_posts)
    throw new ExpectedToolError(
      "x_ads_compose_denied",
      "Publishing a promoted-only post needs the \"compose promotable posts\" permission (TWEET_COMPOSER) on this X Ads account. Ask the account admin to grant it, or promote an existing post instead.",
    );
}
export async function assertXWriteAccess(token: UserToken, accountId: string) {
  if (!(await readXAccess(token, accountId)).can_manage_campaigns)
    throw new ExpectedToolError(
      "x_ads_permission_denied",
      "X Ads campaign changes require ACCOUNT_ADMIN or AD_MANAGER. App-level write access is still enforced by X on each request.",
    );
}

export type XLineItem = {
  id: string;
  campaign_id: string;
  name?: string;
  objective: string;
  product_type: string;
  placements: string[];
  entity_status: string;
  start_time: string;
  end_time: string | null;
  bid_strategy: string;
  bid_amount_local_micro: number | null;
  daily_budget_amount_local_micro: number | null;
  total_budget_amount_local_micro: number | null;
  currency: string;
  primary_web_event_tag?: string | null;
  updated_at: string;
  deleted?: boolean;
};
export type XPromotedAd = {
  id: string;
  line_item_id: string;
  tweet_id: string;
  entity_status: string;
  approval_status?: string;
  updated_at: string;
  deleted?: boolean;
};
export type XTarget = {
  id: string;
  line_item_id: string;
  targeting_type: string;
  targeting_value: string;
  operator_type: string;
  updated_at: string;
  deleted?: boolean;
};
export type XResource = "line_items" | "promoted_tweets" | "targeting_criteria";
export async function listXResources<T extends { id: string }>(
  token: UserToken,
  accountId: string,
  resource: XResource,
  params: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: { data?: T[]; next_cursor?: string | null } = await xAdsGet(
      token,
      `accounts/${assertId(accountId, "account_id")}/${resource}`,
      { count: "200", ...params, ...(cursor ? { cursor } : {}) },
    );
    if (!Array.isArray(page.data) || page.data.some((r) => !r.id))
      throw new ExpectedToolError(
        "x_ads_bad_response",
        "X Ads returned an incomplete object list.",
      );
    out.push(...page.data);
    cursor = page.next_cursor || null;
    if (cursor && (seen.has(cursor) || out.length >= 10000))
      throw new ExpectedToolError(
        "x_ads_inventory_incomplete",
        "X Ads inventory could not be read completely.",
      );
    if (cursor) seen.add(cursor);
  } while (cursor);
  return out;
}
export async function getXResource<T extends { id: string; deleted?: boolean }>(
  token: UserToken,
  accountId: string,
  resource: XResource,
  id: string,
): Promise<T> {
  const { data } = await xAdsGet<{ data?: T }>(
    token,
    `accounts/${assertId(accountId, "account_id")}/${resource}/${assertId(id, "object_id")}`,
  );
  if (data?.id !== id || data.deleted)
    throw new ExpectedToolError(
      "x_ads_not_found",
      "The X Ads object is missing or deleted.",
    );
  return data;
}
export function deleteXResource(
  token: UserToken,
  accountId: string,
  resource: XResource,
  id: string,
) {
  return deleteXEntity(
    token,
    `accounts/${assertId(accountId, "account_id")}/${resource}/${assertId(id, "object_id")}`,
    id,
  );
}
export type XLineChanges = {
  name?: string;
  entity_status?: "PAUSED" | "ACTIVE";
  bid_strategy?: "AUTO" | "MAX" | "TARGET";
  bid_amount?: number;
  start_time?: string;
  end_time?: string;
  daily_budget?: number;
  total_budget?: number;
};
export function updateXLineItem(
  token: UserToken,
  accountId: string,
  id: string,
  changes: XLineChanges,
) {
  const params = Object.fromEntries(
    Object.entries(changes).map(([k, v]) =>
      k === "bid_amount" || k === "daily_budget" || k === "total_budget"
        ? [
            k === "bid_amount"
              ? "bid_amount_local_micro"
              : `${k}_amount_local_micro`,
            toMicros(Number(v)),
          ]
        : [k, String(v)],
    ),
  );
  return writeData<XLineItem>(
    token,
    "PUT",
    `accounts/${assertId(accountId, "account_id")}/line_items/${assertId(id, "line_item_id")}`,
    params,
  );
}
export function assertXLineChanges(line: XLineItem, changes: XLineChanges) {
  const strategy = changes.bid_strategy ?? line.bid_strategy;
  const bid =
    changes.bid_amount ??
    (line.bid_amount_local_micro == null
      ? null
      : line.bid_amount_local_micro / 1000000);
  if (strategy !== "AUTO" && (!bid || bid <= 0))
    throw new ExpectedToolError(
      "x_ads_bid_invalid",
      "MAX and TARGET require a positive bid amount.",
    );
  if (
    (strategy === "MAX" && ["REACH", "FOLLOWERS"].includes(line.objective)) ||
    (strategy === "TARGET" &&
      !["REACH", "WEBSITE_CLICKS"].includes(line.objective))
  )
    throw new ExpectedToolError(
      "x_ads_bid_unsupported",
      "This bid strategy is not documented for updates to this objective.",
    );
  const start = changes.start_time ?? line.start_time;
  const end = changes.end_time ?? line.end_time;
  if (
    end &&
    (Date.parse(end) <= Date.parse(start) || Date.parse(end) <= Date.now())
  )
    throw new ExpectedToolError(
      "x_ads_dates_invalid",
      "End time must be in the future and after start time.",
    );
  const daily =
    changes.daily_budget ??
    (line.daily_budget_amount_local_micro == null
      ? null
      : line.daily_budget_amount_local_micro / 1000000);
  const total =
    changes.total_budget ??
    (line.total_budget_amount_local_micro == null
      ? null
      : line.total_budget_amount_local_micro / 1000000);
  if (daily != null && total != null && daily > total)
    throw new ExpectedToolError(
      "x_ads_budget_invalid",
      "Daily budget exceeds total budget.",
    );
}
