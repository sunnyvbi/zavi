
import { classifyTargetMetric } from "./goal-metric-resolver";

export function canMeasureAutomatically(humanMetric: string): boolean {
  return classifyTargetMetric(humanMetric).kind !== "unresolved";
}

type ModeResult =
  | { ok: true; value: "auto" | "manual_reported" | undefined }
  | { ok: false; code: string; message: string };

export function validateMeasurementMode(
  raw: unknown,
  humanMetric: string,
): ModeResult {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw !== "auto" && raw !== "manual_reported") {
    return { ok: false, code: "bad_request", message: "measurement_mode must be 'auto' or 'manual_reported'" };
  }
  if (raw === "auto" && !canMeasureAutomatically(humanMetric)) {
    return {
      ok: false,
      code: "measurement_unavailable",
      message: "No connected source can measure this metric. Report the number instead.",
    };
  }
  return { ok: true, value: raw };
}

