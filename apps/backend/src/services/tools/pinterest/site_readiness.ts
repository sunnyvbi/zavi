
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { safeFetchText } from "@/services/onboarding/enrichment/discover";
import { resolveTenantSite } from "@/services/tools/growth/seo/run";
import { extractSameSiteLinks } from "@/services/tools/growth/seo/fetch";

const MAX_BYTES = 2 * 1024 * 1024;
const WALL_MS = 20_000;

const inputSchema = z.object({
  urls: z.array(z.string().min(1).max(2048)).max(3).optional(),
});

type MetaMap = Map<string, string>;

export function metaTags(html: string): MetaMap {
  const out: MetaMap = new Map();
  const re = /<meta\b[^>]*>/gi;
  for (const tag of html.match(re) ?? []) {
    const key = attr(tag, "property") ?? attr(tag, "name") ?? attr(tag, "itemprop");
    const content = attr(tag, "content");
    if (key && content !== null && !out.has(key.toLowerCase())) out.set(key.toLowerCase(), content);
  }
  return out;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return decodeEntities((m[2] ?? m[3] ?? m[4] ?? "").trim());
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

type LdProduct = { price: string | null; currency: string | null; availability: string | null };

export function jsonLdProduct(html: string): LdProduct | null {
  const blocks = html.match(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const body = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const found = findProduct(parsed, 0);
    if (found) return found;
  }
  return null;
}

function findProduct(node: unknown, depth: number): LdProduct | null {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findProduct(n, depth + 1);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const o = node as Record<string, unknown>;
  const type = o["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("ProductGroup")) {
    const variant = Array.isArray(o.hasVariant) ? o.hasVariant[0] : o.hasVariant;
    const fromVariant = variant ? findProduct({ "@type": "Product", ...(variant as object) }, depth + 1) : null;
    return fromVariant ?? { price: null, currency: null, availability: null };
  }
  if (types.includes("Product")) {
    const offersRaw = o.offers;
    const offer = (Array.isArray(offersRaw) ? offersRaw[0] : offersRaw) as Record<string, unknown> | undefined;
    const price = offer?.price ?? offer?.lowPrice ?? null;
    return {
      price: price === null || price === undefined ? null : String(price),
      currency: typeof offer?.priceCurrency === "string" ? offer.priceCurrency : null,
      availability: typeof offer?.availability === "string" ? offer.availability.replace(/^https?:\/\/schema\.org\//, "") : null,
    };
  }
  if (o["@graph"]) return findProduct(o["@graph"], depth + 1);
  return null;
}

const NOT_ACCOUNTS = new Set(["pin", "pins", "search", "ideas", "business", "today", "_", "about", "login", "settings", "resource", "v3", "explore"]);

export function pinterestProfileLinks(html: string): string[] {
  const out = new Set<string>();
  const re = /https?:\/\/(?:[a-z]{2,3}\.)?pinterest\.[a-z.]{2,8}\/([A-Za-z0-9_]{3,30})(?=[\/"'?#\s<])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!NOT_ACCOUNTS.has(m[1].toLowerCase())) out.add(m[1]);
  }
  return [...out].slice(0, 5);
}

function sameSiteLinks(html: string, url: string): string[] {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return [];
  }
  const links = extractSameSiteLinks(html, url, host);
  const product = links.filter((p) => /\/(products?|collections?|shop|store|item)s?\//i.test(p));
  const rest = links.filter((p) => !product.includes(p));
  return [...product, ...rest].slice(0, 12);
}

function seen(found: boolean, truncated: boolean): boolean | null {
  return found ? true : truncated ? null : false;
}

const MISSING_IMPACT: Record<string, string> = {
  "og:image": "A pin saved from this page shows no image or the wrong one.",
  "og:title": "A pin saved from this page shows no title, or one Pinterest guessed.",
  "og:description": "A pin saved from this page shows no description.",
  price: "A Rich Pin of this product shows no price.",
  currency: "A Rich Pin cannot show the price without its currency.",
  availability: "A Rich Pin cannot say whether this product is in stock.",
  nopin: "Nobody can save this page to Pinterest.",
};

export function checkPage(url: string, html: string, truncated: boolean) {
  const meta = metaTags(html);
  const og = {
    title: meta.get("og:title") ?? null,
    description: meta.get("og:description") ?? null,
    image: meta.get("og:image") ?? null,
    type: meta.get("og:type") ?? null,
  };
  const ld = jsonLdProduct(html);
  const ogPrice = meta.get("product:price:amount") ?? meta.get("og:price:amount") ?? null;
  const ogCurrency = meta.get("product:price:currency") ?? meta.get("og:price:currency") ?? null;
  const ogAvail = meta.get("product:availability") ?? meta.get("og:availability") ?? null;
  const productPath = /\/products?\//i.test(new URL(url).pathname);
  const isProduct = /product/i.test(og.type ?? "") || !!ld || !!ogPrice || productPath;
  const product = isProduct
    ? {
        source: ld && (ld.price || ld.currency) ? ("json_ld" as const) : ogPrice ? ("og_meta" as const) : ld ? ("json_ld" as const) : ("og_type_only" as const),
        price: ld?.price ?? ogPrice,
        currency: ld?.currency ?? ogCurrency,
        availability: ld?.availability ?? ogAvail,
      }
    : null;

  const missing: string[] = [];
  if (!og.title) missing.push("og:title");
  if (!og.description) missing.push("og:description");
  if (!og.image) missing.push("og:image");
  if (product) {
    if (!product.price) missing.push("price (product:price:amount or schema.org Offer.price)");
    if (!product.currency) missing.push("currency (product:price:currency or Offer.priceCurrency)");
    if (!product.availability) missing.push("availability (recommended)");
  }

  const pinMeta = (meta.get("pinterest") ?? "").toLowerCase();
  const blockers: string[] = [];
  const nopin = pinMeta.includes("nopin");
  if (nopin) blockers.push('<meta name="pinterest" content="nopin"> blocks saving this whole page');
  if (/data-pin-nopin/i.test(html)) blockers.push("data-pin-nopin on at least one image blocks saving it");
  const impact = truncated
    ? []
    : [
        ...(nopin ? [MISSING_IMPACT.nopin] : []),
        ...missing.map((m) => MISSING_IMPACT[m.split(" ")[0]]).filter((x): x is string => !!x),
      ];

  return {
    url,
    fetched: true as const,
    truncated,
    kind: product ? ("product" as const) : ("page" as const),
    og,
    product,
    rich_pin: {
      ready: truncated && missing.length > 0 ? null : missing.filter((m) => !m.endsWith("(recommended)")).length === 0,
      missing: truncated ? [] : missing,
    },
    save_blockers: blockers,
    impact,
    domain_verify_tag: seen(meta.has("p:domain_verify"), truncated),
    pinterest_tag: seen(/s\.pinimg\.com\/ct\/core\.js|pintrk\s*\(/i.test(html), truncated),
    save_button: seen(/assets\.pinterest\.com\/js\/pinit|data-pin-do\s*=/i.test(html), truncated),
    pinterest_profile_links: pinterestProfileLinks(html),
    shopify: /cdn\.shopify\.com|Shopify\.theme/i.test(html),
    same_site_links: sameSiteLinks(html, url),
  };
}

export const pinterestSiteReadinessTool: ToolSpec = {
  name: "pinterest_site_readiness",
  effect: "read",
  description:
    "Check the company's OWN site for Pinterest from its raw HTML (other domains are refused). Pass up to 3 `urls` (paths or full URLs on their domain), including at least one PRODUCT page when they sell products; defaults to the homepage. Per page returns: Rich Pin readiness (og:title/description/image, and on product pages price, currency, availability from og meta or schema.org Product/Offer) with the exact missing fields, save blockers (nopin meta, data-pin-nopin), whether the Pinterest tag, the domain-claim meta tag (p:domain_verify) and a Save button are present, the pinterest.com profile links the page carries (the best evidence of WHICH account is theirs), whether it is a Shopify store, and up to 12 real same-site paths it links to, product pages first (check one of THOSE, never a guessed URL). A missing domain-claim tag does NOT prove the domain is unclaimed (DNS and file claims are invisible here).",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { urls } = inputSchema.parse(input);
    const site = await resolveTenantSite(ctx.tenant_id);
    if (!site) {
      throw new ExpectedToolError(
        "tool_no_data",
        "This company has no website on file, so there is no site to check. Say so; do not guess a domain.",
      );
    }
    let siteUrl: URL;
    try {
      siteUrl = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
    } catch {
      throw new ExpectedToolError("tool_no_data", `The website on file ("${site}") is not a URL.`);
    }
    const apex = siteUrl.hostname.toLowerCase().replace(/^www\./, "");
    const ownHost = (h: string) => {
      const x = h.toLowerCase();
      return x === apex || x === `www.${apex}`;
    };

    const targets: string[] = [];
    for (const raw of urls && urls.length ? urls : ["/"]) {
      let u: URL;
      try {
        u = new URL(raw, `https://${siteUrl.hostname}`);
      } catch {
        throw new ExpectedToolError("tool_input_invalid", `"${raw}" is not a URL or path.`);
      }
      if (!ownHost(u.hostname)) {
        throw new ExpectedToolError(
          "tool_input_invalid",
          `${u.hostname} is not the company's site (${siteUrl.hostname}). This tool only checks their own pages.`,
        );
      }
      u.protocol = "https:";
      targets.push(u.toString());
    }

    const deadline = Date.now() + WALL_MS;
    const pages = await Promise.all(
      targets.map(async (url) => {
        const html = await safeFetchText(url, apex, deadline, MAX_BYTES);
        if (html === null) {
          return {
            url,
            fetched: false as const,
            note: "Could not fetch this page (blocked, redirected off-site, not found or timed out). Its Pinterest setup is UNVERIFIED, not missing.",
          };
        }
        return checkPage(url, html, Buffer.byteLength(html, "utf8") >= MAX_BYTES - 64 * 1024);
      }),
    );

    return {
      source: "company_site_raw_html" as const,
      fetched_at: new Date().toISOString(),
      site: siteUrl.hostname,
      pages,
      cannot_see:
        "Domain claims made by DNS record or HTML file, whether a Pinterest catalog is connected, and whether Pinterest has already rendered their Rich Pins. A page that failed to fetch is unverified, never 'missing'.",
    };
  },
};
