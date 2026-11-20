import { describeMissing } from "../SlackReconnectBanner";

const META_ADS_TOKEN_TTL_DAYS = 60;
const TOKEN_EXPIRY_WARN_DAYS = 14;
const MS_PER_DAY = 86400 * 1000;

export type ExpiryHealth = {
  status: "healthy" | "expiring" | "expired";
  daysToExpiry: number;
};

export type ConnectorHealthStatus = "ok" | "expiring" | "expired" | "scope_drift";

export type ConnectorHealth = {
  status: ConnectorHealthStatus;
  reason?: string;
  daysToExpiry?: number;
};

export function resolveExpiryMs(
  connectedAt: string | undefined,
  tokenExpiresAt: string | undefined,
): number | null {
  if (tokenExpiresAt) {
    const ms = Date.parse(tokenExpiresAt);
    if (!Number.isNaN(ms)) return ms;
  }
  if (!connectedAt) return null;
  const connectedMs = Date.parse(connectedAt);
  if (Number.isNaN(connectedMs)) return null;
  return connectedMs + META_ADS_TOKEN_TTL_DAYS * MS_PER_DAY;
}

export function computeMetaAdsHealth(
  connectedAt: string | undefined,
  tokenExpiresAt?: string | undefined,
  now: number = Date.now(),
): ExpiryHealth | null {
  const expiresMs = resolveExpiryMs(connectedAt, tokenExpiresAt);
  if (expiresMs === null) return null;
  const daysToExpiry = Math.ceil((expiresMs - now) / MS_PER_DAY);
  if (daysToExpiry <= 0) return { status: "expired", daysToExpiry: 0 };
  if (daysToExpiry <= TOKEN_EXPIRY_WARN_DAYS)
    return { status: "expiring", daysToExpiry };
  return { status: "healthy", daysToExpiry };
}

type HealthInput = {
  slug: string;
  connected: boolean;
  connected_at?: string;
  token_expires_at?: string;
};

const EXPIRED_REASON =
  "Access token expired. Agents can't read this account until you reconnect.";

const LINKEDIN_ADS_REVOKED_MARK_MS = 0;
const LINKEDIN_ADS_REVOKED_REASON =
  "LinkedIn Ads stopped accepting Zavi's access. Agents can't read this account until you reconnect.";

export function resolveRowHealth(
  row: HealthInput,
  slackMissingScopes: readonly string[] = [],
  now: number = Date.now(),
): ConnectorHealth | undefined {
  if (!row.connected) return undefined;
  if (row.slug === "slack") {
    if (slackMissingScopes.length === 0) return { status: "ok" };
    return {
      status: "scope_drift",
      reason: `${describeMissing(slackMissingScopes)} Reconnect to grant them.`,
    };
  }
  if (row.slug === "linkedin_ads") {
    const ms = row.token_expires_at ? Date.parse(row.token_expires_at) : NaN;
    return ms <= LINKEDIN_ADS_REVOKED_MARK_MS
      ? { status: "expired", reason: LINKEDIN_ADS_REVOKED_REASON, daysToExpiry: 0 }
      : { status: "ok" };
  }
  const expiry =
    row.slug === "meta_ads"
      ? computeMetaAdsHealth(row.connected_at, row.token_expires_at, now)
      : (row.slug === "google_ads" || row.slug === "linkedin_social") && row.token_expires_at
        ? computeMetaAdsHealth(undefined, row.token_expires_at, now)
        : null;
  if (!expiry || expiry.status === "healthy") return { status: "ok" };
  if (expiry.status === "expired") {
    return { status: "expired", reason: EXPIRED_REASON, daysToExpiry: 0 };
  }
  return {
    status: "expiring",
    reason: `Access token expires in ${expiry.daysToExpiry} day${expiry.daysToExpiry === 1 ? "" : "s"}. Reconnect to refresh it.`,
    daysToExpiry: expiry.daysToExpiry,
  };
}

export function needsReconnect(health: ConnectorHealth | undefined): boolean {
  return health?.status === "expired" || health?.status === "scope_drift";
}

export type TileTone = "connected" | "idle" | "warning" | "danger";

export function connectionState(
  connected: boolean,
  health: ConnectorHealth | undefined,
): { tone: TileTone; text: string } {
  if (!connected) return { tone: "idle", text: "Not connected" };
  if (needsReconnect(health)) return { tone: "danger", text: "Needs reconnect" };
  if (health?.status === "expiring") {
    return { tone: "warning", text: `Expiring in ${health.daysToExpiry ?? 0}d` };
  }
  return { tone: "connected", text: "Connected" };
}
