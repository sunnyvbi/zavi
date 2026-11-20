
import { asTenantId, clearTenantMarker, consumeTenantRateLimit, tenantClient } from "@/services/tenant-client";
import { resolveTenantOwnerEmail, sendBuildLiveEmail, sendSiteAdminLoginEmail } from "@/email/sendAuthEmail";
import { webBaseUrl } from "@/services/web-base";
import { getBoolSetting } from "@/services/settings";
import { siteHasSignupPage } from "@/services/website/site-signup";
import { activateAppInvite, createOwnerAdminInvite, hasOwnerAdminInvite } from "@/services/website/app-invites";
import { publishUrlFromResources } from "@/services/build/app-ready";
import type { SiteRow, SiteStore, SupabaseSiteProvisioner } from "@/services/sites/contract";
import { siteIdFromGraph } from "@/services/sites/site-run";
import { founderWatchingBuild } from "@/services/build/build-watch";
import { siteShownName } from "@/services/sites/label";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";

export type BuildLiveEmailDeps = {
  store?: SiteStore;
  ownerMagicLink?: SupabaseSiteProvisioner["ownerMagicLink"];
  tickOwnerLink?: (tenant_id: string, site_id: string) => Promise<boolean>;
  releaseOwnerLink?: (tenant_id: string, site_id: string) => Promise<void>;
  watching?: (tenant_id: string, session_id: string) => Promise<boolean>;
  claimSiteEmail?: (tenant_id: string, site_id: string) => Promise<boolean>;
  releaseSiteEmail?: (tenant_id: string, site_id: string) => Promise<void>;
  claimAdminLogin?: (tenant_id: string, site_id: string) => Promise<boolean>;
  releaseAdminLogin?: (tenant_id: string, site_id: string) => Promise<void>;
};

async function defaultClaimAdminLogin(tenant_id: string, site_id: string): Promise<boolean> {
  return consumeTenantRateLimit(asTenantId(tenant_id), `site_admin_login:${site_id}`, 1, SITE_LIVE_EMAIL_ONCE_S);
}

async function defaultReleaseAdminLogin(tenant_id: string, site_id: string): Promise<void> {
  await clearTenantMarker(asTenantId(tenant_id), `site_admin_login:${site_id}`);
}

const SITE_LIVE_EMAIL_ONCE_S = 10 * 365 * 24 * 60 * 60;

async function defaultClaimSiteEmail(tenant_id: string, site_id: string): Promise<boolean> {
  return consumeTenantRateLimit(asTenantId(tenant_id), `build_live_email:${site_id}`, 1, SITE_LIVE_EMAIL_ONCE_S);
}

async function defaultReleaseSiteEmail(tenant_id: string, site_id: string): Promise<void> {
  await clearTenantMarker(asTenantId(tenant_id), `build_live_email:${site_id}`);
}

async function siteOwnerFeatureOn(tenantId: string): Promise<boolean> {
  return getBoolSetting("build_auto_site_owner", tenantId).catch(() => false);
}

async function defaultTickOwnerLink(tenant_id: string, site_id: string): Promise<boolean> {
  return consumeTenantRateLimit(asTenantId(tenant_id), `owner_link:${site_id}`, 1, OWNER_LINK_RESEND_COOLDOWN_MS / 1000);
}

async function defaultReleaseOwnerLink(tenant_id: string, site_id: string): Promise<void> {
  await clearTenantMarker(asTenantId(tenant_id), `owner_link:${site_id}`);
}

async function defaultSiteStore(): Promise<SiteStore> {
  const { siteStore } = await import("@/services/sites/store");
  return siteStore();
}

async function defaultOwnerMagicLink(): Promise<SupabaseSiteProvisioner["ownerMagicLink"] | null> {
  const { siteOwnerMagicLink } = await import("@/services/sites/wiring");
  return siteOwnerMagicLink();
}

function siteLiveUrl(site: SiteRow): string | null {
  if (!site.live_deploy_id) return null;
  if (typeof site.live_url === "string" && /^https:\/\//.test(site.live_url)) return site.live_url;
  return site.hostname ? `https://${site.hostname}` : null;
}

export function siteNameFromObjective(objective: string | null | undefined): string | null {
  const s = decodeXmlEntities(objective ?? "").replace(/^build product:\s*/i, "").split(/\s+[—–-]\s+/)[0]?.trim();
  return s ? s.slice(0, 80) : null;
}

export function liveUrlFromResources(
  rows: Array<{ resource_kind?: string | null; status?: string | null; external_ref?: unknown }>,
): string | null {
  const ref = (kind: string) =>
    (rows.find((x) => x.resource_kind === kind && x.status === "ready")?.external_ref ?? null) as
      | { url?: unknown; hostname?: unknown }
      | null;
  const hosting = ref("hosting");
  if (typeof hosting?.url === "string" && /^https:\/\//.test(hosting.url)) return hosting.url;
  const domain = ref("domain");
  if (typeof domain?.hostname === "string" && domain.hostname) return `https://${domain.hostname}`;
  return null;
}

type GraphNode = {
  status?: unknown;
  hosting_verified_at?: unknown;
  payload?: { stage?: unknown; refine_mode?: unknown } | null;
};

export function deployCompleted(goalGraph: unknown): boolean {
  if (!Array.isArray(goalGraph)) return false;
  const deploys = (goalGraph as GraphNode[]).filter((n) => n?.payload?.stage === "deploy");
  return (
    deploys.length > 0 &&
    deploys.every(
      (n) => n.status === "done" && typeof n.hosting_verified_at === "string" && n.hosting_verified_at !== "",
    )
  );
}

export function isRefineGraph(goalGraph: unknown): boolean {
  return Array.isArray(goalGraph) && (goalGraph as GraphNode[])[0]?.payload?.refine_mode === true;
}

type OwnerInvite = { adminUrl: string; setupUrl: string; inviteId: string; email: string };

async function prepareOwnerInvite(tenantId: string, liveUrl: string): Promise<OwnerInvite | null> {
  try {
    if (!(await getBoolSetting("build_auto_site_owner", tenantId).catch(() => false))) return null;
    if ((await siteHasSignupPage(liveUrl)) !== true) return null;
    const email = await resolveTenantOwnerEmail(tenantId);
    if (!email) return null;
    const { token, invite } = await createOwnerAdminInvite(asTenantId(tenantId), email);
    const setup = new URL("/api/auth/magic", liveUrl);
    setup.searchParams.set("token", token);
    return { adminUrl: new URL("/admin", liveUrl).toString(), setupUrl: setup.toString(), inviteId: invite.id, email };
  } catch (e) {
    console.warn(`[build-live-email] owner invite skipped for ${tenantId}: ${(e as { code?: string }).code ?? "error"}`);
    return null;
  }
}

export type OwnerAdminAccess = { adminUrl: string; ownerEmail: string };

export const OWNER_ADMIN_ACCESS_TTL_MS = 60_000;
const OWNER_ADMIN_ACCESS_MAX = 1_000;
const ownerAdminAccessCache = new Map<string, { at: number; value: OwnerAdminAccess | null }>();

export function clearOwnerAdminAccessCache(tenantId?: string): void {
  if (tenantId === undefined) {
    ownerAdminAccessCache.clear();
    return;
  }
  for (const key of ownerAdminAccessCache.keys()) {
    if (key.startsWith(`${tenantId}\n`)) ownerAdminAccessCache.delete(key);
  }
}

export async function ownerAdminAccess(tenantId: string, liveUrl: string | null): Promise<OwnerAdminAccess | null> {
  if (!liveUrl) return null;
  const key = `${tenantId}\n${liveUrl}`;
  const hit = ownerAdminAccessCache.get(key);
  if (hit && Date.now() - hit.at < OWNER_ADMIN_ACCESS_TTL_MS) return hit.value;
  const value = await readOwnerAdminAccess(tenantId, liveUrl);
  ownerAdminAccessCache.delete(key);
  ownerAdminAccessCache.set(key, { at: Date.now(), value });
  while (ownerAdminAccessCache.size > OWNER_ADMIN_ACCESS_MAX) {
    const oldest = ownerAdminAccessCache.keys().next().value;
    if (oldest === undefined) break;
    ownerAdminAccessCache.delete(oldest);
  }
  return value;
}

async function readOwnerAdminAccess(tenantId: string, liveUrl: string): Promise<OwnerAdminAccess | null> {
  try {
    if (!(await getBoolSetting("build_auto_site_owner", tenantId).catch(() => false))) return null;
    if ((await siteHasSignupPage(liveUrl)) !== true) return null;
    const email = await resolveTenantOwnerEmail(tenantId);
    if (!email) return null;
    if (!(await hasOwnerAdminInvite(asTenantId(tenantId), email))) return null;
    return { adminUrl: new URL("/admin", liveUrl).toString(), ownerEmail: email };
  } catch {
    return null;
  }
}

export const OWNER_INVITE_ACTIVATION_ATTEMPTS = 3;
const OWNER_INVITE_ACTIVATION_BACKOFF_MS = 150;

async function activateOwnerInvite(tenantId: string, inviteId: string): Promise<boolean> {
  let code = "error";
  for (let attempt = 1; attempt <= OWNER_INVITE_ACTIVATION_ATTEMPTS; attempt++) {
    try {
      await activateAppInvite(asTenantId(tenantId), inviteId);
      clearOwnerAdminAccessCache(tenantId);
      return true;
    } catch (e) {
      code = (e as { code?: string }).code ?? "error";
      if (code === "app_invite_not_found") break;
      if (attempt < OWNER_INVITE_ACTIVATION_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, OWNER_INVITE_ACTIVATION_BACKOFF_MS * attempt));
      }
    }
  }
  console.warn(`[build-live-email] owner invite ${inviteId} not activated for ${tenantId}: ${code}`);
  return false;
}

async function originalBuildObjective(tenantId: string): Promise<string | null> {
  const { data: builds } = await tenantClient(asTenantId(tenantId))
    .from("conductor_runs")
    .select("objective")
    .eq("tenant_id", tenantId)
    .eq("kind", "build_app")
    .eq("status", "done")
    .or("goal_graph->0->payload->>refine_mode.is.null,goal_graph->0->payload->>refine_mode.neq.true")
    .is("goal_graph->0->payload->>site_id", null)
    .is("goal_graph->1->payload->>site_id", null)
    .is("goal_graph->2->payload->>site_id", null)
    .order("created_at", { ascending: false })
    .limit(1);
  return ((builds ?? []) as Array<{ objective?: string | null }>)[0]?.objective ?? null;
}

export const OWNER_LINK_RESEND_COOLDOWN_MS = 5 * 60_000;
const OWNER_LINK_RELEASE_MARGIN_MS = 30_000;

export type OwnerLinkResend =
  | { sent: true; email: string }
  | { sent: false; reason: "disabled" | "cooldown" | "no_live_site" | "not_eligible" | "send_failed"; retryAfterS?: number };

async function resendSiteOwnerLink(tenantId: string, siteId: string, deps: BuildLiveEmailDeps): Promise<OwnerLinkResend> {
  const store = deps.store ?? (await defaultSiteStore());
  const site = await store.get(tenantId, siteId);
  if (!site || site.tenant_id !== tenantId) return { sent: false, reason: "no_live_site" };
  const liveUrl = site.status === "live" ? siteLiveUrl(site) : null;
  if (!liveUrl) return { sent: false, reason: "no_live_site" };
  const ownerEmail = (site.owner_email ?? "").trim();
  if (!ownerEmail) return { sent: false, reason: "not_eligible" };
  const recipient = await resolveTenantOwnerEmail(tenantId);
  if (!recipient || recipient.trim().toLowerCase() !== ownerEmail.toLowerCase()) return { sent: false, reason: "not_eligible" };
  const mint = deps.ownerMagicLink ?? (await defaultOwnerMagicLink());
  if (!mint) return { sent: false, reason: "not_eligible" };

  let allowed: boolean;
  try {
    allowed = await (deps.tickOwnerLink ?? defaultTickOwnerLink)(tenantId, site.id);
  } catch (e) {
    console.warn(`[build-live-email] owner link throttle unreadable for site ${site.id}: ${(e as { code?: string }).code ?? "error"}`);
    return { sent: false, reason: "send_failed" };
  }
  if (!allowed) return { sent: false, reason: "cooldown", retryAfterS: OWNER_LINK_RESEND_COOLDOWN_MS / 1000 };

  const claimedAt = Date.now();
  const release = async (): Promise<void> => {
    if (Date.now() - claimedAt >= OWNER_LINK_RESEND_COOLDOWN_MS - OWNER_LINK_RELEASE_MARGIN_MS) return;
    const drop = deps.releaseOwnerLink ?? defaultReleaseOwnerLink;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await drop(tenantId, site.id);
        return;
      } catch (e) {
        console.warn(`[build-live-email] owner link throttle release failed for site ${site.id} (attempt ${attempt}): ${(e as { code?: string }).code ?? "error"}`);
      }
    }
  };
  const adminUrl = `https://${site.hostname}/admin`;
  let link: string;
  try {
    link = await mint({ tenant_id: tenantId, site_id: site.id, owner_email: ownerEmail, redirect_to: adminUrl });
  } catch (e) {
    console.warn(`[build-live-email] owner link mint failed for site ${site.id}: ${(e as { code?: string }).code ?? "error"}`);
    await release();
    return { sent: false, reason: "send_failed" };
  }
  let out: { sent: boolean };
  try {
    out = await sendSiteAdminLoginEmail({
      tenant_id: tenantId,
      siteName: siteShownName(site),
      adminUrl,
      workspaceUrl: `${webBaseUrl()}/workspace`,
      ownerLogin: { email: ownerEmail, mint: async () => link },
    });
  } catch (e) {
    console.warn(`[build-live-email] owner link send failed for site ${site.id}: ${(e as { code?: string }).code ?? "error"}`);
    await release();
    return { sent: false, reason: "send_failed" };
  }
  if (!out.sent) {
    await release();
    return { sent: false, reason: "send_failed" };
  }
  return { sent: true, email: ownerEmail };
}

async function siteIdOfRun(tenantId: string, conductorRunId: string): Promise<string | null | undefined> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("conductor_runs")
    .select("goal_graph")
    .eq("id", conductorRunId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return undefined;
  return siteIdFromGraph((data as { goal_graph?: unknown }).goal_graph);
}

export async function resendOwnerLoginLink(
  tenantId: string,
  opts: { conductor_run_id?: string | null } = {},
  deps: BuildLiveEmailDeps = {},
): Promise<OwnerLinkResend> {
  if (!(await siteOwnerFeatureOn(tenantId))) {
    return { sent: false, reason: "disabled" };
  }
  const runId = (opts.conductor_run_id ?? "").trim();
  if (!runId) return { sent: false, reason: "no_live_site" };
  let siteId: string | null | undefined;
  try {
    siteId = await siteIdOfRun(tenantId, runId);
  } catch {
    siteId = undefined;
  }
  if (!siteId) return { sent: false, reason: "no_live_site" };
  try {
    return await resendSiteOwnerLink(tenantId, siteId, deps);
  } catch (e) {
    console.warn(`[build-live-email] site owner link resend failed for ${tenantId}: ${(e as { code?: string }).code ?? "error"}`);
    return { sent: false, reason: "send_failed" };
  }
}

async function rootBuildPublished(tenantId: string, site: SiteRow): Promise<boolean> {
  if (!site.root_conductor_run_id) return true;
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("conductor_runs")
    .select("goal_graph")
    .eq("id", site.root_conductor_run_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return true;
  return deployCompleted((data as { goal_graph?: unknown }).goal_graph);
}

export async function maybeSendBuildLiveEmail(
  params: {
    tenant_id: string;
    conductor_run_id: string;
  },
  deps: BuildLiveEmailDeps = {},
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const db = tenantClient(asTenantId(params.tenant_id));
    const { data: run } = await db
      .from("conductor_runs")
      .select("objective, status, kind, goal_graph")
      .eq("id", params.conductor_run_id)
      .eq("tenant_id", params.tenant_id)
      .maybeSingle();
    const r = run as
      | { objective?: string | null; status?: string; kind?: string; goal_graph?: unknown }
      | null;
    if (!r || r.kind !== "build_app" || r.status !== "done") return { sent: false, reason: "not_done" };
    if (!deployCompleted(r.goal_graph)) return { sent: false, reason: "not_deployed" };
    const refine = isRefineGraph(r.goal_graph);
    const onlyIfAway = await getBoolSetting("build_live_email_only_if_away", params.tenant_id).catch(() => false);
    const siteId = siteIdFromGraph(r.goal_graph);
    if (onlyIfAway && refine && !siteId) return { sent: false, reason: "edit" };
    const firstPublish = onlyIfAway && refine;
    const watching = (sessionId: string) => (deps.watching ?? founderWatchingBuild)(params.tenant_id, sessionId).catch(() => false);

    if (siteId) {
      const store = deps.store ?? (await defaultSiteStore());
      const site = await store.get(params.tenant_id, siteId);
      if (!site) return { sent: false, reason: "no_site" };
      const siteUrl = siteLiveUrl(site);
      if (!siteUrl) return { sent: false, reason: "no_live_url" };
      const claimSite = () => (deps.claimSiteEmail ?? defaultClaimSiteEmail)(params.tenant_id, site.id);
      if (firstPublish) {
        if (await rootBuildPublished(params.tenant_id, site)) return { sent: false, reason: "edit" };
        if (!(await claimSite())) return { sent: false, reason: "edit" };
      }
      const siteName = siteShownName(site);
      const mint = (await siteOwnerFeatureOn(params.tenant_id)) ? (deps.ownerMagicLink ?? (await defaultOwnerMagicLink())) : null;
      const ownerEmail = site.owner_email;
      const adminUrl = `https://${site.hostname}/admin`;
      const mintOwnerLink = mint && ownerEmail
        ?
          () => mint({ tenant_id: params.tenant_id, site_id: site.id, owner_email: ownerEmail, redirect_to: adminUrl })
        : null;
      const claimAdminLogin = () => (deps.claimAdminLogin ?? defaultClaimAdminLogin)(params.tenant_id, site.id);
      const releaseAdminLogin = () =>
        (deps.releaseAdminLogin ?? defaultReleaseAdminLogin)(params.tenant_id, site.id).catch((e: unknown) => {
          console.warn(`[build-live-email] admin login claim release failed for site ${site.id}: ${(e as Error).message}`);
        });
      const adminLoginOnce = async (): Promise<void> => {
        if (!mintOwnerLink || !ownerEmail) return;
        try {
          if (!(await claimAdminLogin())) return;
        } catch (e) {
          console.warn(`[build-live-email] admin login claim unreadable for site ${site.id}: ${(e as Error).message}`);
          return;
        }
        try {
          const out = await sendSiteAdminLoginEmail({
            tenant_id: params.tenant_id,
            siteName: siteShownName(site),
            adminUrl,
            workspaceUrl: `${webBaseUrl()}/workspace`,
            ownerLogin: { email: ownerEmail, mint: mintOwnerLink },
          });
          if (!out.sent) await releaseAdminLogin();
        } catch (e) {
          console.warn(`[build-live-email] admin login email failed for site ${site.id}: ${(e as Error).message}`);
          await releaseAdminLogin();
        }
      };
      if (onlyIfAway && (await watching(site.root_conductor_run_id ?? params.conductor_run_id))) {
        await adminLoginOnce();
        return { sent: false, reason: "watching" };
      }
      if (onlyIfAway && !firstPublish && !(await claimSite())) {
        await adminLoginOnce();
        return { sent: false, reason: "already_sent" };
      }
      const release = async () => {
        if (!onlyIfAway) return;
        await (deps.releaseSiteEmail ?? defaultReleaseSiteEmail)(params.tenant_id, site.id).catch((e: unknown) => {
          console.warn(`[build-live-email] claim release failed for site ${site.id}: ${(e as Error).message}`);
        });
      };
      const out = await sendBuildLiveEmail({
        tenant_id: params.tenant_id,
        siteName,
        liveUrl: siteUrl,
        workspaceUrl: `${webBaseUrl()}/workspace`,
        ...(mintOwnerLink && ownerEmail ? { ownerLogin: { email: ownerEmail, mint: mintOwnerLink }, ownerAdminUrl: adminUrl } : {}),
      }).catch(async (e: unknown) => {
        await release();
        throw e;
      });
      if (out.sent) {
        if (out.owner_login) await claimAdminLogin().catch(() => false);
        else await adminLoginOnce();
        return { sent: true };
      }
      await release();
      await adminLoginOnce();
      return { sent: false, reason: "no_owner_email" };
    }

    const { data: resources } = await db
      .from("tenant_resources")
      .select("resource_kind, status, external_ref")
      .eq("tenant_id", params.tenant_id);
    const resourceRows = (resources ?? []) as Array<{ resource_kind?: string; status?: string; external_ref?: unknown }>;
    const liveUrl = liveUrlFromResources(resourceRows);
    if (!liveUrl) return { sent: false, reason: "no_live_url" };
    const announceUrl = (await getBoolSetting("build_live_announcement", params.tenant_id).catch(() => false))
      ? (publishUrlFromResources(resourceRows, liveUrl) ?? liveUrl)
      : liveUrl;

    const { data: tenant } = await db
      .from("tenants")
      .select("display_name")
      .eq("id", params.tenant_id)
      .maybeSingle();
    const objective = refine ? await originalBuildObjective(params.tenant_id) : r.objective;
    const siteName =
      siteNameFromObjective(objective) ??
      (((tenant as { display_name?: string | null } | null)?.display_name ?? "").trim() || "Your site");

    const away = !onlyIfAway || !(await watching(params.conductor_run_id));
    const owner = refine ? null : await prepareOwnerInvite(params.tenant_id, liveUrl);
    if (!away && !owner) return { sent: false, reason: "watching" };
    const out = await sendBuildLiveEmail({
      tenant_id: params.tenant_id,
      siteName,
      liveUrl: announceUrl,
      workspaceUrl: `${webBaseUrl()}/workspace`,
      ...(owner ? { admin: { adminUrl: owner.adminUrl, setupUrl: owner.setupUrl } } : {}),
    });
    if (!out.sent) return { sent: false, reason: "no_owner_email" };
    if (owner && !(await activateOwnerInvite(params.tenant_id, owner.inviteId))) {
      return { sent: true, reason: "owner_link_inactive" };
    }
    return { sent: true };
  } catch (e) {
    console.warn(`[build-live-email] skipped for ${params.conductor_run_id}: ${(e as Error).message}`);
    return { sent: false, reason: "error" };
  }
}
