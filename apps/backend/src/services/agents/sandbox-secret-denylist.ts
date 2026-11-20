
const SECRET_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  ".aws",
  ".gcp",
  ".azure",
  ".kube",
  ".ssh",
  ".gnupg",
  ".gpg",
  ".docker",
  "secrets",
]);

const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.env$/i,
  /\.(key|pem|p12|pfx|keystore|jks|ppk|pkcs12)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(token|secret)$/i,
  /^(credentials|credentials\.json|auth\.json)$/i,
  /^secrets?\.(json|ya?ml|env|txt)$/i,
  /^\.(netrc|git-credentials|npmrc|pypirc|htpasswd|dockercfg|pgpass)$/i,
];

export function normalizePathForDenylist(rawPath: string): {
  segments: string[];
  basename: string;
} {
  let p = String(rawPath ?? "").trim();
  if (
    (p.startsWith('"') && p.endsWith('"')) ||
    (p.startsWith("'") && p.endsWith("'"))
  ) {
    p = p.slice(1, -1);
  }
  p = p.replace(/^file:\/\//i, "");
  p = p.replace(/\\/g, "/");
  const segments = p
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  const basename = segments.length > 0 ? segments[segments.length - 1] : "";
  return { segments, basename };
}

export function isSecretPath(rawPath: string): boolean {
  if (!rawPath || typeof rawPath !== "string") return false;
  const { segments, basename } = normalizePathForDenylist(rawPath);
  if (!basename) return false;
  for (const seg of segments.slice(0, -1)) {
    if (SECRET_DIR_SEGMENTS.has(seg.toLowerCase())) return true;
  }
  for (const re of SECRET_BASENAME_PATTERNS) {
    if (re.test(basename)) return true;
  }
  return false;
}

export function secretReadDenyReason(rawPath: string): string {
  return (
    `Blocked: \`${rawPath}\` looks like a secret/credentials file, so it can't be read into context. ` +
    `If you need a value from it, reference the env var name (e.g. process.env.X) without reading the raw secret.`
  );
}
