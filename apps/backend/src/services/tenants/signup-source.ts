import { parseSignupAttribution } from "./signup-attribution";

export type SignupSource = {
  source: string;
  creator_id?: string;
  kind: "affiliate" | "from" | "utm_source" | "referrer" | "ad_network" | "direct" | "unknown";
};
export type SignupReferral = { member_id: string; display_name?: string | null };

export function resolveSignupSource(raw: unknown, referral?: SignupReferral | null): SignupSource {
  return referral
    ? { source: referral.display_name?.trim() || "Creator", kind: "affiliate", creator_id: referral.member_id }
    : signupSource(raw);
}

const IDP_HOSTS = new Set(["accounts.google.com", "login.microsoftonline.com", "github.com", "slack.com"]);

export function signupSource(raw: unknown): SignupSource {
  const a = parseSignupAttribution(raw);
  if (a?.from) return { source: a.from, kind: "from" };
  if (a?.utm_source) return { source: a.utm_source, kind: "utm_source" };
  const host = a?.referrer_host ?? "";
  const authLanding = /^\/(?:login|auth)(?:\/|$)/.test(a?.landing_path ?? "");
  const ownHost = host === "zaviagent.com" || host.endsWith(".zaviagent.com");
  const provider = IDP_HOSTS.has(host) || host.endsWith(".slack.com");
  const authReturn = authLanding || /^\/(?:workspace|start|onboarding)(?:\/|$)/.test(a?.landing_path ?? "");
  const lateCapture = (authLanding && (!host || ownHost || provider)) ||
    (authReturn && provider) || host === "accounts.google.com" || host === "login.microsoftonline.com";
  if (a?.referrer_host && !lateCapture) return { source: a.referrer_host, kind: "referrer" };
  if (a?.click_id) return { source: a.click_id, kind: "ad_network" };
  if (a?.landing_path && !lateCapture && ![a.utm_medium, a.utm_campaign, a.utm_content, a.utm_term].some(Boolean)) return { source: "Direct", kind: "direct" };
  return { source: "Unknown", kind: "unknown" };
}
