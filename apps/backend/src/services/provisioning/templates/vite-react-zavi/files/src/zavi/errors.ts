
export type ZaviErrorCode =
  | "not_allowed"
  | "validation"
  | "not_found"
  | "conflict"
  | "quota"
  | "rate_limited"
  | "offline"
  | "server";

export const ZAVI_ERROR_CODES: readonly ZaviErrorCode[] = [
  "not_allowed", "validation", "not_found", "conflict", "quota", "rate_limited", "offline", "server",
];

export class ZaviError extends Error {
  readonly code: ZaviErrorCode;
  readonly reason: string;
  readonly status: number | undefined;
  readonly retryAfter: number | undefined;
  readonly requestId: string | undefined;
  readonly signedOut: boolean;

  constructor(
    code: ZaviErrorCode,
    message: string,
    opts: { reason?: string; status?: number; retryAfter?: number; requestId?: string; signedOut?: boolean } = {},
  ) {
    super(message);
    this.name = "ZaviError";
    this.code = code;
    this.reason = opts.reason ?? code;
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
    this.requestId = opts.requestId;
    this.signedOut = opts.signedOut === true;
  }
}

export const KERNEL_REASONS = [
  "invalid_reference", "invalid_action_input", "invalid_idempotency_key", "invalid_role", "aggregate_too_large", "cascade_too_large",
  "not_found", "member_not_found",
  "forbidden", "action_not_allowed", "aggregate_not_allowed", "member_admin_required",
  "unique_conflict", "transition_conflict", "action_bound", "last_admin", "idempotency_conflict", "reference_restricted", "role_in_use",
  "recipient_rate_limited", "quota_exceeded", "contract_building", "index_building", "field_not_writable", "field_not_readable",
  "invalid_member_body", "invalid_transition", "invalid_action_body", "invalid_aggregate_body",
] as const;
export type KernelReason = (typeof KERNEL_REASONS)[number];

export function codeForReason(reason: string, fallback: ZaviErrorCode = "server"): ZaviErrorCode {
  if ((ZAVI_ERROR_CODES as readonly string[]).includes(reason)) return reason as ZaviErrorCode;
  if (/^(invalid_member_body|invalid_transition|invalid_aggregate_body|confirm_required|invalid_captcha|invalid_reference|invalid_action|invalid_idempotency_key|invalid_role|invalid_state|invalid_id|invalid_limit|aggregate_too_large|cascade_too_large)/.test(reason)) return "validation";
  if (/^(unique_conflict|transition_conflict|action_bound|last_admin|reference_restricted|role_in_use)/.test(reason)) return "conflict";
  if (/^member_not_found/.test(reason)) return "not_found";
  if (/^(forbidden|action_not_allowed|aggregate_not_allowed|member_admin_required|turnstile_|field_not_writable|field_not_readable|sign_in_required|invalid_session|session_wrong_site|cross_origin_forbidden)/.test(reason)) return "not_allowed";
  if (/^recipient_rate_limited/.test(reason)) return "rate_limited";
  if (/^(contract_building|index_building|session_check_unavailable|shard_unavailable)/.test(reason)) return "server";
  if (/^(schema_violation|invalid_filter|invalid_cursor|invalid_patch|filter_not_allowed|sort_not_allowed|idempotency_key_required|idempotency_key_invalid|invalid_file_name|invalid_order|invalid_email|weak_password|bad_request|invalid_redirect)/.test(reason)) {
    return "validation";
  }
  if (/^(idempotency_conflict|email_taken|already_exists)/.test(reason)) return "conflict";
  if (/^(quota_exceeded|file_too_large)/.test(reason)) return "quota";
  if (/^(not_found|no_such_|site_unavailable)/.test(reason)) return "not_found";
  if (/^(not_allowed|site_mismatch|no_site|unknown_collection|field_not_writable|anonymous_write_forbidden|owner_id_is_server_assigned|system_field_immutable|rls|signed_out|invalid_credentials|session_expired|unauthorized|reauth_required|invalid_link|link_expired|invalid_refresh_token)/.test(reason)) {
    return "not_allowed";
  }
  if (/^rate_limited/.test(reason)) return "rate_limited";
  return fallback;
}

export function codeForStatus(status: number): ZaviErrorCode {
  if (status === 400 || status === 422) return "validation";
  if (status === 401 || status === 403) return "not_allowed";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413 || status === 507) return "quota";
  if (status === 429) return "rate_limited";
  return "server";
}

const SIGN_IN_REASONS = /^(signed_out|sign_in_required|session_expired|invalid_session|session_wrong_site|unauthorized|reauth_required|invalid_refresh_token|anonymous_write_forbidden)/;
const SIGNED_OUT_REFUSALS = /^(rls|forbidden|action_not_allowed|aggregate_not_allowed)$/;

export function needsSignIn(e: unknown): boolean {
  return (
    e instanceof ZaviError &&
    e.code === "not_allowed" &&
    (e.status === 401 || SIGN_IN_REASONS.test(e.reason) || (e.signedOut && SIGNED_OUT_REFUSALS.test(e.reason)))
  );
}

export function userMessage(e: unknown): string {
  if (!(e instanceof ZaviError)) return "Something went wrong. Please try again.";
  if (needsSignIn(e)) return "Please sign in to continue.";
  if (e.reason === "function_preview_only") return "This works on the published site, not in the preview.";
  if (e.reason.startsWith("turnstile_")) return "Complete the check above, then try again.";
  switch (e.code) {
    case "not_allowed":
      return "This can't be saved right now. Please contact us and we'll sort it out.";
    case "validation":
      return e.message || "Please check the details and try again.";
    case "not_found":
      return "We couldn't find that. It may have been removed.";
    case "conflict":
      return e.reason.startsWith("action_bound") ? "Sorry, that's fully booked." : "That was already taken. Please pick another option.";
    case "quota":
      return "This site is full right now. Please try again later.";
    case "rate_limited":
      return "That's a lot of tries in a short time. Please wait a moment and try again.";
    case "offline":
      return "You seem to be offline. Check your connection and try again.";
    default:
      return "Something went wrong on our side. Please try again.";
  }
}

export function isReauthRequired(e: unknown): boolean {
  return e instanceof ZaviError && e.reason === "reauth_required";
}
