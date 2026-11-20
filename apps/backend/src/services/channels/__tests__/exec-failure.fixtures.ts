
import type { ExecBucket, ExecFix } from "../exec-failure";

const googleFail = (status: number, body: unknown) =>
  `Google Ads googleAds:mutate failed: ${status} ${JSON.stringify(body, null, 2)}`;

export const MUTATE_NOT_ALLOWED = googleFail(400, {
  error: {
    code: 400,
    message: "Request contains an invalid argument.",
    status: "INVALID_ARGUMENT",
    details: [{
      "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
      errors: [
        { errorCode: { requestError: "UNKNOWN" }, message: "The error code is not in this version." },
        { errorCode: { mutateError: "MUTATE_NOT_ALLOWED" }, trigger: { stringValue: "VIDEO" }, message: "Mutates are not allowed for the requested resource." },
        { errorCode: { mutateError: "RESOURCE_NOT_FOUND" }, message: "The requested resource was not found." },
      ],
    }],
  },
});
export const FIELD_REQUIRED = googleFail(400, { error: { code: 400, status: "INVALID_ARGUMENT", details: [{ errors: [{ errorCode: { fieldError: "REQUIRED" } }] }] } });
const UNAUTH = googleFail(401, { error: { code: 401, status: "UNAUTHENTICATED", details: [{ errors: [{ errorCode: { authenticationError: "OAUTH_TOKEN_EXPIRED" } }] }] } });
const PERM = googleFail(403, { error: { code: 403, status: "PERMISSION_DENIED", details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }] }] } });
const QUOTA = googleFail(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ errors: [{ errorCode: { quotaError: "RESOURCE_EXHAUSTED" } }] }] } });
const G500 = googleFail(500, { error: { code: 500, status: "INTERNAL" } });
const G400_BARE = googleFail(400, { error: { code: 400, message: "bad" } });
const G404_BARE = `Google Ads campaigns:mutate failed: 404 <html>not found</html>`;
const BILLING = googleFail(400, { error: { code: 400, status: "FAILED_PRECONDITION", details: [{ errors: [{ errorCode: { billingSetupError: "BILLING_SETUP_NOT_PERMITTED_FOR_CUSTOMER_WITH_EXISTING_BILLING_SETUP" } }] }] } });
const META_100 = `Meta Ads write failed: 400 {"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"error_subcode":1885097}}`;
const META_100_33 = `Meta Ads write failed: 400 {"error":{"message":"Unsupported post request. Object with ID '120000000000000001' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https:\\/\\/developers.facebook.com\\/docs\\/graph-api","type":"GraphMethodException","code":100,"error_subcode":33,"fbtrace_id":"x"}}`;
const META_100_33_SUB_FIRST = `Meta Ads write failed: 400 {"error":{"error_subcode":33,"message":"Object does not exist","type":"GraphMethodException","code":100}}`;
const META_100_BID = `Meta Ads write failed: 400 {"error":{"message":"Invalid parameter","type":"OAuthException","code":100,"error_subcode":2490487,"is_transient":false}}`;
const META_100_BARE = `Meta Ads write failed: 400 {"error":{"message":"Invalid parameter","type":"OAuthException","code":100}}`;
const META_17 = `Meta Ads write failed: 400 {"error":{"message":"User request limit reached","type":"OAuthException","code":17}}`;
const META_190 = `Meta Ads write failed: 400 {"error":{"message":"Session expired","type":"OAuthException","code":190}}`;
const META_200 = `Meta Ads write failed: 403 {"error":{"message":"Permissions error","type":"OAuthException","code":200}}`;
const META_2663 = `Meta Ads write failed: 400 {"error":{"message":"(#2663) Terms of service has not been accepted. To accept, go to https:\\/\\/www.facebook.com\\/customaudiences\\/app\\/tos\\/?act=1","type":"OAuthException","code":2663,"fbtrace_id":"x"}}`;
const META_80004 = `Meta Ads write failed: 400 {"error":{"message":"too many calls","code":80004}}`;
const META_UNKNOWN = `Meta Ads write failed: 400 {"error":{"message":"odd","code":1487390}}`;
const META_HTML_502 = `Meta Ads write failed: 502 <html>Bad Gateway</html>`;

export type ExecFixture = {
  name: string;
  result: Record<string, unknown>;
  exec_class: string;
  bucket: ExecBucket | null;
  fix: ExecFix | null;
  platform_code: string | null;
};

const f = (
  name: string,
  result: Record<string, unknown>,
  bucket: ExecBucket | null,
  fix: ExecFix | null = null,
  platform_code: string | null = null,
  exec_class = "google_ads.create_campaign",
): ExecFixture => ({ name, result, exec_class, bucket, fix, platform_code });

export const EXEC_FIXTURES: ExecFixture[] = [
  f("Google MUTATE_NOT_ALLOWED on VIDEO (931ad19b)", { error: MUTATE_NOT_ALLOWED }, "blocked_on_us", null, "UNKNOWN,MUTATE_NOT_ALLOWED,RESOURCE_NOT_FOUND"),
  f("the same, with the client's code", { error: MUTATE_NOT_ALLOWED, code: "google_ads_mutate_failed" }, "blocked_on_us", null, "UNKNOWN,MUTATE_NOT_ALLOWED,RESOURCE_NOT_FOUND"),
  f("Google fieldError REQUIRED (9be6057e)", { error: FIELD_REQUIRED }, "blocked_on_us", null, "REQUIRED"),
  f("video create unsupported (A6)", { code: "google_ads_video_create_unsupported", error: "no" }, "blocked_on_us", null, "google_ads_video_create_unsupported"),
  f("non-USD Google account (Part E)", { code: "google_ads_non_usd_account", error: "google_ads_non_usd_account: EUR" }, "blocked_on_us", null, "google_ads_non_usd_account"),
  f("Demand Gen logo mismatch (Part E)", { code: "google_ads_demand_gen_logo_mismatch", error: "changed" }, "blocked_on_us", null, "google_ads_demand_gen_logo_mismatch"),
  f("video mutate unsupported (A7)", { code: "google_ads_video_mutate_unsupported" }, "blocked_on_us", null, "google_ads_video_mutate_unsupported"),
  f("ChatGPT launch Zavi archived", { code: "chatgpt_ads_launch_undone", error: "Zavi created ChatGPT campaign cmpn_1 but could not launch it, so it was archived" }, "blocked_on_us", null, "chatgpt_ads_launch_undone", "chatgpt_ads.create_and_launch"),
  f("Meta ad set with no bid to copy", { code: "meta_ads_bid_unavailable", error: "no bid" }, "blocked_on_us", null, "meta_ads_bid_unavailable", "meta_ads.create_ad_set"),
  f("no handler", { no_handler: true, error: "No handler is registered for x.y." }, "blocked_on_us"),
  f("partial create", { code: "exec_partial" }, "partial_risk"),
  f("interrupted create", { interrupted: true, lease_expired: true, code: "exec_outcome_unknown" }, "partial_risk"),
  f("google partial failure", { code: "google_ads_mutate_partial_failure", error: "x" }, "partial_risk"),
  f("google incomplete", { code: "google_ads_mutate_incomplete", error: "x" }, "partial_risk"),
  f("interrupted non-create", { interrupted: true, lease_expired: true }, "temporary"),
  f("email changed in the tool before send", { code: "email_content_changed", error: "The email in Mailchimp was changed" }, "temporary", null, null, "email_campaign.create_and_send"),
  f("email could not be read back before send", { code: "email_content_unverifiable", error: "Zavi could not read the email back" }, "temporary", null, null, "email_campaign.create_and_send"),
  f("kill switch", { kill_switch: true, platform: "google" }, "temporary"),
  f("credits (generated video)", { code: "insufficient_credits", error: "Not enough credits" }, "needs_founder", "credits", null, "generated_video.render.v1"),
  f("plan", { code: "plan_upgrade_required" }, "needs_founder", "plan"),
  f("meta not connected", { code: "meta_ads_not_connected" }, "needs_founder", "reconnect", null, "meta_ads.set_status"),
  f("meta token", { code: "meta_ads_token_expired" }, "needs_founder", "reconnect", null, "meta_ads.set_status"),
  f("meta permission", { code: "meta_ads_permission_revoked" }, "needs_founder", "permission", null, "meta_ads.set_status"),
  f("meta connector missing (capability)", { code: "meta_ads_connector_missing", error: "Meta Ads is not connected for this workspace" }, "needs_founder", "reconnect", null, "meta_ads.create_ad"),
  f("meta account not writable (capability)", { code: "meta_ads_account_not_writable", error: "The connected Meta ad account is not writable" }, "needs_founder", "permission", null, "meta_ads.create_ad"),
  f("meta Page grant missing is the token's grant, not App Review", { code: "meta_ads_page_permission_missing", error: "The Meta connection does not have access to your Facebook Page yet" }, "needs_founder", "page_grant", null, "meta_ads.create_ad"),
  f("meta no Page on the ad account", { code: "meta_ads_no_page", error: "This Meta ad account has no Facebook Page it can promote" }, "needs_founder", "page", null, "meta_ads.create_ad"),
  f("meta Page required by the shaper", { code: "meta_ads_page_required", error: "a Facebook Page is required for an ad" }, "needs_founder", "page", null, "meta_ads.create_ad"),
  f("meta Custom Audience terms checked before the create", { code: "meta_ads_custom_audience_terms", error: "this ad account has not accepted Meta's Custom Audience terms" }, "needs_founder", "audience_terms", null, "meta_ads.create_custom_audience"),
  f("meta lookup failure stays temporary", { code: "meta_ads_lookup_failed", error: "Zavi could not check the Meta connection just now" }, "temporary", null, null, "meta_ads.create_ad"),
  f("google token revoked", { code: "google_ads_token_revoked" }, "needs_founder", "reconnect"),
  f("google 401", { error: UNAUTH }, "needs_founder", "reconnect", "OAUTH_TOKEN_EXPIRED"),
  f("google 403", { error: PERM }, "needs_founder", "permission", "USER_PERMISSION_DENIED"),
  f("google billing", { error: BILLING }, "needs_founder", "billing", "BILLING_SETUP_NOT_PERMITTED_FOR_CUSTOMER_WITH_EXISTING_BILLING_SETUP"),
  f("google 429", { error: QUOTA }, "temporary", null, "RESOURCE_EXHAUSTED"),
  f("google 500", { error: G500 }, "temporary", null, "INTERNAL"),
  f("google bare 400 is a refusal", { error: G400_BARE }, "blocked_on_us"),
  f("google 404 html is not a refusal we can prove", { error: G404_BARE }, "temporary"),
  f("google timeout code", { code: "google_ads_timeout" }, "temporary"),
  f("meta invalid parameter (OAuthException type is NOT auth)", { error: META_100, code: "meta_ads_write_failed" }, "blocked_on_us", null, "meta_100_1885097", "meta_ads.update_ad_set_budget"),
  f("meta 100/33 object missing or not permitted: the founder reconnects or checks the object", { error: META_100_33, code: "meta_ads_write_failed" }, "needs_founder", "permission", "meta_100_33", "meta_ads.set_status_review"),
  f("meta 100/33 with no code", { error: META_100_33 }, "needs_founder", "permission", "meta_100_33", "meta_ads.set_status"),
  f("meta 100/33 with the subcode before the code", { error: META_100_33_SUB_FIRST }, "needs_founder", "permission", "meta_100_33", "meta_ads.set_status"),
  f("meta 100 bid rule stays ours", { error: META_100_BID }, "blocked_on_us", null, "meta_100_2490487", "meta_ads.create_ad_set"),
  f("meta 100 with no subcode stays ours", { error: META_100_BARE }, "blocked_on_us", null, "meta_100", "meta_ads.create_ad_set"),
  f("meta rate limit", { error: META_17 }, "temporary", null, "meta_17", "meta_ads.update_ad_set_budget"),
  f("meta 190 in text", { error: META_190 }, "needs_founder", "reconnect", "meta_190", "meta_ads.set_status"),
  f("meta 200 permission range", { error: META_200 }, "needs_founder", "permission", "meta_200", "meta_ads.set_status"),
  f("meta 2663 Custom Audience terms not accepted: the founder accepts them", { error: META_2663, code: "meta_ads_write_failed" }, "needs_founder", "audience_terms", "meta_2663", "meta_ads.create_custom_audience"),
  f("meta 80004 business-use throttle", { error: META_80004 }, "temporary", null, "meta_80004", "meta_ads.set_status"),
  f("meta unknown code falls through to the HTTP status", { error: META_UNKNOWN }, "blocked_on_us", null, "meta_1487390", "meta_ads.set_status"),
  f("meta html 502", { error: META_HTML_502 }, "temporary", null, null, "meta_ads.set_status"),
  f("video render timeout text", { error: "render timed out after 600s", code: "render_timeout" }, "temporary", null, null, "generated_video.render.v1"),
  f("socket hang up", { error: "socket hang up" }, "temporary"),
  f("cap refusal stays as today", { error: "cap_refuse: over the daily change cap" }, "temporary"),
  f("ad budget over the month: the founder raises the budget", { error: "cap_refuse: ad_budget_over_month" }, "needs_founder", "ad_budget", null, "meta_ads.update_ad_set_budget"),
  f("ad budget over the daily limit", { error: "cap_refuse: ad_budget_over_daily_limit" }, "needs_founder", "ad_budget", null, "google_ads.update_campaign_budget"),
  f("ad budget unreadable stays temporary", { error: "cap_refuse: ad_budget_unavailable: the ad budget could not be checked, nothing was sent" }, "temporary"),
  f("unknown text never closes a card", { error: "something odd" }, "temporary"),
  f("checkpointed LinkedIn creation can continue without replaying confirmed objects", { code: "linkedin_ads_creation_incomplete", error: "Campaign setup is saved. Correct the issue in LinkedIn, then choose Try again to finish the remaining steps." }, "temporary"),
  f("empty result", {}, "temporary"),
  f("a founder hold is not a failure bucket", { held_for_founder: true, error: "held" }, null),
];
