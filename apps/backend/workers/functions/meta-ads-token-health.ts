
import { inngest } from "../client";
import { fleetSweepClient } from "@/services/tenant-client";
import { getSecret } from "@/services/secrets/vault";
import { logEvent } from "@/services/logging/logEvent";
import { enqueueSlackOutbox } from "@/services/slack/outbox";
import { getBoolSetting } from "@/services/settings";
import { resolveZaviChannel } from "@/services/slack/resolve-zavi-channel";
import {
  debugToken,
  exchangeForLongLivedToken,
} from "@/services/connectors/meta-ads/oauth";
import {
  persistMetaAdsExpiry,
  META_ADS_SLUG,
  META_ADS_TOKEN_KEY,
} from "@/services/connectors/meta-ads/expiry";
import { webBaseUrl } from "@/services/web-base";

const MS_PER_DAY = 86400 * 1000;

const REFRESH_WINDOW_DAYS = 21;

const NOTICE_BUCKETS = [2, 7, 14] as const;

const MAX_TENANTS_PER_SWEEP = 500;

function webBase(): string {
  return webBaseUrl();
}

function reconnectUrl(): string {
  return `${webBase()}/workspace?tab=settings`;
}

type ConnectorRow = { tenant_id: string; token_expires_at: string | null };

async function stampExpiredIfNeeded(
  tenant_id: string,
  storedExpiry: Date | null,
  token: string,
): Promise<Date | null> {
  if (storedExpiry && storedExpiry.getTime() <= Date.now()) return storedExpiry;
  const now = new Date();
  const ok = await persistMetaAdsExpiry({ tenant_id, access_token: token, expires_at: now });
  return ok ? now : null;
}

async function sendNotice(args: {
  tenant_id: string;
  bucket: "14d" | "7d" | "2d" | "invalid";
  cycleEpoch: number;
  body: string;
}): Promise<void> {
  const channel_id = await resolveZaviChannel(args.tenant_id, "").catch(() => null);
  if (!channel_id) {
    await logEvent({
      level: "info",
      source: "meta_ads",
      code: "meta_ads.expiry_notice_no_slack_channel",
      tenant_id: args.tenant_id,
      message: "No Slack channel for connector notice; in-app banner is the surface",
      meta: { connector_slug: META_ADS_SLUG, notice_bucket: args.bucket },
    });
    return;
  }
  let alertsOn = false;
  try {
    alertsOn = await getBoolSetting("slack_connector_alert_enabled", args.tenant_id);
  } catch {
    alertsOn = false;
  }
  if (!alertsOn) {
    await logEvent({
      level: "info",
      source: "meta-ads-token-health",
      code: "meta_ads.expiry_notice_opted_out",
      tenant_id: args.tenant_id,
      message: "Connector alert suppressed; tenant has Slack connector alerts off",
      meta: { connector_slug: META_ADS_SLUG, notice_bucket: args.bucket },
    });
    return;
  }

  await enqueueSlackOutbox({
    tenant_id: args.tenant_id,
    channel_id,
    thread_ts: null,
    kind: "connector_alert",
    body: args.body,
    idempotency_key: `meta_ads_expiry:${args.tenant_id}:${args.cycleEpoch}:${args.bucket}`,
    depends_on_answer: false,
  });
}

function expiringBody(days: number): string {
  return (
    `*Meta Ads access expires in ${days} day${days === 1 ? "" : "s"}.*\n` +
    `Reconnect to keep campaign reporting live: ${reconnectUrl()}`
  );
}

function invalidBody(): string {
  return (
    "*Meta Ads is disconnected.* The Facebook access token expired or was revoked, " +
    "so campaign data can't be read right now.\n" +
    `Reconnect here: ${reconnectUrl()}`
  );
}

export async function checkTenantTokenHealth(row: ConnectorRow): Promise<string> {
  const { tenant_id } = row;
  const storedExpiry = row.token_expires_at ? new Date(row.token_expires_at) : null;

  const token = await getSecret(tenant_id, META_ADS_TOKEN_KEY);
  if (!token) return "no_token";

  const dbg = await debugToken(token);

  if (!dbg.is_valid) {
    const cycle = await stampExpiredIfNeeded(tenant_id, storedExpiry, token);
    if (!cycle) {
      return "invalid_stamp_failed";
    }
    const alert = await import("@/services/growth/cgo-blockers")
      .then(({ alertFounderSafely }) => alertFounderSafely(tenant_id, "meta ads token"))
      .catch(() => null);
    const covered = !!alert && alert.urgent_ids.includes("connector:meta_ads");
    if (!covered) {
      await sendNotice({
        tenant_id,
        bucket: "invalid",
        cycleEpoch: cycle.getTime(),
        body: invalidBody(),
      });
    }
    await logEvent({
      level: "warn",
      source: "meta-ads-token-health",
      code: "meta_ads.token_invalid",
      tenant_id,
      message: covered ? "Meta Ads token is dead; founder alerted through cgo" : "Meta Ads token is dead; reconnect notice sent",
      meta: { connector_slug: META_ADS_SLUG, notice_bucket: "invalid" },
    });
    return "invalid";
  }

  if (!dbg.expires_at) return "never_expires";

  const authoritativeExpiry = dbg.expires_at;
  const effectiveExpiry = authoritativeExpiry;
  const daysLeft = Math.ceil((authoritativeExpiry.getTime() - Date.now()) / MS_PER_DAY);

  if (daysLeft <= REFRESH_WINDOW_DAYS) {
    try {
      const refreshed = await exchangeForLongLivedToken(token);

      const verified = await debugToken(refreshed.access_token).catch(() => null);
      const newExpiry = verified?.expires_at ?? null;
      const moved =
        verified?.is_valid === true &&
        !!newExpiry &&
        newExpiry.getTime() > authoritativeExpiry.getTime() + 3600 * 1000;

      if (moved && newExpiry) {
        await persistMetaAdsExpiry({
          tenant_id,
          access_token: refreshed.access_token,
          expires_at: newExpiry,
        });
        await logEvent({
          level: "info",
          source: "meta_ads",
          code: "meta_ads.rolling_refresh_ok",
          tenant_id,
          message: "Rolling re-exchange extended the Meta token",
          meta: {
            connector_slug: META_ADS_SLUG,
            refresh_effective: 1,
            token_days_remaining: Math.ceil((newExpiry.getTime() - Date.now()) / MS_PER_DAY),
          },
        });
        return "refreshed";
      }

      await logEvent({
        level: "warn",
        source: "meta_ads",
        code: "meta_ads.rolling_refresh_ineffective",
        tenant_id,
        message:
          "fb_exchange_token did not extend the long-lived token; degrading to warn-only",
        meta: {
          connector_slug: META_ADS_SLUG,
          refresh_effective: 0,
          token_days_remaining: daysLeft,
        },
      });
    } catch (e) {
      await logEvent({
        level: "warn",
        source: "meta_ads",
        code: "meta_ads.rolling_refresh_failed",
        tenant_id,
        error: e,
        meta: { connector_slug: META_ADS_SLUG, token_days_remaining: daysLeft },
      });
    }
  }

  await persistMetaAdsExpiry({
    tenant_id,
    access_token: token,
    expires_at: effectiveExpiry,
  });

  const remaining = Math.ceil((effectiveExpiry.getTime() - Date.now()) / MS_PER_DAY);
  const bucket = NOTICE_BUCKETS.find((b) => remaining <= b);
  if (bucket) {
    await sendNotice({
      tenant_id,
      bucket: `${bucket}d` as "14d" | "7d" | "2d",
      cycleEpoch: effectiveExpiry.getTime(),
      body: expiringBody(remaining > 0 ? remaining : 0),
    });
    return `warned_${bucket}d`;
  }
  return "ok";
}

async function loadConnectedTenants(tenant_id?: string): Promise<ConnectorRow[]> {
  let q = fleetSweepClient("meta-ads token-health daily cross-tenant expiry sweep")
    .from("connector_metadata")
    .select("tenant_id, token_expires_at")
    .eq("slug", META_ADS_SLUG)
    .limit(MAX_TENANTS_PER_SWEEP);
  if (tenant_id) q = q.eq("tenant_id", tenant_id);
  const { data, error } = await q;
  if (error) throw new Error(`connector_metadata read failed: ${error.message}`);
  return (data ?? []) as ConnectorRow[];
}

async function sweep(
  logger: { info: (m: string) => void; warn: (m: string) => void },
  tenant_id?: string,
): Promise<{ checked: number; failed: number }> {
  const rows = await loadConnectedTenants(tenant_id);
  let failed = 0;
  for (const row of rows) {
    try {
      const status = await checkTenantTokenHealth(row);
      logger.info(`meta_ads_token_health: ${row.tenant_id.slice(0, 8)} → ${status}`);
    } catch (e) {
      failed++;
      await logEvent({
        level: "warn",
        source: "meta_ads",
        code: "meta_ads.token_health_tenant_failed",
        tenant_id: row.tenant_id,
        error: e,
        meta: { connector_slug: META_ADS_SLUG },
      });
    }
  }
  return { checked: rows.length, failed };
}

export const metaAdsTokenHealthFn = inngest.createFunction(
  { id: "meta-ads-token-health" },
  { cron: "0 5 * * *" },
  async ({ logger }) => {
    const res = await sweep(logger);
    logger.info(
      `meta_ads_token_health: checked=${res.checked} failed=${res.failed}`,
    );
    return res;
  },
);

export const metaAdsTokenInvalidFn = inngest.createFunction(
  { id: "meta-ads-token-invalid" },
  { event: "meta_ads.token_invalid" },
  async ({ event, logger }) => {
    const tenant_id = String(event.data?.tenant_id ?? "");
    if (!tenant_id) return { checked: 0, failed: 0 };
    return sweep(logger, tenant_id);
  },
);

export const metaAdsDeauthorizedFn = inngest.createFunction(
  { id: "meta-ads-deauthorized", concurrency: { limit: 1 } },
  { event: "meta_ads.deauthorized" },
  async ({ logger }) => {
    const res = await sweep(logger);
    logger.info(
      `meta_ads_deauthorized: checked=${res.checked} failed=${res.failed}`,
    );
    return res;
  },
);
