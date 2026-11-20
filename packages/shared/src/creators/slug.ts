
export const CREATOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$/;

export const CREATOR_SLUG_MIN_LENGTH = 3;
export const CREATOR_SLUG_MAX_LENGTH = 40;

export const RESERVED_CREATOR_SLUGS: ReadonlySet<string> = new Set<string>([
  "about",
  "account",
  "agents",
  "api",
  "applications",
  "approvals",
  "artifacts",
  "auth",
  "autopilot",
  "c",
  "careers",
  "channels",
  "connectors",
  "cookie-policy",
  "extension",
  "humans",
  "inbox",
  "integrations",
  "invite",
  "launch-video",
  "legal",
  "library",
  "login",
  "loginas",
  "map",
  "memory",
  "oauth",
  "pages",
  "playbooks",
  "preview-howzavi",
  "pricing",
  "privacy",
  "reset-password",
  "roles",
  "security",
  "staff",
  "start",
  "starters",
  "startups",
  "talk-to-team",
  "terms",
  "tools",
  "upcar",
  "workspace",
  "robots",
  "robots.txt",
  "sitemap",
  "sitemap.xml",
  "icon",
  "favicon",
  "favicon.ico",
  "opengraph-image",
  "not-found",
  "admin",
  "creator",
  "why",
  "fleet",
  "_next",
  "static",
  "public",
  "assets",
  "cdn",
  "www",
  "billing",
  "blog",
  "brief",
  "briefs",
  "checkout",
  "contact",
  "creators",
  "dashboard",
  "docs",
  "earnings",
  "explore",
  "help",
  "home",
  "jobs",
  "me",
  "new",
  "onboarding",
  "orders",
  "partners",
  "press",
  "search",
  "settings",
  "signin",
  "signout",
  "signup",
  "status",
  "storefront",
  "support",
  "team",
  "teams",
  "zavi",
  "zaviagent",
  "book",
  "booking",
  "bookings",
  "pay",
  "payments",
  "r-hg5x3k",
  "stripe",
  "webhooks",
]);

export type SlugRejection =
  | "slug_too_short"
  | "slug_too_long"
  | "slug_invalid"
  | "slug_reserved";

export type SlugCheck =
  | { ok: true; slug: string }
  | { ok: false; code: SlugRejection; message: string };

export function normalizeCreatorSlug(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^[/@]+/, "")
    .trim()
    .toLowerCase();
}

export function checkCreatorSlug(raw: string): SlugCheck {
  const slug = normalizeCreatorSlug(raw);
  if (slug.length < CREATOR_SLUG_MIN_LENGTH) {
    return {
      ok: false,
      code: "slug_too_short",
      message: `Use at least ${CREATOR_SLUG_MIN_LENGTH} characters.`,
    };
  }
  if (slug.length > CREATOR_SLUG_MAX_LENGTH) {
    return {
      ok: false,
      code: "slug_too_long",
      message: `Use at most ${CREATOR_SLUG_MAX_LENGTH} characters.`,
    };
  }
  if (!CREATOR_SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      code: "slug_invalid",
      message:
        "Use lowercase letters, numbers, hyphens and underscores. It has to start and end with a letter or number.",
    };
  }
  if (RESERVED_CREATOR_SLUGS.has(slug)) {
    return {
      ok: false,
      code: "slug_reserved",
      message: "That name is part of Zavi itself, so it cannot be a creator link. Try another.",
    };
  }
  return { ok: true, slug };
}

export function creatorSlugBase(displayName: string): string {
  const base = String(displayName ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 34)
    .replace(/-+$/g, "");
  if (base.length < CREATOR_SLUG_MIN_LENGTH || RESERVED_CREATOR_SLUGS.has(base)) return "new-creator";
  return base;
}

export function creatorSlugCandidate(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`;
}
