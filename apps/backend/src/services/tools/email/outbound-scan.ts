
import { githubTokenRegex } from "@/services/security/github-token-pattern";

export type OutboundScanResult = {
  blocked: boolean;
  reasons: string[];
};

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "private_key_block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "aws_access_key_id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "aws_secret_access_key", re: /\baws_secret_access_key\b/i },
  { name: "openai_key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "stripe_live_key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "github_token", re: githubTokenRegex() },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "vault_secret_key", re: /\b(?:slack\.bot_token|email\.api_key|stripe\.[a-z_]+key|github\.token)\b/i },
  { name: "service_role", re: /\b(?:SUPABASE_)?SERVICE_ROLE(?:_KEY)?\b|service_role/ },
  { name: "db_url", re: /\bpostgres(?:ql)?:\/\/[^\s]+:[^\s]+@/ },
];

export function scanOutboundEmail(
  body_text: string | null | undefined,
  body_html?: string | null,
): OutboundScanResult {
  const haystack = `${body_text ?? ""}\n${body_html ?? ""}`;
  const reasons: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(haystack)) reasons.push(name);
  }
  return { blocked: reasons.length > 0, reasons };
}
