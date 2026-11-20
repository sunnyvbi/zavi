const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BUILD_TAB_DEST = "/workspace?tab=build";

export function buildDestFor(body: unknown): string {
  const b = body as { conductor_run_id?: unknown; run_id?: unknown } | null;
  const id = [b?.conductor_run_id, b?.run_id].find(
    (v): v is string => typeof v === "string" && UUID_RE.test(v),
  );
  return id ? `${BUILD_TAB_DEST}&build=${id}` : BUILD_TAB_DEST;
}
