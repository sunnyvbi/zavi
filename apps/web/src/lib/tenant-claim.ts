
function decodePayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(
      decodeURIComponent(
        atob(padded)
          .split("")
          .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
          .join(""),
      ),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function decodeActiveTenantClaim(jwt: string): string | null {
  const p = decodePayload(jwt) as {
    app_metadata?: { active_tenant_id?: string };
  } | null;
  const v = p?.app_metadata?.active_tenant_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function decodeSessionId(jwt: string): string | null {
  const p = decodePayload(jwt) as { session_id?: string } | null;
  const v = p?.session_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}
