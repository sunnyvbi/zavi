
export const SOCIAL_CRAWLER_UA =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

const SOCIAL_OG_DOMAINS = [
  "linkedin.com",
  "x.com",
  "twitter.com",
  "instagram.com",
  "facebook.com",
  "fb.com",
  "crunchbase.com",
  "threads.net",
];

export function isSocialOgDomain(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return SOCIAL_OG_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0*39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (m, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return m;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return m;
      }
    });
}

function metaContent(
  html: string,
  attr: "property" | "name",
  key: string,
): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re1 = new RegExp(
    `<meta[^>]+${attr}=["']${esc}["'][^>]*\\scontent=["']([^"']*)["']`,
    "i",
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${esc}["']`,
    "i",
  );
  const m = html.match(re1) ?? html.match(re2);
  return m ? decodeEntities(m[1]).trim() : null;
}

export type SocialCard = {
  title: string | null;
  description: string | null;
  site: string | null;
};

export function extractSocialCard(rawHtml: string): SocialCard | null {
  const ogTitle = metaContent(rawHtml, "property", "og:title");
  const ogDesc = metaContent(rawHtml, "property", "og:description");
  const ogSite = metaContent(rawHtml, "property", "og:site_name");
  const metaDesc = metaContent(rawHtml, "name", "description");
  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleTag = titleMatch
    ? decodeEntities(titleMatch[1].replace(/\s+/g, " ")).trim()
    : null;

  const title = ogTitle || titleTag || null;
  const description = ogDesc || metaDesc || null;
  if (!title && !description) return null;
  return { title, description, site: ogSite || null };
}

export function renderSocialCardBody(card: SocialCard, host: string): string {
  const lines = [
    `[social preview card — public Open Graph share metadata for ${host}; the full page was anti-bot/login-walled and could NOT be read. This is the SAME data a link-unfurl shows. Use it to identify/disambiguate the subject, then VERIFY any fact via a normal search before asserting it.]`,
  ];
  if (card.title) lines.push(`Title: ${card.title}`);
  if (card.description) lines.push(`Summary: ${card.description}`);
  if (card.site) lines.push(`Site: ${card.site}`);
  return lines.join("\n");
}
