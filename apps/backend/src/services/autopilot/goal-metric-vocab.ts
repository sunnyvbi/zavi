
export type MeasurementMode = "auto" | "manual_reported" | "unmapped";

export type MetricSource =
  | { kind: "native_funnel"; step: "signup" | "activation" | "purchase" | "key_action" }
  | { kind: "operator_funnel" }
  | { kind: "booking_value" }
  | { kind: "stripe_mrr"; basis: "mrr" | "arr" }
  | { kind: "stripe_gross_revenue" }
  | { kind: "unresolved" };

export function classifyTargetMetric(target_metric: string): MetricSource {
  const m = (target_metric ?? "").toLowerCase().replace(/[_\-./]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\brates?\b|%|\bpercent|\bratio\b|\bcvr\b|\bctr\b|\baverage\b|\bavg\b|\baov\b|\barpu\b|\bltv\b/.test(m)) {
    return { kind: "unresolved" };
  }
  if (/\bgmv\b|\bgross merchandise\b|\bgross bookings?\b|\b(booked|booking|bookings|order|orders|sales|rental|rentals|reservation|reservations|trip|trips) (value|volume|amount|revenue|dollars?)\b/.test(m)) {
    return { kind: "booking_value" };
  }
  if (/\bbook/.test(m)) return { kind: "operator_funnel" };
  if (/rental|reservation|\btrip/.test(m)) return { kind: "operator_funnel" };
  if (/\barr\b/.test(m)) return { kind: "stripe_mrr", basis: "arr" };
  if (/\bmrr\b/.test(m)) return { kind: "stripe_mrr", basis: "mrr" };
  if (/\bgross (revenue|volume)\b/.test(m)) return { kind: "stripe_gross_revenue" };
  if (/sign ?up|\bnew users?\b|\bregistrations?\b/.test(m)) return { kind: "native_funnel", step: "signup" };
  if (/activat/.test(m)) return { kind: "native_funnel", step: "activation" };
  if (/purchase|order|sale/.test(m)) return { kind: "native_funnel", step: "purchase" };
  if (/key ?action/.test(m)) return { kind: "native_funnel", step: "key_action" };
  return { kind: "unresolved" };
}

export function classifyMetricMode(targetMetric: string): Exclude<MeasurementMode, "unmapped"> {
  return classifyTargetMetric(targetMetric).kind === "unresolved" ? "manual_reported" : "auto";
}

export type GoalJunkInput = {
  objective?: string;
  target_metric?: string;
  target_value?: number;
};

const VOWEL_RE = /[aeiou]/i;

function isAllSameChar(s: string): boolean {
  const squashed = s.toLowerCase().replace(/\s+/g, "");
  return squashed.length >= 2 && new Set(squashed).size === 1;
}

export function detectGoalJunk(input: GoalJunkInput): string | null {
  if (input.objective !== undefined) {
    const obj = input.objective.trim();
    if (obj.length < 8) {
      return "Objective is too short — describe a real goal, e.g. \"Grow MRR to $50k by Q3\".";
    }
    if (isAllSameChar(obj)) {
      return "Objective looks like placeholder text — write a real goal your team can work toward.";
    }
    const letters = obj.replace(/[^a-z]/gi, "");
    const hasDigits = /\d/.test(obj);
    if (!hasDigits && letters.length >= 3 && !VOWEL_RE.test(letters)) {
      return "Objective doesn't look like real words — write a real goal your team can work toward.";
    }
  }

  if (input.target_metric !== undefined) {
    const metric = input.target_metric.trim();
    if (metric.length < 2) {
      return "Target metric is too short — name a measurable metric, e.g. \"mrr\" or \"signups\".";
    }
    if (isAllSameChar(metric)) {
      return "Target metric looks like placeholder text — name a measurable metric, e.g. \"mrr\" or \"signups\".";
    }
  }

  if (input.target_value !== undefined) {
    if (!Number.isFinite(input.target_value) || input.target_value <= 0) {
      return "Target value must be a number greater than zero.";
    }
  }

  return null;
}
