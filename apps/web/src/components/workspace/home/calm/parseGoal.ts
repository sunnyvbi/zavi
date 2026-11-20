
export type ParsedGoal = {
  objective: string;
  target_metric: string;
  target_value: number | null;
  baseline_value: number | null;
  due_date: string | null;
  unit: "percent" | "number";
  targetLabel: string;
  dueLabel: string | null;
};

const LEAD_VERBS =
  /^(get|grow|increase|raise|lift|boost|reach|hit|drive|cut|reduce|lower|shrink|launch|ship|add|scale|improve|double|triple)\s+/i;

const METRIC_KEYWORDS: Array<[RegExp, string]> = [
  [/\bactivation\b/i, "activation"],
  [/\bsign[\s-]?ups?\b/i, "signups"],
  [/\bconversions?\b/i, "conversion rate"],
  [/\bretention\b/i, "retention"],
  [/\bchurn\b/i, "churn"],
  [/\bhosts?\b/i, "hosts"],
  [/\bbookings?\b/i, "bookings"],
  [/\brevenue\b/i, "revenue"],
  [/\bgmv\b/i, "GMV"],
  [/\bmer\b/i, "MER"],
  [/\broas\b/i, "ROAS"],
  [/\bcac\b/i, "CAC"],
  [/\bmrr\b/i, "MRR"],
  [/\barr\b/i, "ARR"],
  [/\bnps\b/i, "NPS"],
  [/\bverif\w*\b/i, "verification"],
  [/\bstates?\b/i, "market coverage"],
  [/\busers?\b/i, "users"],
  [/\bcustomers?\b/i, "customers"],
  [/\bleads?\b/i, "leads"],
];

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function endOfMonthISO(year: number, monthIdx: number): string {
  const d = new Date(Date.UTC(year, monthIdx + 1, 0));
  return d.toISOString().slice(0, 10);
}

function quarterEndISO(year: number, q: number): string {
  const lastMonthIdx = q * 3 - 1;
  return endOfMonthISO(year, lastMonthIdx);
}

function parseDue(
  low: string,
  now: Date,
): { due_date: string | null; dueLabel: string | null } {
  const curYear = now.getUTCFullYear();

  const q = low.match(/\bq([1-4])(?:\s*(\d{4}))?/);
  if (q) {
    const quarter = Number(q[1]);
    const year = q[2] ? Number(q[2]) : curYear;
    return {
      due_date: quarterEndISO(year, quarter),
      dueLabel: `by Q${quarter} ${year}`,
    };
  }

  for (let i = 0; i < MONTHS.length; i++) {
    const m = low.match(new RegExp(`\\b${MONTHS[i]}(?:\\s*(\\d{4}))?`));
    if (m) {
      const year = m[1] ? Number(m[1]) : curYear;
      const label = MONTHS[i][0].toUpperCase() + MONTHS[i].slice(1);
      return {
        due_date: endOfMonthISO(year, i),
        dueLabel: `by ${label} ${year}`,
      };
    }
  }

  const y = low.match(/\bby\s+(?:end\s+of\s+)?(?:the\s+)?(?:year|(\d{4}))\b/);
  if (y) {
    const year = y[1] ? Number(y[1]) : curYear;
    return { due_date: endOfMonthISO(year, 11), dueLabel: `by end of ${year}` };
  }

  return { due_date: null, dueLabel: null };
}

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

export function parseGoal(input: string, now: Date = new Date()): ParsedGoal {
  const objective = input.replace(/\s+/g, " ").trim();
  const low = objective.toLowerCase();

  let baseline_value: number | null = null;
  const fromMatch = low.match(/\bfrom\s+(\d[\d,]*)/);
  if (fromMatch) baseline_value = toNumber(fromMatch[1]);

  const withoutDueYear = low.replace(/\bby\s+(?:end\s+of\s+)?[a-z\s]*\d{4}\b/g, " ");
  const withoutBaseline = withoutDueYear.replace(/\bfrom\s+\d[\d,]*%?/g, " ");
  const pct = withoutBaseline.match(/(\d[\d,]*)\s*%/);
  let target_value: number | null = null;
  let unit: "percent" | "number" = "number";
  if (pct) {
    target_value = toNumber(pct[1]);
    unit = "percent";
  } else {
    const nums = withoutBaseline.match(/\d[\d,]*/g);
    if (nums && nums.length > 0) target_value = toNumber(nums[0]);
  }

  let target_metric = "";
  for (const [re, label] of METRIC_KEYWORDS) {
    if (re.test(low)) {
      target_metric = label;
      break;
    }
  }
  if (!target_metric) {
    target_metric = objective
      .replace(LEAD_VERBS, "")
      .replace(/\s+(to|at)\s+\d[\d,]*%?.*$/i, "")
      .replace(/\s+by\s+.*$/i, "")
      .trim();
    if (!target_metric) target_metric = objective;
  }

  const { due_date, dueLabel } = parseDue(low, now);

  const targetLabel =
    target_value == null
      ? "Set a target"
      : unit === "percent"
        ? `${target_value}%`
        : target_value.toLocaleString("en-US");

  return {
    objective,
    target_metric,
    target_value,
    baseline_value,
    due_date,
    unit,
    targetLabel,
    dueLabel,
  };
}

export function goalCreateBody(parsed: ParsedGoal): Record<string, unknown> {
  return {
    objective: parsed.objective,
    target_metric: parsed.target_metric,
    ...(parsed.target_value != null ? { target_value: parsed.target_value } : {}),
    ...(parsed.baseline_value != null ? { baseline_value: parsed.baseline_value } : {}),
    ...(parsed.due_date ? { due_date: parsed.due_date } : {}),
  };
}
