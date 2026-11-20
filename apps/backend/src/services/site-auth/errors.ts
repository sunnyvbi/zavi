
export type SiteAuthErrorCode =
  | "bad_request"
  | "unauthorized"
  | "invalid_credentials"
  | "invalid_link"
  | "link_expired"
  | "weak_password"
  | "reauth_required"
  | "rate_limited"
  | "site_unavailable"
  | "unavailable"
  | "member_admin_required"
  | "member_not_found"
  | "invalid_role"
  | "last_admin"
  | "admin_exists"
  | "confirmation_required"
  | "not_found";

const STATUS: Record<SiteAuthErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  invalid_credentials: 401,
  invalid_link: 400,
  link_expired: 400,
  weak_password: 400,
  reauth_required: 403,
  rate_limited: 429,
  site_unavailable: 404,
  unavailable: 503,
  member_admin_required: 403,
  member_not_found: 404,
  invalid_role: 400,
  last_admin: 409,
  admin_exists: 409,
  confirmation_required: 400,
  not_found: 404,
};

const MESSAGE: Record<SiteAuthErrorCode, string> = {
  bad_request: "The request is not valid.",
  unauthorized: "Sign in again.",
  invalid_credentials: "Email or password is incorrect.",
  invalid_link: "This link is not valid. Request a new one.",
  link_expired: "This link has expired. Request a new one.",
  weak_password: "Use a password of 8 to 72 characters.",
  reauth_required: "Confirm your current password to continue.",
  rate_limited: "Too many attempts. Try again later.",
  site_unavailable: "This site is not available.",
  unavailable: "Something went wrong. Try again.",
  member_admin_required: "Only an admin of this site can do this.",
  member_not_found: "No such member on this site.",
  invalid_role: "That role is not defined for this site.",
  last_admin: "The site needs at least one active admin.",
  admin_exists: "This site already has an admin.",
  confirmation_required: "Confirm this permanent deletion.",
  not_found: "Not found.",
};

export const SHARD_RULE_ERRORS: ReadonlySet<SiteAuthErrorCode> = new Set([
  "member_admin_required", "member_not_found", "invalid_role", "last_admin", "admin_exists", "confirmation_required", "not_found",
]);

export class SiteAuthError extends Error {
  readonly status: number;
  constructor(readonly code: SiteAuthErrorCode, message?: string) {
    super(message ?? MESSAGE[code]);
    this.status = STATUS[code];
  }
}

export class GoTrueEmailThrottled extends Error {}
