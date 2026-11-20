
import { SECRET_NAME_RE, RESERVED_SECRET_PREFIX } from "@/services/provisioning/templates/vite-react-zavi/manifest";
import { githubTokenRegex } from "@/services/security/github-token-pattern";

export { SECRET_NAME_RE, RESERVED_SECRET_PREFIX };

export type SiteRef = { tenant_id: string; site_id: string };
export type Actor = { user_id: string };

export type SecretSummary = {
  name: string;
  updated_at: string;
};

export type SecretsView = {
  secrets: SecretSummary[];
  required: string[];
};

export type FunctionKind = "http" | "webhook" | "schedule";
export type RunStatus = "ok" | "error" | "timeout" | "running";

export type LogLine = { at: string; level: "info" | "warn" | "error"; message: string };

export type RunSummary = {
  id: string;
  started_at: string;
  duration_ms: number | null;
  status: RunStatus;
  http_status: number | null;
};

export type RunDetail = RunSummary & { log: LogLine[] };

export type FunctionSummary = {
  name: string;
  kind: FunctionKind;
  url: string | null;
  cron: string | null;
  enabled: boolean | null;
  last_run: RunSummary | null;
};

export interface SiteFunctionsService {
  listSecrets(site: SiteRef): Promise<SecretsView>;
  putSecret(site: SiteRef, name: string, value: string, actor: Actor): Promise<SecretSummary>;
  deleteSecret(site: SiteRef, name: string, actor: Actor): Promise<boolean>;
  listFunctions(site: SiteRef): Promise<FunctionSummary[]>;
  listRuns(site: SiteRef, fn: string, opts: { limit: number }): Promise<RunDetail[] | null>;
  setScheduleEnabled(site: SiteRef, name: string, enabled: boolean, actor: Actor): Promise<FunctionSummary | null>;
}

export class SiteFunctionsError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SiteFunctionsError";
  }
}

let registered: SiteFunctionsService | null = null;

export function setSiteFunctionsService(svc: SiteFunctionsService | null): void {
  registered = svc;
}

export function getSiteFunctionsService(): SiteFunctionsService | null {
  return registered;
}

export const MAX_SECRET_BYTES = 8192;
export const MIN_SECRET_CHARS = 8;

export function secretNameIssue(name: unknown): string | null {
  if (typeof name !== "string" || !SECRET_NAME_RE.test(name)) {
    return "Use capital letters, digits and underscores, starting with a letter (for example STRIPE_SECRET_KEY).";
  }
  if (name.startsWith(RESERVED_SECRET_PREFIX)) return `Names starting with ${RESERVED_SECRET_PREFIX} are reserved.`;
  return null;
}

export function secretValueIssue(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return "Paste the value.";
  if (value.trim().length < MIN_SECRET_CHARS) return `A secret is at least ${MIN_SECRET_CHARS} characters.`;
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) return "That value is too long.";
  if (value.includes("\u0000")) return "That value has characters we cannot store.";
  return null;
}

const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "stripe_secret_key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { kind: "stripe_webhook_secret", re: /\bwhsec_[A-Za-z0-9+/=]{24,}/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai_key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "github_token", re: githubTokenRegex("g") },
  { kind: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "sendgrid_key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: "private_key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { kind: "database_url", re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/]*:[^\s@/]+@[^\s]+/gi },
];

const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{20,}/g;

function isServiceRoleJwt(payload: string): boolean {
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: unknown };
    return claims?.role === "service_role";
  } catch {
    return false;
  }
}

export function findSecretLikeTokens(text: unknown): string[] {
  if (typeof text !== "string" || text.length < 16) return [];
  const kinds = new Set<string>();
  for (const { kind, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) kinds.add(kind);
  }
  JWT_RE.lastIndex = 0;
  for (const m of text.matchAll(JWT_RE)) {
    if (isServiceRoleJwt(m[1])) kinds.add("service_role_key");
  }
  return [...kinds];
}

export function redactSecretLike(text: string): string {
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[secret]");
  }
  JWT_RE.lastIndex = 0;
  out = out.replace(JWT_RE, (m, payload: string) => (isServiceRoleJwt(payload) ? "[secret]" : m));
  return out;
}

export const SECRET_IN_CHAT_MESSAGE =
  "That looks like a secret key, so it was not sent or saved. Add it in your site's Settings, under Secrets, where it stays private.";
