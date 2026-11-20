
const loggedOnce = new Set<string>();

export function isMissingRelation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "42P01" || code === "PGRST205" || code === "PGRST204") return true;
  const m = typeof message === "string" ? message : "";
  return /does not exist|could not find the (table|function|column)|schema cache/i.test(m);
}

export function noteMissingRelationOnce(relation: string, error: unknown): void {
  if (loggedOnce.has(relation)) return;
  loggedOnce.add(relation);
  const message =
    error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : String(error);
  console.warn(
    `[personalization] '${relation}' is not available yet (pending migration) — treating as empty. ${message}`,
  );
}
