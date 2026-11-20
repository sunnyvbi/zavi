
export const SOCIAL_PLATFORMS = ["tiktok", "instagram", "youtube", "x", "linkedin"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export function isSocialPlatform(v: unknown): v is SocialPlatform {
  return typeof v === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(v);
}

type PlatformRule = {
  hosts: readonly string[];
  handle: RegExp;
  url: (handle: string) => string;
  fromPath: (segments: string[]) => string | null;
};

const at = (s: string | undefined) => (s && s.startsWith("@") ? s.slice(1) : null);

const RULES: Record<SocialPlatform, PlatformRule> = {
  tiktok: {
    hosts: ["tiktok.com", "m.tiktok.com"],
    handle: /^[A-Za-z0-9_.]{2,24}$/,
    url: (h) => `https://www.tiktok.com/@${h}`,
    fromPath: (s) => at(s[0]),
  },
  instagram: {
    hosts: ["instagram.com", "m.instagram.com"],
    handle: /^[A-Za-z0-9_.]{1,30}$/,
    url: (h) => `https://www.instagram.com/${h}`,
    fromPath: (s) => (s[0] && !["p", "reel", "reels", "stories", "explore"].includes(s[0]) ? s[0] : null),
  },
  youtube: {
    hosts: ["youtube.com", "m.youtube.com"],
    handle: /^[A-Za-z0-9_.-]{3,30}$/,
    url: (h) => `https://www.youtube.com/@${h}`,
    fromPath: (s) => at(s[0]) ?? (s[0] === "c" || s[0] === "user" ? (s[1] ?? null) : null),
  },
  x: {
    hosts: ["x.com", "twitter.com", "mobile.twitter.com"],
    handle: /^[A-Za-z0-9_]{1,15}$/,
    url: (h) => `https://x.com/${h}`,
    fromPath: (s) => s[0] ?? null,
  },
  linkedin: {
    hosts: ["linkedin.com"],
    handle: /^[A-Za-z0-9-]{3,100}$/,
    url: (h) => `https://www.linkedin.com/in/${h}`,
    fromPath: (s) => (s[0] === "in" ? (s[1] ?? null) : null),
  },
};

export type ParsedSocial = { platform: SocialPlatform; handle: string; url: string };

export type SocialParse =
  | { ok: true; value: ParsedSocial }
  | { ok: false; message: string };

export const CREATOR_FOLLOWERS_MAX = 1_000_000_000;

const KNOWN_HOSTS = new Set(Object.values(RULES).flatMap((r) => r.hosts));

function looksLikeUrl(s: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(s) ||
    /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(s) ||
    KNOWN_HOSTS.has(s.toLowerCase().replace(/^www\./, "").split(/[?#]/)[0])
  );
}

export function parseSocial(platform: string, handleOrUrl: string): SocialParse {
  if (!isSocialPlatform(platform)) {
    return { ok: false, message: "Pick TikTok, Instagram, YouTube, X or LinkedIn." };
  }
  const rule = RULES[platform];
  const raw = String(handleOrUrl ?? "").trim();
  if (raw === "" || raw.length > 300) {
    return { ok: false, message: "Type your handle or paste the link to your profile." };
  }

  let candidate: string | null;
  if (looksLikeUrl(raw)) {
    let u: URL;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return { ok: false, message: "That link does not look right." };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { ok: false, message: "That link does not look right." };
    }
    if (u.username || u.password || u.port) {
      return { ok: false, message: "That link does not look right." };
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!rule.hosts.includes(host)) {
      return { ok: false, message: `That is not a ${socialPlatformLabel(platform)} link.` };
    }
    const segments = u.pathname.split("/").filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    candidate = rule.fromPath(segments);
  } else {
    candidate = raw.replace(/^@+/, "");
  }

  if (!candidate || !rule.handle.test(candidate)) {
    return { ok: false, message: `That does not look like a ${socialPlatformLabel(platform)} handle.` };
  }
  return { ok: true, value: { platform, handle: candidate, url: rule.url(candidate) } };
}

export function socialUrl(platform: string, handle: string): string | null {
  const r = parseSocial(platform, handle);
  return r.ok ? r.value.url : null;
}

export function socialPlatformLabel(platform: SocialPlatform): string {
  return { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", x: "X", linkedin: "LinkedIn" }[
    platform
  ];
}
