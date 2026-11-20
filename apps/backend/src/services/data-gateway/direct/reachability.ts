
export const UNREACHABLE_MEMO_MS = 2 * 60 * 1000;

const MONGO_CONNECTION_CLASSES = new Set([
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoTopologyClosedError",
]);
const NET_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);
const PG_CONNECT_TIMEOUT = /^timeout expired$|connection terminated due to connection timeout/i;
const ANSWERED = /auth(entication)? failed|bad auth|password authentication failed|access denied/i;

export function isConnectionFailure(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: unknown; code?: unknown; message?: unknown };
  const msg = typeof err.message === "string" ? err.message : "";
  if (ANSWERED.test(msg)) return false;
  if (typeof err.name === "string" && MONGO_CONNECTION_CLASSES.has(err.name)) return true;
  if (typeof err.code === "string" && NET_CODES.has(err.code)) return true;
  return PG_CONNECT_TIMEOUT.test(msg);
}

const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Los_Angeles",
  timeZoneName: "short",
});

export function outageTimeLabel(iso: string | null | undefined): string | null {
  return iso && Number.isFinite(Date.parse(iso)) ? DAY.format(new Date(iso)) : null;
}

export function unreachableMessage(input: { lastReadAt: string | null; ips: string[] }): string {
  const last = outageTimeLabel(input.lastReadAt);
  const since = last ? ` Zavi last read it successfully on ${last}.` : "";
  const ips = input.ips.length ? ` Zavi connects from ${input.ips.join(", ")}.` : "";
  return (
    `Zavi could not connect to this workspace's database.${since} ` +
    "This is not a short blip: do not retry it in this run. " +
    "Tell the user Zavi can't reach their database, when it last read it, and to check that the database is running and that its network allowlist (IP access list) accepts Zavi's servers." +
    ips +
    " Never tell them to ask again in a few minutes. If they asked you to answer without their data, do that."
  );
}

type Memo = { until: number; generation: number; message: string };
const memo = new Map<string, Memo>();

export function rememberUnreachable(tenant_id: string, generation: number, message: string, now: number = Date.now()): void {
  memo.set(tenant_id, { until: now + UNREACHABLE_MEMO_MS, generation, message });
  if (memo.size > 10_000) memo.delete(memo.keys().next().value as string);
}

export function recallUnreachable(tenant_id: string, generation: number, now: number = Date.now()): { message: string } | null {
  const m = memo.get(tenant_id);
  if (!m) return null;
  if (m.generation !== generation || now >= m.until) {
    memo.delete(tenant_id);
    return null;
  }
  return { message: m.message };
}

export function forgetUnreachable(tenant_id: string): void {
  memo.delete(tenant_id);
}

export function __resetReachability(): void {
  memo.clear();
}
