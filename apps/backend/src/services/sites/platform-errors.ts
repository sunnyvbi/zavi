
export const POSTGREST_PRE_EXECUTION_CODES: ReadonlySet<string> = new Set(["PGRST000", "PGRST001", "PGRST002", "PGRST003"]);

const PG_TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["08000", "08001", "08003", "08004", "08006", "57P01", "57P02", "57P03", "53300"]);

const NODE_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

const DB_CONNECTION_TEXT =
  /timeout (?:acquiring|exceeded when trying to connect)|remaining connection slots are reserved|too many (?:clients|connections)|connection terminated unexpectedly|server closed the connection unexpectedly|the database system is (?:starting up|shutting down|in recovery mode)|terminating connection due to (?:administrator command|crash of another server process)|\b(?:08000|08001|08003|08004|08006|57P01|57P02|57P03|53300)\b/i;

const NPM_NETWORK_CODE_LINE = /^npm (?:ERR!|error) code (?:E5\d\d|E408|E429|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT)\s*$/im;

export function isNpmNetworkFailure(output: string): boolean {
  return NPM_NETWORK_CODE_LINE.test(output);
}

export function isDatabaseConnectionFailure(message: string): boolean {
  return DB_CONNECTION_TEXT.test(message);
}

const TRANSIENT_TEXT: ReadonlyArray<RegExp> = [
  /\bPGRST00[0-3]\b/,
  /could not query the database for the schema cache/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\b/,
  /socket hang up|\bfetch failed\b|\bnetwork error\b|network timeout/i,
  DB_CONNECTION_TEXT,
  /\b(?:HTTP|status(?: code)?|answered|returned)\s*:?\s*5\d\d\b/i,
  /\bfailed \((?:5\d\d|network)\)/i,
  /\b5\d\d (?:Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error)\b/i,
  /workspace went offline|\bsandbox\b[^\n]{0,80}\b(?:not found|offline|unavailable|timed out|expired|was killed)\b/i,
];

const MAX_CAUSE_DEPTH = 4;

function fields(e: unknown): { code?: unknown; status?: unknown; message: string } {
  if (e && typeof e === "object") {
    const o = e as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
    return { code: o.code, status: o.status ?? o.statusCode, message: typeof o.message === "string" ? o.message : String(e) };
  }
  return { message: String(e ?? "") };
}

export function isTransientPlatformError(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; cur != null && depth < MAX_CAUSE_DEPTH; depth++) {
    const { code, status, message } = fields(cur);
    if (typeof code === "string") {
      if (POSTGREST_PRE_EXECUTION_CODES.has(code) || PG_TRANSIENT_SQLSTATES.has(code) || NODE_NETWORK_CODES.has(code)) return true;
    }
    if (typeof status === "number" && status >= 500 && status <= 599) return true;
    if (TRANSIENT_TEXT.some((re) => re.test(message))) return true;
    cur = cur && typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}
