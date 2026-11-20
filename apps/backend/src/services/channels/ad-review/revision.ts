import { createHash } from "node:crypto";
import { z } from "zod";
import { isPartialRiskExecCode, type AdReviewResponse } from "@zavi/shared";
import { editFields, reviseAdPayload } from "./adapters";
import { adReviewVersion, record } from "./version";
import { projectAdReview } from "../ad-review-presentation";
import { resolveAdReviewMedia } from "./media";
import { CHATGPT_CREATE, growthCreateBody } from "@/services/connectors/chatgpt-ads/growth-actions";
import { execPlatformLabel } from "../exec-kill-switch";

export const reviewRowSchema = z.object({
  id: z.string(), channel_slug: z.string(), exec_class: z.string().nullable(), exec_payload: z.unknown(),
  body: z.unknown(), status: z.string(), exec_status: z.string().nullable(), exec_result: z.unknown().optional(), object_changes: z.boolean().optional(), approvals: z.number().optional(), approved_by: z.string().nullable(),
  score: z.number(), score_inputs: z.unknown(), blocking: z.boolean(), impact: z.number().nullable(), impact_reason: z.string().nullable(),
});
export type ReviewRow = z.infer<typeof reviewRowSchema>;
const cache = new Map<string, { expires: number; review: AdReviewResponse["review"] }>();
const pending = new Map<string, Promise<AdReviewResponse["review"]>>();
const CONNECTION_FAILURES = new Set(["meta_ads_not_connected", "meta_ads_connector_missing", "meta_ads_token_expired", "google_ads_not_connected", "google_ads_oauth_refresh_failed", "google_ads_token_revoked", "google_ads_unauthenticated", "linkedin_ads_not_connected", "tiktok_ads_not_connected", "x_ads_not_connected", "reddit_ads_not_connected"]);

export function failedWithNothingMade(row: Pick<ReviewRow, "exec_status" | "exec_result" | "object_changes" | "approvals">): boolean {
  if (row.exec_status !== "failed" || row.object_changes !== false || row.approvals !== 1 || !record(row.exec_result)) return false;
  const res = row.exec_result;
  if (res.nothing_written !== true || res.interrupted === true || res.lease_expired === true || isPartialRiskExecCode(res.code) || res.bucket === "partial_risk") return false;
  const created = res.created;
  return created == null || (Array.isArray(created) ? created.length === 0 : record(created) && Object.keys(created).length === 0);
}

function revisedOperationKey(row: ReviewRow, changes: Record<string, string>): string {
  const ordered = Object.fromEntries(Object.keys(changes).sort().map((key) => [key, changes[key]]));
  return `rv${createHash("sha256").update(JSON.stringify([row.id, ordered])).digest("hex").slice(0, 40)}`;
}

function linkedInSponsoredPost(row: ReviewRow): boolean {
  return row.exec_class === "linkedin_ads.create_campaign_bundle" && record(row.exec_payload) && record(row.exec_payload.creative) && typeof row.exec_payload.creative.post_urn === "string";
}

function openForEdit(row: ReviewRow): boolean {
  return row.status === "pending" && ((!row.exec_status && !row.approved_by) || failedWithNothingMade(row));
}

const LOCKED_NOT_PENDING = "This proposal is no longer pending, so it can’t be edited.";
const LOCKED_RAN = "This ad already ran, so it can’t be edited.";
const LOCKED_SENDING = "This ad is being sent to the platform, so it can’t be edited right now.";
const LOCKED_APPROVED = "This ad is approved and waiting to run, so it can’t be edited.";
const LOCKS_THE_CARD_ALREADY_SHOWS = new Set([LOCKED_NOT_PENDING, LOCKED_RAN, LOCKED_SENDING, LOCKED_APPROVED]);

function lockedReason(row: ReviewRow, canEdit: boolean): string | null {
  if (row.status !== "pending") return LOCKED_NOT_PENDING;
  if (row.exec_status === "executed") return LOCKED_RAN;
  if (row.exec_status === "failed" && !failedWithNothingMade(row)) return "This run may have reached the platform, so it can’t be edited here.";
  if (row.exec_status && row.exec_status !== "failed") return LOCKED_SENDING;
  if (!row.exec_status && row.approved_by) return LOCKED_APPROVED;
  if (!canEdit) return "Only an owner or admin can edit this ad.";
  return null;
}

export async function readAdReview(tenantId: string, row: ReviewRow, refresh = false, canEdit = true): Promise<AdReviewResponse> {
  const fields = row.exec_class ? editFields(row.exec_class, row.exec_payload) : [];
  const editable = canEdit && openForEdit(row) && fields.length > 0;
  let review = projectAdReview(row.exec_class, row.exec_payload);
  if (review && record(row.body) && row.body.ad_review_edited === true) review = { ...review, provenance: "Edited by you" };
  const limitations: string[] = [];
  const sponsoredPost = linkedInSponsoredPost(row);
  const locked = fields.length > 0 && !editable ? lockedReason(row, canEdit) : null;
  const linkedIn = row.exec_class?.startsWith("linkedin_ads.") === true;
  if (locked && !(linkedIn && LOCKS_THE_CARD_ALREADY_SHOWS.has(locked))) limitations.push(locked);
  let connectionBlocker: AdReviewResponse["connection_blocker"] = null;
  if (!linkedIn && !fields.some((field) => ["date", "datetime"].includes(field.kind))) limitations.push("This proposal’s executor does not support schedule revisions.");
  if (!linkedIn && !fields.some((field) => !["date", "datetime"].includes(field.kind))) limitations.push("This proposal does not support inline creative revisions. Existing source posts must be edited on their platform.");
  if (row.exec_class?.startsWith("x_ads.")) limitations.push("Changing the source post selects a different existing post. Edit the post’s original copy on its platform.");
  if (review && row.exec_class) {
    const key = `${tenantId}:${row.id}:${review.revision}`;
    const cached = cache.get(key);
    if (!refresh && cached && cached.expires > Date.now()) review = cached.review;
    else {
      let request = pending.get(key);
      if (!request) {
        request = resolveAdReviewMedia(tenantId, row.exec_class, row.exec_payload, review);
        pending.set(key, request);
      }
      try {
        review = await request;
        if (cache.size >= 128) { const first = cache.keys().next().value; if (first) cache.delete(first); }
        cache.set(key, { expires: Date.now() + 60_000, review });
      } catch (error) {
        if (record(error) && typeof error.code === "string" && CONNECTION_FAILURES.has(error.code)) connectionBlocker = { message: `reconnect ${execPlatformLabel(row.exec_class)} to publish this ad` };
        if (!sponsoredPost) limitations.push("Some source media could not be read. Retry the preview or check your platform connection.");
      }
      finally { pending.delete(key); }
    }
  }
  const failureShown = sponsoredPost && row.exec_status === "failed" && !editable;
  return { review, fields: editable ? fields : [], editable, limitations: failureShown ? [] : limitations, connection_blocker: connectionBlocker };
}

export class StaleAdRevision extends Error {}

export function revisedAd(row: ReviewRow, revision: string, changes: Record<string, string>, replay = false) {
  const open = openForEdit(row) || (replay && openForEdit({ ...row, status: "pending" }) && row.status === "redone");
  if (!row.exec_class || !open || adReviewVersion(row.exec_class, row.exec_payload) !== revision) throw new StaleAdRevision("This proposal changed. Refresh it before editing.");
  const revised = reviseAdPayload(row.exec_class, row.exec_payload, changes);
  const payload = row.exec_class === "reddit_ads.prepare_campaign" && record(revised) ? { ...revised, operation_key: revisedOperationKey(row, changes) } : revised;
  const fields = editFields(row.exec_class, payload);
  const body = record(row.body) ? { ...row.body } : {};
  const exact = record(body.exact_change) ? body.exact_change : {};
  const previous = editFields(row.exec_class, row.exec_payload);
  const rows = Array.isArray(exact.rows) ? exact.rows.filter((item) => !record(item) || item.review_edit !== true || typeof item.review_key !== "string" || !Object.hasOwn(changes, item.review_key)).map((item) => record(item) && item.review_edit !== true && typeof item.item === "string" ? { ...item, item: item.item.startsWith("Original proposal · ") ? item.item : `Original proposal · ${item.item}` } : item) : [];
  const earlier = new Map((Array.isArray(exact.rows) ? exact.rows : []).filter((item): item is Record<string, unknown> => record(item) && item.review_edit === true && typeof item.review_key === "string" && typeof item.before === "string").map((item) => [item.review_key as string, item.before as string]));
  for (const field of fields.filter((field) => Object.hasOwn(changes, field.key))) {
    const shown = earlier.get(field.key);
    const before = shown === undefined ? previous.find((item) => item.key === field.key)?.value ?? "" : shown === "Not set" ? "" : shown;
    if (field.value !== before) rows.push({ item: field.label, before: before || "Not set", after: field.value || "Not set", review_edit: true, review_key: field.key });
  }
  body.exact_change = { ...exact, rows };
  if (row.exec_class === CHATGPT_CREATE) {
    const current = growthCreateBody.parse(payload);
    const campaign = current.bundle.campaign;
    const cost = campaign.lifetime_budget_micros != null ? `${campaign.lifetime_budget_micros / 1e6} ${current.currency} total` : `${campaign.daily_budget_micros! / 1e6} ${current.currency} a day`;
    body.change_sentence = `Create and launch ${current.name} at ${cost}, from ${new Date(campaign.start_time * 1000).toISOString()} to ${new Date(campaign.end_time * 1000).toISOString()} (UTC).`;
    if (record(body.step)) body.step = { ...body.step, body: body.change_sentence };
  }
  body.ad_review_edited = true;
  if (Object.keys(changes).some((key) => key === "image_url" || key.endsWith(".image_url") || key === "tweet_ids" || key === "creative.post_urn")) delete body.media;
  delete body.ad_review;
  return { payload, body };
}
