import { isPartialRiskExecCode } from "@zavi/shared";
import { PLAN_UPGRADE_REQUIRED } from "@/services/billing/tiers";
import { execPlatformLabel } from "./exec-kill-switch";
import { metaCodeOfMessage } from "@/services/tools/meta-ads/error-words";

export const EXEC_BUCKETS = ["blocked_on_us", "needs_founder", "temporary", "partial_risk"] as const;
export type ExecBucket = (typeof EXEC_BUCKETS)[number];
export const EXEC_FIXES = ["reconnect", "permission", "billing", "credits", "plan", "page_grant", "page", "ad_budget", "audience_terms"] as const;
export type ExecFix = (typeof EXEC_FIXES)[number];
export type ExecVerdict = { bucket: ExecBucket; fix: ExecFix | null; platform_code: string | null };
export type StoredVerdict = ExecVerdict & { note: string | null };

type Sorted = { bucket: ExecBucket; fix: ExecFix | null };

export const CODE_VERDICT: Readonly<Record<string, Sorted>> = {
  insufficient_credits: { bucket: "needs_founder", fix: "credits" },
  [PLAN_UPGRADE_REQUIRED]: { bucket: "needs_founder", fix: "plan" },
  meta_ads_not_connected: { bucket: "needs_founder", fix: "reconnect" },
  meta_ads_token_expired: { bucket: "needs_founder", fix: "reconnect" },
  meta_ads_permission_revoked: { bucket: "needs_founder", fix: "permission" },
  meta_ads_connector_missing: { bucket: "needs_founder", fix: "reconnect" },
  meta_ads_account_not_writable: { bucket: "needs_founder", fix: "permission" },
  meta_ads_page_permission_missing: { bucket: "needs_founder", fix: "page_grant" },
  meta_ads_no_page: { bucket: "needs_founder", fix: "page" },
  meta_ads_page_required: { bucket: "needs_founder", fix: "page" },
  meta_ads_custom_audience_terms: { bucket: "needs_founder", fix: "audience_terms" },
  meta_ads_bid_unavailable: { bucket: "blocked_on_us", fix: null },
  google_ads_not_connected: { bucket: "needs_founder", fix: "reconnect" },
  google_ads_oauth_refresh_failed: { bucket: "needs_founder", fix: "reconnect" },
  google_ads_token_revoked: { bucket: "needs_founder", fix: "reconnect" },
  google_ads_unauthenticated: { bucket: "needs_founder", fix: "reconnect" },
  google_ads_timeout: { bucket: "temporary", fix: null },
  google_ads_not_configured: { bucket: "blocked_on_us", fix: null },
  google_ads_video_create_unsupported: { bucket: "blocked_on_us", fix: null },
  google_ads_video_mutate_unsupported: { bucket: "blocked_on_us", fix: null },
  google_ads_demand_gen_logo_mismatch: { bucket: "blocked_on_us", fix: null },
  google_ads_non_usd_account: { bucket: "blocked_on_us", fix: null },
  google_ads_mutate_partial_failure: { bucket: "partial_risk", fix: null },
  google_ads_mutate_incomplete: { bucket: "partial_risk", fix: null },
  email_tool_not_connected: { bucket: "needs_founder", fix: "reconnect" },
  email_audience_missing: { bucket: "temporary", fix: null },
  email_tool_refused: { bucket: "temporary", fix: null },
  email_content_changed: { bucket: "temporary", fix: null },
  email_content_unverifiable: { bucket: "temporary", fix: null },
  github_not_connected: { bucket: "needs_founder", fix: "reconnect" },
  reddit_ads_invalid_request: { bucket: "needs_founder", fix: null },
  reddit_ads_retained_object_archived: { bucket: "needs_founder", fix: null },
  chatgpt_ads_launch_undone: { bucket: "blocked_on_us", fix: null },
  linkedin_ads_post_author_refused: { bucket: "blocked_on_us", fix: null },
  linkedin_ads_account_changed: { bucket: "blocked_on_us", fix: null },
  linkedin_ads_launch_not_reopened: { bucket: "blocked_on_us", fix: null },
};

export const TEXT_RULES: ReadonlyArray<{ re: RegExp } & Sorted> = [
  { re: /cap_refuse: ad_budget_(over_month|over_daily_limit)\b/, bucket: "needs_founder", fix: "ad_budget" },
  { re: /"status":\s*"UNAUTHENTICATED"|authenticationError|invalid_grant/, bucket: "needs_founder", fix: "reconnect" },
  { re: /"status":\s*"PERMISSION_DENIED"|authorizationError|USER_PERMISSION_DENIED|CUSTOMER_NOT_ENABLED/, bucket: "needs_founder", fix: "permission" },
  { re: /billingSetupError|accountBudgetError|payment method/i, bucket: "needs_founder", fix: "billing" },
  { re: /"status":\s*"(RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED)"|quotaError|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|timed out/i, bucket: "temporary", fix: null },
  { re: /"status":\s*"INVALID_ARGUMENT"|MUTATE_NOT_ALLOWED|fieldError|requestError|mutateError|OPERATION_NOT_PERMITTED|NOT_SUPPORTED|body invalid|No handler is registered/, bucket: "blocked_on_us", fix: null },
];

const META_TEMPORARY = new Set([1, 2, 4, 17, 32, 341, 613]);

function metaVerdict(text: string): { v: Sorted | null; code: string | null } {
  if (!/Meta Ads/.test(text)) return { v: null, code: null };
  const m = /"code":\s*(\d+)(?:[^}]*"error_subcode":\s*(\d+))?/.exec(text);
  if (!m) return { v: null, code: null };
  const code = Number(m[1]);
  const sub = m[2] ?? /"error_subcode":\s*(\d+)[^}]*"code":\s*\d+/.exec(text)?.[1];
  const pc = `meta_${m[1]}${sub ? `_${sub}` : ""}`;
  if (code === 190 || code === 102) return { v: { bucket: "needs_founder", fix: "reconnect" }, code: pc };
  if (code === 10 || (code >= 200 && code <= 299)) return { v: { bucket: "needs_founder", fix: "permission" }, code: pc };
  if (code === 2663) return { v: { bucket: "needs_founder", fix: "audience_terms" }, code: pc };
  if (META_TEMPORARY.has(code) || (code >= 80000 && code <= 80014)) return { v: { bucket: "temporary", fix: null }, code: pc };
  if (code === 100 && sub === "33") return { v: { bucket: "needs_founder", fix: "permission" }, code: pc };
  if (code === 100) return { v: { bucket: "blocked_on_us", fix: null }, code: pc };
  return { v: null, code: pc };
}

function googleCode(text: string): string | null {
  const codes = [...text.matchAll(/"errorCode":\s*\{\s*"\w+":\s*"(\w+)"/g)].map((m) => m[1]);
  if (codes.length) return [...new Set(codes)].join(",").slice(0, 120);
  const s = /"status":\s*"([A-Z_]+)"/.exec(text);
  return s ? s[1] : null;
}

export function classifyExecFailure(result: unknown): ExecVerdict | null {
  const r = (result && typeof result === "object" && !Array.isArray(result) ? result : {}) as Record<string, unknown>;
  if (r.held_for_founder === true) return null;
  const code = typeof r.code === "string" ? r.code : null;
  const text = typeof r.error === "string" ? r.error : "";
  if (isPartialRiskExecCode(code)) return { bucket: "partial_risk", fix: null, platform_code: null };
  if (code && Object.prototype.hasOwnProperty.call(CODE_VERDICT, code)) {
    const v = CODE_VERDICT[code];
    return { ...v, platform_code: v.bucket === "blocked_on_us" ? code : null };
  }
  if (r.interrupted === true || r.lease_expired === true || r.kill_switch === true) return { bucket: "temporary", fix: null, platform_code: null };
  if (r.no_handler === true) return { bucket: "blocked_on_us", fix: null, platform_code: null };
  const meta = metaVerdict(text);
  if (meta.v) return { ...meta.v, platform_code: meta.code };
  const gcode = googleCode(text);
  for (const rule of TEXT_RULES) if (rule.re.test(text)) return { bucket: rule.bucket, fix: rule.fix, platform_code: gcode ?? meta.code };
  const http = /failed:\s*(\d{3})\b/.exec(text);
  const status = http ? Number(http[1]) : null;
  if (status === 401) return { bucket: "needs_founder", fix: "reconnect", platform_code: gcode };
  if (status === 403) return { bucket: "needs_founder", fix: "permission", platform_code: gcode };
  if (status === 429 || (status !== null && status >= 500)) return { bucket: "temporary", fix: null, platform_code: gcode };
  if (status === 400) return { bucket: "blocked_on_us", fix: null, platform_code: gcode ?? meta.code };
  return { bucket: "temporary", fix: null, platform_code: gcode ?? meta.code };
}

export function adBudgetHeldNote(execClass: string): string {
  return `Nothing was sent to ${execPlatformLabel(execClass)}.`;
}

export const LAUNCH_UNDONE_NOTE = "Zavi archived this campaign after it could not launch, so it is not running. Ask again to start a new one.";

export const NEW_CAMPAIGN_NOTES: Readonly<Record<string, string>> = {
  linkedin_ads_post_author_refused: "LinkedIn will not run this post as an ad for this account, so Zavi closed the card. Start a new campaign with a post from the page this ad account advertises for.",
  linkedin_ads_account_changed: "The ad account, its company page or its currency changed after you reviewed this campaign, so Zavi closed the card. Start a new campaign and review it again.",
  linkedin_ads_launch_not_reopened: "Nothing was sent to LinkedIn for this request, and Zavi could not reopen it, so Zavi closed the card. Review the launch again to send a new one.",
};

function postRefusedArchivedNote(archived: unknown): string | null {
  if (!archived || typeof archived !== "object") return null;
  const a = archived as { group?: unknown; group_name?: unknown };
  const name = typeof a.group_name === "string" && a.group_name.trim() ? a.group_name.trim().slice(0, 200) : null;
  const group = name ? `its campaign group, ${name},` : "its campaign group";
  const lead = "LinkedIn will not run this post as an ad for this account, so Zavi closed the card.";
  const next = "Start a new campaign with a post from the page this ad account advertises for.";
  if (a.group === true) return `${lead} Zavi had already made a paused campaign and ${group} in your LinkedIn ad account, and archived both, so nothing can spend. ${next}`;
  if (a.group === false) return `${lead} Zavi had already made a paused campaign and ${group} in your LinkedIn ad account. It archived the campaign, so nothing can spend, but could not archive the campaign group, which stays there empty. You can remove it in LinkedIn Campaign Manager. ${next}`;
  return `${lead} Zavi had already made a paused campaign in your LinkedIn ad account and archived it, so nothing can spend. ${name ? `Its campaign group, ${name}, may still be there, empty` : "Its campaign group may still be there, empty"}. You can remove it in LinkedIn Campaign Manager. ${next}`;
}

export function blockedOnUsNote(execClass: string, code?: string | null, result?: unknown): string {
  if (code === "chatgpt_ads_launch_undone") return LAUNCH_UNDONE_NOTE;
  if (code === "linkedin_ads_post_author_refused") {
    const r = result as { post_missing?: unknown; error?: unknown; managed?: unknown } | null | undefined;
    if (r?.post_missing === true && typeof r.error === "string" && r.error.trim()) return r.error.trim().slice(0, 600);
    const archived = postRefusedArchivedNote((result as { archived?: unknown } | null | undefined)?.archived);
    if (archived) return r?.managed === true ? archived.replace(/ You can remove it in LinkedIn Campaign Manager\./, " Zavi removes it from its shared LinkedIn ad account.") : archived;
  }
  if (code && Object.prototype.hasOwnProperty.call(NEW_CAMPAIGN_NOTES, code)) return NEW_CAMPAIGN_NOTES[code];
  return `${execPlatformLabel(execClass)} refused this change, so Zavi closed the card. We've been alerted; nothing for you to do.`;
}

export function verdictFor(result: unknown, execClass: string): StoredVerdict | null {
  const v = classifyExecFailure(result);
  if (!v) return null;
  const code = result && typeof result === "object" && typeof (result as { code?: unknown }).code === "string" ? (result as { code: string }).code : null;
  const note = v.bucket === "blocked_on_us" ? blockedOnUsNote(execClass, code, result) : v.fix === "ad_budget" ? adBudgetHeldNote(execClass) : null;
  return { ...v, note };
}

export function execVerdictOf(execStatus: unknown, execResult: unknown): ExecVerdict | null {
  if (execStatus !== "failed") return null;
  const r = (execResult && typeof execResult === "object" && !Array.isArray(execResult) ? execResult : {}) as Record<string, unknown>;
  if (typeof r.bucket === "string" && (EXEC_BUCKETS as readonly string[]).includes(r.bucket)) {
    return {
      bucket: r.bucket as ExecBucket,
      fix: typeof r.fix === "string" && (EXEC_FIXES as readonly string[]).includes(r.fix) ? (r.fix as ExecFix) : null,
      platform_code: typeof r.platform_code === "string" ? r.platform_code : null,
    };
  }
  return classifyExecFailure(execResult);
}

const DEFINITE_FAILURE: ReadonlySet<string> = new Set(["blocked_on_us", "needs_founder"]);

export function failedDefinitely(card: { exec_status?: string | null; exec_result?: unknown }): boolean {
  if (card.exec_status !== "failed") return false;
  const res = (card.exec_result && typeof card.exec_result === "object" ? card.exec_result : {}) as Record<string, unknown>;
  if (isPartialRiskExecCode(res.code) || res.bucket === "partial_risk" || res.interrupted === true || res.lease_expired === true) return false;
  const live = classifyExecFailure(res)?.bucket;
  return DEFINITE_FAILURE.has(String(res.bucket)) || (!!live && DEFINITE_FAILURE.has(live));
}

export const META_CUSTOM_AUDIENCE_TOS_URL = "https://www.facebook.com/customaudiences/app/tos";

export const ACCESS_FIXES: ReadonlySet<ExecFix> = new Set<ExecFix>(["reconnect", "permission", "page_grant"]);

export function decisionFailureFix(row: { status?: unknown; decision_class?: unknown; dispatch_error?: unknown }): { fix: ExecFix; platform_code: string | null; text: string } | null {
  const cls = typeof row.decision_class === "string" ? row.decision_class : "";
  if (row.status !== "dispatch_failed" || typeof row.dispatch_error !== "string" || !row.dispatch_error || !/^(meta_ads|google_ads|linkedin_ads)\./.test(cls)) return null;
  const code = cls.startsWith("meta_ads.") ? metaCodeOfMessage(row.dispatch_error) : null;
  const v = classifyExecFailure({ error: row.dispatch_error, ...(code ? { code } : {}) });
  if (v?.bucket !== "needs_founder" || !v.fix || !ACCESS_FIXES.has(v.fix)) return null;
  const words = fixWords(v.fix, execPlatformLabel(cls), v.platform_code);
  if (!words) return null;
  const then = v.platform_code === META_OBJECT_UNREACHABLE ? "If it still exists, make the change again." : "Then make the change again.";
  return { fix: v.fix, platform_code: v.platform_code, text: `${words[0].toUpperCase()}${words.slice(1)}. ${then}` };
}

export const META_OBJECT_UNREACHABLE = "meta_100_33";

export function fixWords(fix: ExecFix | null, platform: string, platformCode?: string | null): string | null {
  if (fix === "permission" && platformCode === META_OBJECT_UNREACHABLE)
    return `reconnect ${platform} in Settings, or check in ${platform} that the ad still exists (${platform} could not find it or Zavi lost access to it)`;
  switch (fix) {
    case "reconnect": return `reconnect ${platform} in Settings`;
    case "permission": return `give Zavi's connection access to the ${platform} account again`;
    case "billing": return `fix billing in ${platform}`;
    case "credits": return "top up your Zavi credits";
    case "plan": return "upgrade your Zavi plan";
    case "page_grant": return `reconnect ${platform} in Settings and allow access to your Facebook Page`;
    case "page": return `add a Facebook Page to your ${platform} account in Meta Business Settings`;
    case "ad_budget": return "raise your ad budget on the Growth page, or approve a smaller change";
    case "audience_terms": return `accept Meta's Custom Audience terms at ${META_CUSTOM_AUDIENCE_TOS_URL}`;
    default: return null;
  }
}
