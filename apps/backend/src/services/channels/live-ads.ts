
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";
import { getAdAccountCurrency, metaDateRange } from "@/services/tools/meta-ads/_client";
import { readMetaAds } from "@/services/tools/meta-ads/list_ads";
import { labChannelSlug } from "@/services/agents/variants-lab/lab-channel-slug";
import { switchedChannelForRun } from "./channel-actions";

export type LiveAd = {
  ad_id: string;
  ad_name: string;
  adset_id: string;
  campaign_id: string;
  status: string | null;
  spend: number;
  ctr_percent: number;
  purchases: number;
  roas: number | null;
  primary_text: string | null;
  headline: string | null;
  description: string | null;
  call_to_action: string | null;
  destination_url: string | null;
  url_tags: string | null;
  is_dynamic_creative: boolean;
  variant_count: number;
};

export type LiveAds = {
  read_by: "system";
  read_at: string;
  window: { since: string; until: string };
  currency: string | null;
  partial: boolean;
  ads: LiveAd[];
  total_ads: number;
  untagged_live_ads: number | null;
  note: string;
};

export const LIVE_ADS_MAX = 12;
const COPY_MAX = 500;
export const LIVE_ADS_TIMEOUT_MS = 20_000;

const NOTE =
  "Read by the system when this run started: the ads running in this account now, with their copy, destination " +
  "and last-7-days numbers. Model any ad copy you write on these and name which ad each variant follows. " +
  "`destination_url` is the page a click lands on. Money is in `currency`, the ad account's own, never assume " +
  "dollars. Where `is_dynamic_creative` is true Meta rotates `variant_count` texts and links inside that ad: the " +
  "one shown is a sample and the ad's numbers cover all of them, so they do not prove that wording won. If " +
  "`partial` is true the account has more ads than were read. Call the ad tools for anything not here.";

const MARKUP = /[<>`\u2039\u203a\u2329\u232a\u27e8\u27e9\u3008\u3009]/g;
const cut = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.normalize("NFKC").replace(MARKUP, " ").replace(/\s+/g, " ").trim();
  return t ? (t.length > COPY_MAX ? `${t.slice(0, COPY_MAX)}…` : t) : null;
};
const token = (v: unknown): string => (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

type AdRow = Record<string, unknown> & { creative?: Record<string, unknown> | null };

export function projectLiveAds(
  rows: ReadonlyArray<AdRow>,
  window: { since: string; until: string },
  nowIso: string,
  account: { currency?: string | null; partial?: boolean; untagged_live_ads?: number | null } = {},
): LiveAds {
  const running = rows.filter((r) => r.effective_status === "ACTIVE");
  const pool = running.length > 0 ? running : rows;
  const ads = [...pool]
    .sort((a, b) => num(b.spend_usd) - num(a.spend_usd))
    .slice(0, LIVE_ADS_MAX)
    .map((r): LiveAd => {
      const c = r.creative ?? null;
      return {
        ad_id: token(r.ad_id),
        ad_name: cut(r.ad_name) ?? "",
        adset_id: token(r.adset_id),
        campaign_id: token(r.campaign_id),
        status: token(r.effective_status) || null,
        spend: num(r.spend_usd),
        ctr_percent: num(r.ctr_percent),
        purchases: num(r.purchases),
        roas: typeof r.roas === "number" ? r.roas : null,
        primary_text: cut(c?.body),
        headline: cut(c?.title),
        description: cut(c?.description),
        call_to_action: cut(c?.call_to_action),
        destination_url: cut(c?.destination_url),
        url_tags: cut(c?.url_tags),
        is_dynamic_creative: c?.is_dynamic_creative === true,
        variant_count: typeof c?.variant_count === "number" ? c.variant_count : 1,
      };
    });
  return {
    read_by: "system",
    read_at: nowIso,
    window,
    currency: token(account.currency) || null,
    partial: account.partial === true,
    ads,
    total_ads: rows.length,
    untagged_live_ads: account.untagged_live_ads !== undefined ? account.untagged_live_ads : running.filter((r) => r.url_tagged === false).length,
    note: NOTE,
  };
}

async function readMetaLiveAds(tenantId: string, now: Date): Promise<LiveAds | null> {
  const window = metaDateRange("last_7d", now);
  const [out, currency] = await Promise.all([
    readMetaAds(tenantId, { since: window.since, until: window.until, include_creative: true }),
    getAdAccountCurrency(tenantId).catch(() => null),
  ]);
  const rows = (out.ads ?? []) as AdRow[];
  const untagged = (out as { untagged_live_ads?: { count: number; of_live: number; complete: boolean } | null }).untagged_live_ads;
  if (rows.length === 0 && !(untagged && untagged.of_live > 0)) return null;
  const partial = (out.totals as { complete?: boolean } | undefined)?.complete === false;
  return projectLiveAds(rows, window, now.toISOString(), { currency, partial, untagged_live_ads: untagged?.complete ? untagged.count : null });
}

type Reader = (tenantId: string, now: Date) => Promise<LiveAds | null>;

const READERS: Readonly<Record<string, Reader>> = {
  meta_ads: readMetaLiveAds,
};

export function hasLiveAdsReader(channelSlug: string): boolean {
  return Object.prototype.hasOwnProperty.call(READERS, channelSlug);
}

export async function loadLiveAds(
  tenantId: string,
  channelSlug: string,
  deps: { readers?: Readonly<Record<string, Reader>>; now?: () => Date; timeoutMs?: number } = {},
): Promise<LiveAds | null> {
  const readers = deps.readers ?? READERS;
  const reader = Object.prototype.hasOwnProperty.call(readers, channelSlug) ? readers[channelSlug] : undefined;
  if (!reader) return null;
  const key = `${tenantId}|${channelSlug}`;
  const now = (deps.now ?? (() => new Date()))();
  const hit = recent.get(key);
  if (hit && now.getTime() - hit.at < SHARE_MS) return hit.read;
  const read = readOnce(reader, tenantId, channelSlug, now, deps.timeoutMs ?? LIVE_ADS_TIMEOUT_MS);
  recent.set(key, { at: now.getTime(), read });
  void read.then((r) => {
    if (!r && recent.get(key)?.read === read) recent.delete(key);
  });
  return read;
}

const SHARE_MS = 60_000;
const recent = new Map<string, { at: number; read: Promise<LiveAds | null> }>();

async function readOnce(
  reader: Reader,
  tenantId: string,
  channelSlug: string,
  now: Date,
  timeoutMs: number,
): Promise<LiveAds | null> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader(tenantId, now),
      new Promise<null>((resolve) => {
        t = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch (err) {
    console.warn(`[live-ads] ${channelSlug} read failed; run continues without live_ads: ${(err as Error)?.message ?? err}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function loadLiveAdsForRun(
  ctx: { tenant_id: string; runId: string; variants_lab?: boolean; draft_mode?: boolean },
  payload: unknown,
  deps: { stampedSlug?: typeof switchedChannelForRun; load?: typeof loadLiveAds; timeoutMs?: number } = {},
): Promise<LiveAds | null> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    const hinted = payload && typeof payload === "object" ? (payload as { channel_slug?: unknown }).channel_slug : null;
    if (typeof hinted !== "string" || !hasLiveAdsReader(hinted)) return null;
    const work = (async () => {
      const slug =
        (await (deps.stampedSlug ?? switchedChannelForRun)(ctx.tenant_id, ctx.runId)) ?? labChannelSlug(ctx, payload);
      return slug ? (deps.load ?? loadLiveAds)(ctx.tenant_id, slug) : null;
    })();
    work.catch(() => undefined);
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        t = setTimeout(() => resolve(null), deps.timeoutMs ?? LIVE_ADS_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.warn(`[live-ads] unavailable for run=${ctx.runId}: ${(err as Error)?.message ?? err}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function renderLiveAdsBlock(live: LiveAds): string {
  const { note, ads, ...facts } = live;
  return [
    "## Live ads in this account",
    "",
    note,
    "",
    `Facts: ${JSON.stringify(facts)}`,
    "",
    renderUntrustedBlock("live_ads", JSON.stringify(ads, null, 1)),
  ].join("\n");
}
