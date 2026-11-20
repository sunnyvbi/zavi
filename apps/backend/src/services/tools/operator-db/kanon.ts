
export const REASON_CATEGORIES = [
  "verification",
  "payment",
  "no_show",
  "policy",
  "quality",
  "availability",
  "other",
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

const CATEGORY_PATTERNS: { category: Exclude<ReasonCategory, "other">; re: RegExp }[] = [
  { category: "verification", re: /(verif|kyc|identit|licen[sc]e|document|unverified|id[_ -]?check)/i },
  { category: "payment", re: /(payment|declin|card|charge|billing|insufficient|refund|chargeback|fraud)/i },
  { category: "no_show", re: /(no[_ -]?show|didn'?t show|did not show|absent|never (arrived|showed))/i },
  { category: "availability", re: /(unavailab|not available|out of stock|sold ?out|double[_ -]?book|overbook|no (cars?|inventory|supply))/i },
  { category: "policy", re: /(policy|violat|terms|banned|suspend|abuse|prohibited)/i },
  { category: "quality", re: /(quality|damage|dirty|condition|broken|defect|complaint|dissatisf)/i },
];

export const DEFAULT_MIN_COUNT = 5;

export function classifyReason(raw: unknown): ReasonCategory {
  if (typeof raw !== "string" || raw.trim().length === 0) return "other";
  for (const { category, re } of CATEGORY_PATTERNS) {
    if (re.test(raw)) return category;
  }
  return "other";
}

export type ReasonBucket = { category: ReasonCategory; count: number };

export type ReasonValueCount = { value: unknown; count: number };

export function bucketReasons(
  rawValues: unknown[],
  minCount: number = DEFAULT_MIN_COUNT,
): ReasonBucket[] {
  return bucketReasonCounts(
    rawValues.map((value) => ({ value, count: 1 })),
    minCount,
  );
}

export function bucketReasonCounts(
  pairs: ReasonValueCount[],
  minCount: number = DEFAULT_MIN_COUNT,
): ReasonBucket[] {
  const counts = new Map<ReasonCategory, number>();
  for (const { value, count } of pairs) {
    const cat = classifyReason(value);
    counts.set(cat, (counts.get(cat) ?? 0) + (count > 0 ? count : 0));
  }

  let otherSpill = counts.get("other") ?? 0;
  const kept = new Map<ReasonCategory, number>();
  for (const cat of REASON_CATEGORIES) {
    if (cat === "other") continue;
    const c = counts.get(cat) ?? 0;
    if (c === 0) continue;
    if (c < minCount) {
      otherSpill += c;
    } else {
      kept.set(cat, c);
    }
  }

  const out: ReasonBucket[] = [];
  for (const cat of REASON_CATEGORIES) {
    if (cat === "other") continue;
    const c = kept.get(cat);
    if (c) out.push({ category: cat, count: c });
  }
  if (otherSpill > 0) out.push({ category: "other", count: otherSpill });
  return out;
}

export function categoryShare(
  buckets: ReasonBucket[],
  category: ReasonCategory,
): { share: number; count: number; total: number } | null {
  const total = buckets.reduce((a, b) => a + b.count, 0);
  if (total === 0) return null;
  const hit = buckets.find((b) => b.category === category);
  if (!hit) return null;
  return { share: hit.count / total, count: hit.count, total };
}
