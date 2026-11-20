import { createHash, randomBytes } from "node:crypto";
import { CONNECTOR_TOKEN_PATTERN, PAIR_CODE_PATTERN } from "@zavi/shared/db-guard";

export const CONNECTOR_TOKEN_PREFIX = "zconn_";
export const PAIR_CODE_PREFIX = "zpair_";
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIR_CODE_CHARS = 26;

export function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateConnectorToken(): string {
  return CONNECTOR_TOKEN_PREFIX + randomBytes(32).toString("hex");
}

export function generatePairCode(rand: (n: number) => Buffer = randomBytes): string {
  const bytes = rand(PAIR_CODE_CHARS);
  let body = "";
  for (let i = 0; i < PAIR_CODE_CHARS; i++) body += CROCKFORD[bytes[i]! & 31];
  return PAIR_CODE_PREFIX + body;
}

export function normalizePairCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim();
  if (t.length > 64 || t.slice(0, PAIR_CODE_PREFIX.length).toLowerCase() !== PAIR_CODE_PREFIX) return null;
  const body = t
    .slice(PAIR_CODE_PREFIX.length)
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  const code = PAIR_CODE_PREFIX + body;
  return PAIR_CODE_PATTERN.test(code) ? code : null;
}

export function isConnectorToken(raw: unknown): raw is string {
  return typeof raw === "string" && CONNECTOR_TOKEN_PATTERN.test(raw);
}

export function dockerCommand(code: string): string {
  return [
    "docker run -d --name zavi-connector --restart always \\",
    `  -e ZAVI_PAIR=${code} \\`,
    "  -p 127.0.0.1:7801:7801 \\",
    "  -v zavi-connector:/data \\",
    "  ghcr.io/rravi149/zavi-connector:1.0.1",
  ].join("\n");
}

export const LOCAL_REMOVAL_COMMAND = "docker rm -f zavi-connector && docker volume rm zavi-connector";
