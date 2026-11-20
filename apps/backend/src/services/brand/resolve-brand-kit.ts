
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { assertSafeUrl } from "@/services/onboarding/enrichment/url-guard";
import { logEvent } from "@/services/logging/logEvent";
import { extractBrandColors, type BrandColorEvidence } from "./extract-brand-colors";

export type ResolvedBrandKit = {
  primary: string;
  accent: string | null;
  bg: string | null;
  text: string | null;
  source: "scrape" | "default" | "manual";
  source_url: string | null;
  evidence: BrandColorEvidence[];
};

export const DEFAULT_BRAND_KIT: ResolvedBrandKit = {
  primary: "#027bff",
  accent: null,
  bg: "#ffffff",
  text: "#191919",
  source: "default",
  source_url: null,
  evidence: [],
};

const PAGE_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 300 * 1024;
const MAX_CSS_BYTES = 250 * 1024;
const MAX_STYLESHEETS = 3;
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const UA = "zavi-brand-reader/1.0 (+https://www.zaviagent.com)";

async function fetchCapped(url: string, maxBytes: number): Promise<string | null> {
  const safe = await assertSafeUrl(url);
  const res = await fetch(safe.toString(), {
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    headers: { "user-agent": UA, accept: "text/html,text/css,*/*" },
    redirect: "follow",
  });
  if (!res.ok || !res.body) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.subarray(0, maxBytes).toString("utf8");
}

export function stylesheetUrls(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return out;
  }
  const re = /<link\b[^>]*>/gi;
  for (const tag of html.match(re) ?? []) {
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const u = new URL(href, base);
      if (u.origin !== base.origin) continue;
      out.push(u.toString());
    } catch {
    }
    if (out.length >= MAX_STYLESHEETS) break;
  }
  return out;
}

export function marketingUrlOf(productUrl: unknown): string | null {
  if (!productUrl) return null;
  if (typeof productUrl === "string") return productUrl.trim() || null;
  if (typeof productUrl === "object") {
    const v = (productUrl as Record<string, unknown>).marketing;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export async function scrapeBrandKit(pageUrl: string): Promise<ResolvedBrandKit> {
  const html = await fetchCapped(pageUrl, MAX_HTML_BYTES);
  if (!html) return { ...DEFAULT_BRAND_KIT, source_url: pageUrl };

  const css: string[] = [];
  for (const href of stylesheetUrls(html, pageUrl)) {
    try {
      const sheet = await fetchCapped(href, MAX_CSS_BYTES);
      if (sheet) css.push(sheet);
    } catch {
    }
  }

  const extracted = extractBrandColors({ html, css });
  if (!extracted.primary) {
    return { ...DEFAULT_BRAND_KIT, source_url: pageUrl };
  }
  return {
    primary: extracted.primary,
    accent: extracted.accent,
    bg: extracted.bg ?? DEFAULT_BRAND_KIT.bg,
    text: extracted.text ?? DEFAULT_BRAND_KIT.text,
    source: "scrape",
    source_url: pageUrl,
    evidence: extracted.evidence,
  };
}

function isFresh(refreshedAt: string | null | undefined): boolean {
  if (!refreshedAt) return false;
  const t = Date.parse(refreshedAt);
  return Number.isFinite(t) && Date.now() - t < STALE_AFTER_MS;
}

export async function resolveBrandKit(
  tenantId: string,
  opts?: { forceRefresh?: boolean },
): Promise<ResolvedBrandKit> {
  const tid = asTenantId(tenantId);
  const db = tenantClient(tid);

  let cached: Record<string, unknown> | null = null;
  try {
    const { data } = await db
      .from("tenant_brand_kits")
      .select("primary_hex,accent_hex,bg_hex,text_hex,source,source_url,evidence,refreshed_at")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    cached = (data as Record<string, unknown>) ?? null;
  } catch {
    cached = null;
  }

  const manual = cached?.source === "manual" && Boolean(cached?.primary_hex);

  if (
    !opts?.forceRefresh &&
    cached?.primary_hex &&
    (manual || isFresh(cached.refreshed_at as string | null))
  ) {
    return {
      primary: cached.primary_hex as string,
      accent: (cached.accent_hex as string) ?? null,
      bg: (cached.bg_hex as string) ?? null,
      text: (cached.text_hex as string) ?? null,
      source: (cached.source as ResolvedBrandKit["source"]) ?? "default",
      source_url: (cached.source_url as string) ?? null,
      evidence: Array.isArray(cached.evidence) ? (cached.evidence as BrandColorEvidence[]) : [],
    };
  }

  let productUrl: unknown = null;
  try {
    const { data } = await db.from("tenants").select("product_url").eq("id", tenantId).maybeSingle();
    productUrl = (data as Record<string, unknown> | null)?.product_url ?? null;
  } catch {
    productUrl = null;
  }

  const marketingUrl = marketingUrlOf(productUrl);
  let kit: ResolvedBrandKit = { ...DEFAULT_BRAND_KIT };
  if (marketingUrl) {
    try {
      kit = await scrapeBrandKit(marketingUrl);
    } catch (e) {
      void logEvent({
        level: "warn",
        source: "brand.resolve",
        code: "brand.scrape_failed",
        error: e,
        tenant_id: tenantId,
      });
      kit = { ...DEFAULT_BRAND_KIT, source_url: marketingUrl };
    }
  }

  try {
    await db.from("tenant_brand_kits").upsert(
      {
        tenant_id: tenantId,
        primary_hex: kit.primary,
        accent_hex: kit.accent,
        bg_hex: kit.bg,
        text_hex: kit.text,
        source: kit.source,
        source_url: kit.source_url,
        evidence: kit.evidence,
        refreshed_at: kit.source === "scrape" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id" },
    );
  } catch {
  }

  return kit;
}
