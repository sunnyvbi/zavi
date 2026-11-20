
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { defaultChannelContext } from "@/services/channels/context";
import { utcDay } from "@/services/x-social/read-cap";
import { fetchLinkedInPublicPage, normalizeLinkedInUrl, type LinkedInPublicPage } from "./public-page";
import { writeLinkedInRefreshStatus } from "./refresh-status";
import { withVendorContext } from "@/services/vendors/usage";

export const LINKEDIN_CHANNEL = "linkedin";
export const LINKEDIN_METER_KEY = "linkedin_metrics";
export const LINKEDIN_READS_PER_DAY = 3;

export function savedPageUrl(ctx: Record<string, unknown> | null): string | null {
  const settings = (ctx?.channel_settings ?? null) as Record<string, unknown> | null;
  const items = settings?.profile_url;
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    const raw = (it as { item?: unknown } | null)?.item;
    const url = typeof raw === "string" ? normalizeLinkedInUrl(raw) : null;
    if (url) return url;
  }
  return null;
}

export type ReadDeps = {
  fetchPage?: typeof fetchLinkedInPublicPage;
  fetchViaApify?: (pageUrl: string) => Promise<LinkedInPublicPage>;
};

export async function readLinkedInPage(pageUrl: string, deps: ReadDeps = {}): Promise<LinkedInPublicPage> {
  const direct = deps.fetchPage ?? fetchLinkedInPublicPage;
  let viaApify: LinkedInPublicPage | null = null;
  try {
    const apify = deps.fetchViaApify ?? (await import("./apify-posts")).fetchLinkedInViaApify;
    viaApify = await apify(pageUrl);
  } catch (err) {
    console.warn(`[linkedin-snapshots] apify read skipped: ${(err as { code?: string })?.code ?? (err as Error)?.message}`);
  }
  if (!viaApify || viaApify.posts.length === 0) return direct(pageUrl);
  if (viaApify.followers !== null) return viaApify;
  try {
    const own = await direct(pageUrl);
    return { ...viaApify, followers: own.followers, about: own.about, photo_url: own.photo_url };
  } catch {
    return viaApify;
  }
}

export type RefreshResult =
  | { ok: true; posts: number; used: number; cap: number }
  | { ok: false; reason: "no_page" | "automatic_read_used" | "cap_reached" | "unavailable" | "read_failed"; message: string };

export type RefreshDeps = ReadDeps & {
  automatic?: boolean;
  context?: typeof defaultChannelContext;
  rpc?: typeof tenantRpc;
  client?: ReturnType<typeof tenantClient>;
  now?: () => Date;
};

export async function refreshLinkedIn(tenantId: string, deps: RefreshDeps = {}): Promise<RefreshResult> {
  const now = (deps.now ?? (() => new Date()))();
  let pageUrl: string | null;
  try {
    pageUrl = savedPageUrl(await (deps.context ?? defaultChannelContext)(tenantId, "linkedin_organic"));
  } catch {
    return { ok: false, reason: "unavailable", message: "Zavi could not read this channel's settings just now." };
  }
  if (!pageUrl) return { ok: false, reason: "no_page", message: "Save your LinkedIn page in Settings first." };

  let used: number;
  try {
    const { data, error } = await (deps.rpc ?? tenantRpc)(asTenantId(tenantId), "consume_metered_read_or_reject", {
      p_day: utcDay(now),
      p_key: LINKEDIN_METER_KEY,
      p_cap: deps.automatic ? 1 : LINKEDIN_READS_PER_DAY,
    });
    if (error) return { ok: false, reason: "unavailable", message: "Zavi could not check today's refresh allowance." };
    if (data === null || data === undefined) {
      if (deps.automatic) return { ok: false, reason: "automatic_read_used", message: "An automatic refresh was already attempted today. Use Refresh to try again within today’s allowance." };
      return { ok: false, reason: "cap_reached", message: `All ${LINKEDIN_READS_PER_DAY} of today's LinkedIn refreshes are used. They reset at midnight UTC.` };
    }
    used = Number(data);
  } catch {
    return { ok: false, reason: "unavailable", message: "Zavi could not check today's refresh allowance." };
  }

  const finish = async (result: RefreshResult): Promise<RefreshResult> => {
    await writeLinkedInRefreshStatus(tenantId, { page_url: pageUrl!, at: new Date().toISOString(), ok: result.ok, message: result.ok ? null : result.message }, deps.client);
    return result;
  };
  let page: LinkedInPublicPage;
  try {
    page = await withVendorContext({ tenant_id: tenantId, source: "linkedin_refresh" }, () => readLinkedInPage(pageUrl, deps));
  } catch (err) {
    console.warn(`[linkedin-snapshots] public read failed: ${(err as { code?: string })?.code ?? "read_failed"}`);
    return finish({ ok: false, reason: "read_failed", message: "LinkedIn’s public posts could not be read. Showing the last saved numbers; try Refresh later." });
  }

  try {
    const sb = deps.client ?? tenantClient(asTenantId(tenantId));
    const captured_on = utcDay(now);
    if (page.posts.length) {
      const posts = await sb.from("social_post_metric_snapshots").upsert(
        page.posts.map((p) => ({
          tenant_id: tenantId,
          channel: LINKEDIN_CHANNEL,
          external_post_id: p.id,
          captured_on,
          posted_at: p.posted_at,
          text: p.text.slice(0, 4000),
          url: p.url,
          format: p.format,
          has_link: /https?:\/\//.test(p.text),
          metrics: { reactions: p.reactions, comments: p.comments, reposts: p.reposts ?? null },
        })),
        { onConflict: "tenant_id,channel,external_post_id,captured_on" },
      );
      if (posts.error) throw new Error(posts.error.message);
    }
    const acct = await sb.from("social_account_snapshots").upsert(
      {
        tenant_id: tenantId,
        channel: LINKEDIN_CHANNEL,
        captured_on,
        username: pageUrl.replace(/^https:\/\/www\.linkedin\.com\//, "").replace(/\/$/, ""),
        name: page.name,
        description: page.about,
        url: pageUrl,
        profile_image_url: page.photo_url,
        followers_count: page.followers,
        post_count: page.posts.length,
      },
      { onConflict: "tenant_id,channel,captured_on" },
    );
    if (acct.error) throw new Error(acct.error.message);
  } catch (err) {
    return finish({ ok: false, reason: "unavailable", message: "LinkedIn answered, but Zavi could not save the new numbers. Try Refresh later." });
  }
  return finish({ ok: true, posts: page.posts.length, used, cap: LINKEDIN_READS_PER_DAY });
}
