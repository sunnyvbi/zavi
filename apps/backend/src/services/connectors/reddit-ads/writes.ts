import { composioExecuteTool, composioProxy } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";
import { notePlatformWrite } from "@/services/channels/write-fence";
import { detailOf, endpoint, failureCode, inferStatus, objectSchema, payload, record, type RedditAccount, type RedditObject } from "./adapter";
import { redditId, type RedditLevel } from "./identifiers";

const REQUEST_TIMEOUT_MS = 60_000;
const RESOURCE: Record<RedditLevel, string> = { campaign: "campaigns", ad_group: "ad_groups", ad: "ads" };

export function rejectionReason(detail: string): string {
  const text = detail.replace(/\\"/g, '"');
  const fields = [...text.matchAll(/"field"\s*:\s*"([^"]+)"\s*,\s*"message"\s*:\s*"([^"]+)"|"message"\s*:\s*"([^"]+)"\s*,\s*"field"\s*:\s*"([^"]+)"/g)]
    .map((m) => `${m[1] ?? m[4]}: ${m[2] ?? m[3]}`);
  if (fields.length) return [...new Set(fields)].join("; ");
  const message = /"message"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  return message ?? (detail.slice(0, 300) || "Reddit rejected the request");
}

export function writeFailure(rawStatus: number, error: unknown, unknownOutcome = false): ExpectedToolError {
  const detail = detailOf(error);
  const status = inferStatus(rawStatus, detail);
  const unknown = unknownOutcome || status === 0 || status >= 500;
  const code = unknown ? "reddit_ads_outcome_unknown" : failureCode(status);
  if (code === "reddit_ads_invalid_request") return new ExpectedToolError(code, `Reddit rejected the request: ${rejectionReason(detail).replace(/\.+$/, "")}.`, { status, outcome_unknown: false, detail: detail.slice(0, 500) });
  return new ExpectedToolError(code, detail?.slice(0, 500) || `Reddit Ads HTTP ${status}`, { status, outcome_unknown: unknown });
}

function wrappedRejectStatus(data: unknown): number | null {
  for (const d of [data, record(data) ? data.data : null]) {
    if (!record(d)) continue;
    const s = Number(d.status_code ?? d.status);
    if (s === 400 || s === 422) return s;
  }
  return null;
}

async function writeTool(account: RedditAccount, slug: string, args: Record<string, unknown>): Promise<unknown> {
  notePlatformWrite();
  const r = await composioExecuteTool(
    { tool_slug: `REDDIT_ADS_${slug}`, user_id: account.tenant_id, connected_account_id: account.connected_account_id, arguments: args },
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  );
  if (r.ok) return r.data;
  throw writeFailure(!r.outcome_unknown && r.status === 200 ? wrappedRejectStatus(r.data) ?? r.status : r.status, r.error, r.outcome_unknown);
}

async function writeProxy(account: RedditAccount, method: "POST" | "PATCH", url: string, data: Record<string, unknown>): Promise<unknown> {
  notePlatformWrite();
  const r = await composioProxy({ account, method, endpoint: url, body: { data } }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  if (r.ok) return r.json;
  throw writeFailure(r.status, { response: r.json, rate_limit: r.rate_limit });
}

function createdObject(raw: unknown, message: string): RedditObject {
  const parsed = objectSchema.safeParse(payload(raw));
  if (!parsed.success) throw writeFailure(200, message, true);
  return parsed.data;
}

export async function patchObject(account: RedditAccount, level: RedditLevel, id: string, data: Record<string, unknown>): Promise<void> {
  if (level === "campaign") {
    await writeTool(account, "UPDATE_CAMPAIGN", { campaign_id: redditId.parse(id), data });
    return;
  }
  await writeProxy(account, "PATCH", endpoint(RESOURCE[level], id), data);
}

export async function createObject(account: RedditAccount, accountId: string, level: RedditLevel, data: Record<string, unknown>): Promise<RedditObject> {
  const raw = level === "ad"
    ? await writeProxy(account, "POST", endpoint("ad_accounts", accountId, "/ads"), data)
    : await writeTool(account, level === "campaign" ? "CREATE_CAMPAIGN" : "CREATE_AD_GROUP", { ad_account_id: accountId, data });
  return createdObject(raw, "Create accepted but Reddit returned no usable object ID. Reconcile before retrying.");
}

export async function createImagePost(account: RedditAccount, profileId: string, data: Record<string, unknown>): Promise<RedditObject> {
  const raw = await writeProxy(account, "POST", endpoint("profiles", profileId, "/posts"), data);
  return createdObject(raw, "Post accepted without a usable ID; reconcile before retrying.");
}
