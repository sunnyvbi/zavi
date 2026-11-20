
const SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isSafeName(name: string): boolean {
  return SAFE_NAME.test(name);
}

const PRIORITY = [
  "users",
  "user",
  "accounts",
  "account",
  "members",
  "member",
  "listings",
  "listing",
  "products",
  "product",
  "items",
  "item",
  "bookings",
  "booking",
  "orders",
  "order",
  "transactions",
  "transaction",
  "payments",
  "payment",
  "messages",
  "message",
  "reviews",
  "review",
  "customers",
  "customer",
  "subscriptions",
  "subscription",
  "invoices",
  "invoice",
  "events",
  "event",
  "sessions",
  "session",
];

function priorityRank(name: string): number {
  const lc = name.toLowerCase();
  for (let i = 0; i < PRIORITY.length; i++) {
    if (lc === PRIORITY[i] || lc.includes(PRIORITY[i])) return i;
  }
  return PRIORITY.length;
}

export function prioritizeAndCap(
  names: string[],
  cap: number,
  rowEstimates?: ReadonlyMap<string, number | null>,
): string[] {
  const safe = names.filter(isSafeName);
  const est = (n: string): number => {
    const v = rowEstimates?.get(n);
    return typeof v === "number" && Number.isFinite(v) ? v : -1;
  };
  const sorted = [...safe].sort((a, b) => {
    const ra = priorityRank(a);
    const rb = priorityRank(b);
    if (ra !== rb) return ra - rb;
    const ea = est(a);
    const eb = est(b);
    if (ea !== eb) return eb - ea;
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
  return sorted.slice(0, cap);
}

export const COLUMN_BATCH = 200;

export const DEFAULT_TABLE_CAP = 200;
export const MONGO_SAMPLE = 200;
