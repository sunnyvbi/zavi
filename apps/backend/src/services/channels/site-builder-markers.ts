export const SITE_BUILDERS = ["wordpress", "webflow", "shopify", "squarespace", "wix", "framer", "zavi", "unknown"] as const;
export type SiteBuilder = (typeof SITE_BUILDERS)[number];

const MARKERS: Array<[Exclude<SiteBuilder, "zavi" | "unknown">, RegExp]> = [
  ["wordpress", /\/wp-content\/|\/wp-includes\/|<meta[^>]+name=["']generator["'][^>]+content=["']WordPress/i],
  ["webflow", /data-wf-site=|<meta[^>]+content=["']Webflow["']|assets\.website-files\.com|cdn\.prod\.website-files\.com/i],
  ["shopify", /cdn\.shopify\.com|Shopify\.theme|window\.Shopify/i],
  ["squarespace", /static1?\.squarespace\.com|<!-- This is Squarespace\. -->|Static\.SQUARESPACE_CONTEXT/i],
  ["wix", /static\.wixstatic\.com|parastorage\.com|<meta[^>]+content=["']Wix\.com/i],
  ["framer", /framerusercontent\.com|<meta[^>]+content=["']Framer/i],
];

export function builderFromPage(html: string, headers: Record<string, string>): SiteBuilder {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (h["x-wix-request-id"] || /wix/i.test(h["server"] ?? "")) return "wix";
  if (h["x-shopid"] || h["x-shopify-stage"]) return "shopify";
  if (/squarespace/i.test(h["server"] ?? "")) return "squarespace";
  if (/framer/i.test(h["server"] ?? "")) return "framer";
  for (const [builder, re] of MARKERS) if (re.test(html)) return builder;
  return "unknown";
}

export function isSiteBuilder(v: unknown): v is SiteBuilder {
  return typeof v === "string" && (SITE_BUILDERS as readonly string[]).includes(v);
}
