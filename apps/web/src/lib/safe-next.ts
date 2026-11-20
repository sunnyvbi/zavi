
export function safeNext(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  if (raw[0] !== "/") return fallback;
  if (raw[1] === "/" || raw[1] === "\\") return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(raw)) return fallback;
  return raw;
}

export function plainNext(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (safeNext(raw, "") !== raw) return null;
  const path = raw.split(/[?#]/)[0];
  if (path.includes("%") || path.includes("\\") || path.includes("//")) return null;
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  return raw;
}

const ONBOARDING_SURVIVING_PATHS = new Set(["/oauth/consent", "/connectors/shopify/install"]);

export function oauthConsentNext(raw: string | null | undefined): string | null {
  const plain = plainNext(raw);
  return plain !== null && ONBOARDING_SURVIVING_PATHS.has(plain.split(/[?#]/)[0]) ? plain : null;
}

export function isCreatorPath(plain: string | null): boolean {
  if (!plain) return false;
  const path = plain.split(/[?#]/)[0];
  return (
    path === "/creator" ||
    path.startsWith("/creator/") ||
    path === "/creators/apply" ||
    path.startsWith("/creators/apply/")
  );
}
