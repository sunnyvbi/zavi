import { sslModeOf } from "@/services/tools/operator-db/pg-ssl";

export type Transport = "verified_tls" | "unverified_tls" | "plaintext";

const MYSQL_TLS_PARAM = `ssl=${encodeURIComponent('{"rejectUnauthorized":false}')}`;
const MONGO_TLS_PARAMS = "tls=true&tlsAllowInvalidCertificates=true";

const FALSE = /^(false|0|no|off)$/i;
const TRUE = /^(true|1|yes|on)$/i;

function queryOf(uri: string): URLSearchParams {
  const q = uri.indexOf("?");
  if (q === -1) return new URLSearchParams();
  const hash = uri.indexOf("#", q);
  return new URLSearchParams(uri.slice(q + 1, hash === -1 ? undefined : hash));
}

function param(uri: string, ...names: string[]): string | null {
  const want = new Set(names.map((n) => n.toLowerCase()));
  for (const [k, v] of queryOf(uri)) if (want.has(k.toLowerCase())) return v;
  return null;
}

function appendParams(uri: string, params: string): string {
  const hash = uri.indexOf("#");
  const base = hash === -1 ? uri : uri.slice(0, hash);
  const tail = hash === -1 ? "" : uri.slice(hash);
  if (base.includes("?")) return `${base}${base.endsWith("?") || base.endsWith("&") ? "" : "&"}${params}${tail}`;
  const afterScheme = base.indexOf("://");
  const rest = afterScheme === -1 ? base : base.slice(afterScheme + 3);
  const needsSlash = afterScheme !== -1 && !rest.includes("/");
  return `${base}${needsSlash ? "/" : ""}?${params}${tail}`;
}

const isSrv = (uri: string) => /^mongodb\+srv:\/\//i.test(uri.trim());

export function hasExplicitTls(dialect: string, uri: string): boolean {
  if (dialect === "mysql") return param(uri, "ssl") !== null;
  if (dialect === "mongodb") return param(uri, "tls", "ssl") !== null;
  if (dialect === "postgres") return sslModeOf(uri) !== null;
  return true;
}

export function requireTlsByDefault(dialect: string, uri: string): string {
  if (hasExplicitTls(dialect, uri)) return uri;
  if (dialect === "mysql" && /^mysql:\/\//i.test(uri.trim())) return appendParams(uri, MYSQL_TLS_PARAM);
  if (dialect === "mongodb" && /^mongodb:\/\//i.test(uri.trim())) return appendParams(uri, MONGO_TLS_PARAMS);
  return uri;
}

export function transportOf(dialect: string, uri: string): Transport | null {
  if (dialect === "postgres") return sslModeOf(uri) === "disable" ? "plaintext" : "unverified_tls";
  if (dialect === "mysql") {
    const ssl = param(uri, "ssl");
    if (ssl === null || FALSE.test(ssl.trim())) return "plaintext";
    return /rejectUnauthorized"?\s*:\s*false/i.test(ssl) ? "unverified_tls" : "verified_tls";
  }
  if (dialect === "mongodb") {
    const tls = param(uri, "tls", "ssl");
    const on = tls === null ? isSrv(uri) : TRUE.test(tls.trim());
    if (!on) return "plaintext";
    const yes = (v: string | null) => v !== null && TRUE.test(v.trim());
    const no = (v: string | null) => v !== null && FALSE.test(v.trim());
    const insecure = yes(param(uri, "tlsAllowInvalidCertificates")) || yes(param(uri, "tlsInsecure")) || no(param(uri, "sslValidate"));
    return insecure ? "unverified_tls" : "verified_tls";
  }
  return null;
}

export const NO_TLS_MESSAGES: Record<"postgres" | "mysql" | "mongodb", string> = {
  postgres:
    "This database didn't offer an encrypted connection. Turn on TLS for it, or if it's on a trusted private network, add sslmode=disable to the connection string.",
  mysql:
    "This database didn't offer an encrypted connection. Turn on TLS for it, or if it's on a trusted private network, add ssl=false to the connection string.",
  mongodb:
    "Zavi couldn't open an encrypted connection to this database. Turn on TLS for it, or if it's on a trusted private network, add tls=false to the connection string.",
};

export function noTlsMessage(dialect: string, err: unknown, uri: string): string | null {
  const msg = String((err as { message?: unknown } | null)?.message ?? err ?? "");
  if (dialect === "postgres" && /does not support SSL/i.test(msg)) return NO_TLS_MESSAGES.postgres;
  if (dialect === "mysql" && /does not support secure connection|ssl is required|HANDSHAKE_NO_SSL_SUPPORT/i.test(msg)) return NO_TLS_MESSAGES.mysql;
  if (dialect === "mongodb" && transportOf("mongodb", uri) !== "plaintext" && !isSrv(uri)) {
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|auth(entication)? failed|bad auth/i.test(msg)) return null;
    if (/\bssl\b|\btls\b|wrong version number|EPROTO|ECONNRESET|connection .*closed|socket hang up/i.test(msg)) return NO_TLS_MESSAGES.mongodb;
  }
  return null;
}
