import { describe, it } from "vitest";
import { measureGoalMetric, classifyTargetMetric } from "../goal-metric-resolver";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function oldBehavior(m: string): string {
  const s = m.toLowerCase();
  if (/book/.test(s)) return "operator_funnel";
  if (/sign[\s_-]?up/.test(s)) return "native_funnel(signup)";
  if (/activat/.test(s)) return "native_funnel(activation)";
  if (/purchase|order|sale/.test(s)) return "native_funnel(purchase)";
  if (/key[\s_-]?action/.test(s)) return "native_funnel(key_action)";
  return "unresolved  <- silently unmeasured";
}

const CASES = [
  { metric: "mrr", why: "8 real prod goals say this" },
  { metric: "ARR", why: "2 real prod goals — must be MRR x 12" },
  { metric: "arr_usd", why: "separator form; a naive \\barr\\b misses it" },
  { metric: "rentals", why: "2 real prod goals" },
  { metric: "GMV", why: "MUST stay unresolved — it is not Stripe MRR" },
  { metric: "ltv", why: "revenue family but NOT mrr — must stay unresolved" },
  { metric: "weekly signups", why: "already worked; must not regress" },
];

const ENABLED = process.env.VERIFY_GOAL_FIX === "1";

describe.skipIf(!ENABLED)("goal resolver — live verification", () => {
  it("prints classify + measure for each metric", async () => {
    console.log(`\n${"=".repeat(78)}`);
    console.log("GOAL RESOLVER VERIFICATION — tenant upcar-ai, live connectors, read-only");
    console.log("=".repeat(78));

    for (const { metric, why } of CASES) {
      const cls = classifyTargetMetric(metric);
      let measured: string;
      try {
        const out = await measureGoalMetric({
          tenant_id: TENANT,
          target_metric: metric,
          goal_created_at: "2026-07-01T00:00:00Z",
        });
        measured = out.measured
          ? `value=${out.value} ${out.unit}${out.basis ? ` (basis ${out.basis})` : ""}`
          : `abstained: ${out.reason}`;
      } catch (e) {
        measured = `THREW: ${(e as Error).message}`;
      }
      console.log(`\n  "${metric}"   — ${why}`);
      console.log(`     BEFORE : ${oldBehavior(metric)}`);
      console.log(`     NOW    : ${cls.kind}${"basis" in cls ? `/${cls.basis}` : ""}`);
      console.log(`     MEASURED: ${measured}`);
    }

    console.log(`\n${"=".repeat(78)}`);
    console.log("PASS looks like:");
    console.log("  mrr            -> stripe_mrr/mrr, a dollar value");
    console.log("  ARR            -> stripe_mrr/arr, EXACTLY 12x the mrr value above");
    console.log("  arr_usd        -> stripe_mrr/arr (not unresolved)");
    console.log("  rentals        -> operator_funnel (measures, or abstains honestly)");
    console.log("  GMV            -> unresolved  (must NOT be a dollar value)");
    console.log("  ltv            -> unresolved");
    console.log("  weekly signups -> native_funnel or operator_db_signups, a count");
    console.log("=".repeat(78) + "\n");
  }, 180000);
});
