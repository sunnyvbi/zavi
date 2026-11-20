
import { z } from "zod";
import type { ToolContext, ToolSpec } from "@/services/tools/types";
import { ExprError, MAX_EXPR_LENGTH, evaluate, expressionLiterals } from "@/services/analytics/compute-expr";
import { getResult, newResultId, putResult } from "@/services/analytics/metric-results";
import { figureIsDecisionSource, recordFiguresFromPull, recordTrustedMoneyValue, smallIntWasRead } from "@/services/agents/engine/figure-ledger";

export const COMPUTE_LEDGER_NAME = "growth__compute";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const FUNC_NAMES = new Set(["pct_change", "pp_change", "ratio"]);
const RESULT_REF = /^[mc]_[0-9a-f]{10}(#compare)?$/;

export const computeInputSchema = z
  .object({
    expression: z.string().min(1).max(MAX_EXPR_LENGTH),
    inputs: z
      .record(z.string().regex(NAME, "input names are identifiers like current or prior"), z.union([z.number(), z.string().regex(RESULT_REF, "a result_id from get_metric/compute, optionally with #compare")]))
      .refine((r) => Object.keys(r).length <= 20, "at most 20 inputs")
      .refine((r) => !Object.keys(r).some((k) => FUNC_NAMES.has(k)), "input names cannot be pct_change, pp_change or ratio"),
    label: z.string().max(120).optional(),
  })
  .strict();

type InputReceipt = { value: number; result_id?: string; metric_id?: unknown; which?: "total" | "compare"; receipt?: unknown };

function record(ctx: ToolContext, output: unknown): void {
  if (!ctx.run_id) return;
  try {
    recordFiguresFromPull(ctx.run_id, JSON.stringify(output), COMPUTE_LEDGER_NAME);
  } catch {
  }
}

export async function runCompute(ctx: ToolContext, raw: unknown) {
  const input = computeInputSchema.parse(raw);
  const vars: Record<string, number> = {};
  const used: Record<string, InputReceipt> = {};
  let verified = true;
  let sourced = true;
  const literalRead = (v: number) => !!ctx.run_id && (figureIsDecisionSource(ctx.run_id, String(v)) || smallIntWasRead(ctx.run_id, v));

  for (const [name, ref] of Object.entries(input.inputs)) {
    if (typeof ref === "number") {
      if (!Number.isFinite(ref)) return { result_id: null, status: "invalid_input", message: `${name} is not a finite number.` };
      vars[name] = ref;
      used[name] = { value: ref };
      verified = false;
      if (!literalRead(ref)) sourced = false;
      continue;
    }
    const [id, which] = ref.split("#");
    const r = getResult(ctx.tenant_id, ctx.run_id, id);
    if (!r) {
      return {
        result_id: null,
        status: "unknown_result",
        message: `${id} is not a result from this run (results do not carry over between runs or between separate MCP calls). Pass the number itself as the input instead.`,
      };
    }
    const v = which === "compare" ? r.compare_value : r.value;
    if (v == null || !Number.isFinite(v)) {
      return {
        result_id: null,
        status: "no_value",
        message: `${ref} has no ${which === "compare" ? "compare " : ""}value (the source returned none), so nothing is computed from it.`,
      };
    }
    if (r.kind === "compute" && r.verified !== true) verified = false;
    if (r.kind === "compute" && r.sourced === false) sourced = false;
    vars[name] = v;
    used[name] = {
      value: v,
      result_id: id,
      which: which === "compare" ? "compare" : "total",
      metric_id: r.receipt.metric_id,
      receipt: r.receipt,
    };
  }

  let value: number;
  try {
    value = evaluate(input.expression, vars);
  } catch (e) {
    if (e instanceof ExprError) return { result_id: null, status: e.code, message: e.message };
    throw e;
  }
  value = Math.round(value * 10000) / 10000;
  for (const lit of expressionLiterals(input.expression)) {
    verified = false;
    if (!literalRead(lit)) sourced = false;
  }

  const substituted = input.expression.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (m) =>
    Object.prototype.hasOwnProperty.call(vars, m) ? String(vars[m]) : m,
  );
  const result_id = newResultId("compute");
  const receipt = {
    source: "compute",
    expression: input.expression,
    formula: `${substituted} = ${value}`,
    ...(input.label ? { label: input.label } : {}),
    inputs: used,
  };
  const output = { result_id, status: "ok" as const, value, verified, formula: receipt.formula, inputs: used };
  putResult(ctx.tenant_id, ctx.run_id, { result_id, kind: "compute", value, receipt, verified, sourced });
  if (sourced) {
    record(ctx, output);
    if (ctx.run_id && !/\b(pct_change|pp_change)\s*\(/.test(input.expression)) recordTrustedMoneyValue(ctx.run_id, value);
  }
  return output;
}

export const computeTool: ToolSpec = {
  name: "growth_compute",
  effect: "read",
  description:
    "Do arithmetic in code instead of in your head: deltas, ratios, percent change, percentage points, CAC-style divisions. " +
    "expression uses input names, numbers, + - * / ( ), pct_change(old, new) (percent), pp_change(old, new) (percentage points between two fractions) and ratio(a, b). " +
    "inputs maps each name to a result_id from growth__get_metric or growth__compute in THIS run (add #compare for the compare-window total) or to a plain number the founder gave you. " +
    "Returns {result_id, value, verified, formula, inputs}; quote value exactly and cite the formula. verified is false when any input is a plain number. A non-ok status means nothing was computed.",
  input_schema: computeInputSchema,
  async execute(ctx, input) {
    return runCompute(ctx, input);
  },
};
