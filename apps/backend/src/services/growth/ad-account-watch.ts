import { asTenantId, clearTenantMarker, stampTenantMarker, tenantMarkerAt } from "@/services/tenant-client";

export const META_ACCOUNT_ACTIVE = 1;
export const META_NOT_READY_MARKER = "meta_ads_not_ready";
export const META_ACCOUNT_BLOCKED_MARKER = "meta_ads_account_blocked";
export const GOOGLE_ACCOUNT_BLOCKED_MARKER = "google_ads_account_blocked";

const META_ACCOUNT_STATUS_WORDS: Record<number, string> = {
  2: "disabled",
  3: "unsettled",
  7: "pending_risk_review",
  8: "pending_settlement",
  9: "in_grace_period",
  100: "pending_closure",
  101: "closed",
};
const GOOGLE_BLOCKED_STATUSES = new Set(["SUSPENDED", "CANCELED", "CLOSED"]);

const OTHER = "other";
const REASONS: Record<string, readonly string[]> = {
  [META_ACCOUNT_BLOCKED_MARKER]: [...Object.values(META_ACCOUNT_STATUS_WORDS), OTHER],
  [META_NOT_READY_MARKER]: ["connector_missing", "account_not_writable", "page_permission_missing", "no_page", OTHER],
  [GOOGLE_ACCOUNT_BLOCKED_MARKER]: ["suspended", "canceled", "closed", OTHER],
};

export type MarkerDeps = {
  at: (tenant_id: string, bucket: string) => Promise<number | null>;
  stamp: (tenant_id: string, bucket: string, now: Date) => Promise<void>;
  clear: (tenant_id: string, bucket: string) => Promise<void>;
  alert: (tenant_id: string) => Promise<void>;
};

const defaultMarkerDeps: MarkerDeps = {
  at: (t, b) => tenantMarkerAt(asTenantId(t), b),
  stamp: (t, b, now) => stampTenantMarker(asTenantId(t), b, now),
  clear: (t, b) => clearTenantMarker(asTenantId(t), b),
  alert: async (t) => {
    await (await import("./cgo-blockers")).alertFounderSafely(t, "ad account");
  },
};

export function metaAccountStatusWord(status: unknown): string | null {
  const n = typeof status === "string" ? Number.parseInt(status, 10) : typeof status === "number" ? status : NaN;
  if (!Number.isFinite(n) || n === META_ACCOUNT_ACTIVE) return null;
  return META_ACCOUNT_STATUS_WORDS[n] ?? `status_${n}`;
}

export function googleAccountStatusWord(status: unknown): string | null {
  if (typeof status !== "string" || !status) return null;
  return GOOGLE_BLOCKED_STATUSES.has(status.toUpperCase()) ? status.toLowerCase() : null;
}

export async function readAccountMarker(
  tenant_id: string,
  bucket: string,
  deps: Partial<MarkerDeps> = {},
): Promise<{ since: string; reason: string | null } | null> {
  const d = { ...defaultMarkerDeps, ...deps };
  const hits = await Promise.all((REASONS[bucket] ?? []).map(async (r) => [r, await d.at(tenant_id, `${bucket}:${r}`)] as const));
  const hit = hits.find(([, at]) => at !== null);
  if (!hit) return null;
  return { since: new Date(hit[1]!).toISOString(), reason: hit[0] === OTHER ? null : hit[0] };
}

async function flip(tenant_id: string, bucket: string, blockedWhy: string | null, now: Date, d: MarkerDeps): Promise<"blocked" | "ready" | "unchanged"> {
  const current = await readAccountMarker(tenant_id, bucket, d);
  const was = current ? `${bucket}:${current.reason ?? OTHER}` : null;
  if (blockedWhy === null) {
    if (!was) return "unchanged";
    await d.clear(tenant_id, was);
    return "ready";
  }
  const why = (REASONS[bucket] ?? []).includes(blockedWhy) ? blockedWhy : OTHER;
  const next = `${bucket}:${why}`;
  if (was === next) return "unchanged";
  if (was) await d.clear(tenant_id, was);
  await d.stamp(tenant_id, next, now);
  await d.alert(tenant_id);
  return "blocked";
}

export async function noteMetaAccountStatus(
  tenant_id: string,
  _account_id: string,
  status: unknown,
  now: Date = new Date(),
  deps: Partial<MarkerDeps> = {},
): Promise<"blocked" | "ready" | "unchanged"> {
  if (status === undefined || status === null || status === "") return "unchanged";
  return flip(tenant_id, META_ACCOUNT_BLOCKED_MARKER, metaAccountStatusWord(status), now, { ...defaultMarkerDeps, ...deps });
}

export async function noteMetaReadiness(
  tenant_id: string,
  reason: string | null,
  now: Date = new Date(),
  deps: Partial<MarkerDeps> = {},
): Promise<"blocked" | "ready" | "unchanged"> {
  if (reason === "lookup_failed" || reason === "meta_busy" || reason === "token_expired") return "unchanged";
  return flip(tenant_id, META_NOT_READY_MARKER, reason, now, { ...defaultMarkerDeps, ...deps });
}

export async function noteGoogleAccountStatus(
  tenant_id: string,
  _customer_id: string,
  status: unknown,
  now: Date = new Date(),
  deps: Partial<MarkerDeps> = {},
): Promise<"blocked" | "ready" | "unchanged"> {
  if (typeof status !== "string" || !status || status.toUpperCase() === "UNKNOWN" || status.toUpperCase() === "UNSPECIFIED") return "unchanged";
  return flip(tenant_id, GOOGLE_ACCOUNT_BLOCKED_MARKER, googleAccountStatusWord(status), now, { ...defaultMarkerDeps, ...deps });
}
