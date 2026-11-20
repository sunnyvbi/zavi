
export const SIGNUP_ATTRIBUTION_KEY = "signup_attribution";

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

export type SignupAttribution = Partial<Record<(typeof UTM_KEYS)[number], string>> & {
  click_id?: string;
  referrer_host?: string;
  landing_path?: string;
  first_seen_at?: string;
  from?: string;
  capture_status?: "analytics_disabled" | "storage_unavailable" | "not_captured";
};

const CLICK_IDS = new Set(["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid", "li_fat_id", "twclid"]);
const HOST_RE = /^[a-z0-9.-]{1,200}$/i;
const FROM_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

export function parseSignupAttribution(raw: unknown): SignupAttribution | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: SignupAttribution = {};
  if (r.capture_status === "analytics_disabled" || r.capture_status === "storage_unavailable" || r.capture_status === "not_captured") out.capture_status = r.capture_status;
  for (const k of UTM_KEYS) {
    const v = str(r[k], 100);
    if (v) out[k] = v;
  }
  const click = str(r.click_id, 20);
  if (click && CLICK_IDS.has(click)) out.click_id = click;
  const host = str(r.referrer_host, 200);
  if (host && HOST_RE.test(host)) out.referrer_host = host.toLowerCase();
  const path = str(r.landing_path, 200);
  if (path && path.startsWith("/") && !/[?#]/.test(path)) out.landing_path = path;
  const seen = str(r.first_seen_at, 40);
  if (seen && !Number.isNaN(Date.parse(seen))) out.first_seen_at = seen;
  const from = typeof r.from === "string" ? r.from.trim() : undefined;
  if (from && FROM_RE.test(from)) out.from = from;
  return Object.keys(out).length ? out : null;
}

export function describeAttribution(a: SignupAttribution | null | undefined): string {
  if (!a || Object.keys(a).every(k => k === "capture_status")) return "(unknown: no acquisition source captured)";
  const utm = [a.utm_source, a.utm_medium, a.utm_campaign].filter(Boolean).join(" / ");
  const parts: string[] = [];
  if (utm) parts.push(utm);
  if (a.click_id) parts.push(`ad click (${a.click_id})`);
  if (a.referrer_host) parts.push(`from ${a.referrer_host}`);
  if (!parts.length && !a.from) parts.push("direct (no UTM, no outside referrer)");
  if (a.from) parts.push(`via ${a.from}`);
  if (a.landing_path) parts.push(`landed ${a.landing_path}`);
  return parts.join(" · ");
}

export async function persistSignupAttribution(
  tenant_id: string,
  user_id: string,
  raw: unknown,
  query?: unknown,
): Promise<void> {
  const body = parseSignupAttribution(raw);
  const url = parseSignupAttribution(query);
  const a: SignupAttribution = { ...body };
  if (!UTM_KEYS.some((key) => body?.[key])) {
    for (const key of UTM_KEYS) if (url?.[key]) a[key] = url[key];
  }
  if (!a.from && url?.from) a.from = url.from;
  if (!Object.keys(a).length) {
    await logCaptureDiagnostic(tenant_id, raw == null ? "missing" : "invalid");
    return;
  }
  try {
    const { setTenantSetting } = await import("../settings");
    await setTenantSetting(tenant_id, SIGNUP_ATTRIBUTION_KEY, a, user_id);
  } catch {
    await logCaptureDiagnostic(tenant_id, "persist_failed");
  }
}

async function logCaptureDiagnostic(tenant_id: string, status: "missing" | "invalid" | "persist_failed"): Promise<void> {
  try {
    const { logEvent } = await import("../logging/logEvent");
    await logEvent({tenant_id, source: "signup-attribution", level: status === "persist_failed" ? "warn" : "info",
      code: `signup_attribution.${status}`, message: `Signup attribution ${status}`, meta: { stage: status }});
  } catch {  }
}
