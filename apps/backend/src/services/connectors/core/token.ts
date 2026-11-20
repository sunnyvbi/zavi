
import { serviceClient } from "@/services/supabase";
import { getSecret } from "@/services/secrets/vault";
import { getConnector } from "./registry";
import { assertNoLabRefresh } from "./lab-mode";
import { asTenantId, tenantRpc } from "@/services/tenant-client";

const REFRESH_SKEW_MS = 5 * 60 * 1000;

const inflight = new Map<string, Promise<void>>();

async function readExpiry(
  tenant_id: string,
  slug: string,
): Promise<Date | null> {
  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select("token_expires_at")
    .eq("tenant_id", tenant_id)
    .eq("slug", slug)
    .maybeSingle();
  if (error) {
    throw new Error(`connector_metadata read failed: ${error.message}`);
  }
  const exp = (data as { token_expires_at?: string | null } | null)
    ?.token_expires_at;
  return exp ? new Date(exp) : null;
}

async function doRefresh(tenant_id: string, slug: string): Promise<void> {
  const connector = getConnector(slug);
  if (!connector || !connector.refreshToken) return;
  assertNoLabRefresh(slug);
  const res = await connector.refreshToken(tenant_id);
  const { error } = await serviceClient().rpc("refresh_connector_secrets", {
    p_tenant_id: tenant_id,
    p_slug: slug,
    p_secrets: res.secrets,
    p_expires_at: new Date(Date.now() + res.expiresInSec * 1000).toISOString(),
  });
  if (error) {
    throw new Error(`refresh_connector_secrets failed: ${error.message}`);
  }
  await refreshConnectorIdentity(tenant_id, slug).catch(() => undefined);
}

export async function refreshConnectorIdentity(
  tenant_id: string,
  slug: string,
): Promise<{ team_id: string; team_name: string } | null> {
  const connector = getConnector(slug);
  if (!connector?.fetchIdentity) return null;
  const who = await connector.fetchIdentity(tenant_id);
  if (!who || !who.team_name.trim()) return null;

  const { data: before } = await serviceClient()
    .from("connector_metadata")
    .select("team_id")
    .eq("tenant_id", tenant_id)
    .eq("slug", slug)
    .maybeSingle();
  const previousTeamId = (before as { team_id?: string | null } | null)?.team_id ?? null;

  const { error } = await serviceClient()
    .from("connector_metadata")
    .update({ team_id: who.team_id, team_name: who.team_name })
    .eq("tenant_id", tenant_id)
    .eq("slug", slug);
  if (error) {
    throw new Error(`connector_metadata identity update failed: ${error.message}`);
  }

  if (previousTeamId && previousTeamId !== who.team_id) {
    await handleConnectorAccountSwap(tenant_id, slug);
  }
  return who;
}

const SWAP_SCOPE: Record<
  string,
  { metricChannel?: string; postChannels?: string[]; adsPlatform?: string; tiktokQueue?: boolean }
> = {
  x_social: { metricChannel: "x", postChannels: ["x", "x_image", "x_video"] },
  instagram_social: { postChannels: ["instagram_image", "instagram_video"] },
  reddit_social: { postChannels: ["reddit", "reddit_comment"] },
  linkedin_social: { postChannels: ["linkedin", "linkedin_image", "linkedin_video"] },
  tiktok: { postChannels: ["tiktok_video"], tiktokQueue: true },
  meta_ads: { adsPlatform: "meta_ads" },
};

const PRE_CLAIM_SOCIAL = ["approved", "scheduled"];
const PRE_CLAIM_TIKTOK = ["scheduled"];

export async function priorConnectorTeamId(
  tenant_id: string,
  slug: string,
): Promise<string | null> {
  const { data } = await serviceClient()
    .from("connector_metadata")
    .select("team_id")
    .eq("tenant_id", tenant_id)
    .eq("slug", slug)
    .maybeSingle();
  return (data as { team_id?: string | null } | null)?.team_id ?? null;
}

export async function handleConnectorAccountSwap(
  tenant_id: string,
  slug: string,
): Promise<void> {
  const scope = SWAP_SCOPE[slug];
  if (!scope) return;
  const db = serviceClient();

  if (scope.metricChannel) {
    await swallow(
      slug,
      "post metric cache",
      db
        .from("social_post_metric_snapshots")
        .delete()
        .eq("tenant_id", tenant_id)
        .eq("channel", scope.metricChannel),
    );
  }

  if (scope.postChannels?.length) {
    await swallow(
      slug,
      "queued posts",
      db
        .from("social_posts")
        .update({ status: "cancelled", last_error: "disconnected" })
        .eq("tenant_id", tenant_id)
        .in("channel", scope.postChannels)
        .in("status", PRE_CLAIM_SOCIAL),
    );
  }

  if (scope.tiktokQueue) {
    await swallow(
      slug,
      "queued tiktok posts",
      db
        .from("tiktok_scheduled_posts")
        .update({ status: "cancelled" })
        .eq("tenant_id", tenant_id)
        .in("status", PRE_CLAIM_TIKTOK),
    );
  }

  if (scope.adsPlatform) {
    await swallow(
      slug,
      "auto-spend cap",
      db
        .from("tenant_ads_write_caps")
        .update({ enabled: false })
        .eq("tenant_id", tenant_id)
        .eq("platform", scope.adsPlatform),
    );
  }
}

async function swallow(
  slug: string,
  what: string,
  q: PromiseLike<{ error: { message: string } | null }>,
): Promise<void> {
  try {
    const { error } = await q;
    if (error) console.warn(`[connector-swap] ${slug}: ${what} not cleared: ${error.message}`);
  } catch (e) {
    console.warn(`[connector-swap] ${slug}: ${what} threw: ${(e as Error).message}`);
  }
}

async function refreshIfNeeded(tenant_id: string, slug: string): Promise<void> {
  const connector = getConnector(slug);
  if (!connector || !connector.refreshToken) return;
  const expiresAt = await readExpiry(tenant_id, slug);
  if (!expiresAt) return;
  if (expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS) return;

  const key = `${tenant_id}:${slug}`;
  const existing = inflight.get(key);
  if (existing) {
    await existing;
    return;
  }
  const p = doRefresh(tenant_id, slug).finally(() => inflight.delete(key));
  inflight.set(key, p);
  await p;
}

export async function connectorTokenExpiresAt(
  tenant_id: string,
  slug: string,
): Promise<Date | null> {
  return readExpiry(tenant_id, slug);
}

export async function markConnectorTokenRevoked(
  tenant_id: string,
  slug: string,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await tenantRpc(asTenantId(tenant_id), "refresh_connector_secrets", {
    p_slug: slug,
    p_secrets: {},
    p_expires_at: now.toISOString(),
  });
  if (error) throw new Error(`refresh_connector_secrets failed: ${error.message}`);
}

export async function connectorScopes(
  tenant_id: string,
  slug: string,
): Promise<string[] | null> {
  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select("scopes")
    .eq("tenant_id", tenant_id)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`connector_metadata read failed: ${error.message}`);
  const scopes = (data as { scopes?: unknown } | null)?.scopes;
  return Array.isArray(scopes) && scopes.length ? scopes.map(String) : null;
}

export async function getConnectorToken(
  tenant_id: string,
  slug: string,
  key: string,
): Promise<string | null> {
  await refreshIfNeeded(tenant_id, slug);
  return getSecret(tenant_id, key);
}

export async function forceRefreshConnector(
  tenant_id: string,
  slug: string,
): Promise<void> {
  const connector = getConnector(slug);
  if (!connector || !connector.refreshToken) return;
  const key = `${tenant_id}:${slug}`;
  const existing = inflight.get(key);
  if (existing) {
    await existing;
    return;
  }
  const p = doRefresh(tenant_id, slug).finally(() => inflight.delete(key));
  inflight.set(key, p);
  await p;
}
