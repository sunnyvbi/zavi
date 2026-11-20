import psl from "psl";

export function eTldPlusOne(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  const secondLast = parts[parts.length - 2];
  const commonSld = new Set(["co", "com", "org", "gov", "ac", "net", "edu"]);
  if (parts.length >= 3 && commonSld.has(secondLast) && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join(".");
  }
  return last2;
}

const SHARED_HOST_SUFFIXES = [
  "onrender.com",
  "vercel.app",
  "netlify.app",
  "github.io",
  "pages.dev",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "fly.dev",
  "replit.app",
  "wixsite.com",
  "myshopify.com",
  "squarespace.com",
  "weebly.com",
  "wordpress.com",
  "blogspot.com",
  "notion.site",
  "framer.website",
  "framer.app",
  "carrd.co",
  "canva.site",
  "lovable.app",
  "substack.com",
  "bubbleapps.io",
  "webflow.io",
];

export function companyWebsiteHost(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  const sharedSuffix = SHARED_HOST_SUFFIXES.find((suffix) => host.endsWith(`.${suffix}`));
  if (!sharedSuffix) return psl.get(host) ?? host;
  const withoutWww = host.replace(/^www\./, "");
  return withoutWww === sharedSuffix ? host : withoutWww;
}
