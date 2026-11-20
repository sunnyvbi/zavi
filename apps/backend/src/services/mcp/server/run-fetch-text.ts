
export function buildRunFetchText(run: {
  parsed?: unknown;
  output_text?: string | null;
  raw_response_text?: string | null;
}): string {
  const parsed = run.parsed;
  const hasParsed =
    parsed != null &&
    !(
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed as object).length === 0
    );
  if (hasParsed) return JSON.stringify(parsed, null, 2);

  const out = (run.output_text ?? "").trim();
  if (out.length > 0) return out;

  const raw = (run.raw_response_text ?? "").trim();
  if (raw.length > 0) return raw;

  return "{}";
}
