
import { getSetting } from "@/services/settings";

function toOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

export async function getPortalAllowlist(
  tenant_id?: string | null,
): Promise<ReadonlySet<string>> {
  if (!tenant_id) return new Set();
  let raw: unknown;
  try {
    raw = await getSetting("browser_portal_allowlist", tenant_id);
  } catch {
    return new Set();
  }
  if (!Array.isArray(raw)) return new Set();
  const origins = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const o = toOrigin(entry.trim());
    if (o) origins.add(o);
  }
  return origins;
}

export async function isNavOriginAllowed(
  tenant_id: string | null | undefined,
  url: string,
): Promise<{ allowed: boolean; origin: string; hadAllowlist: boolean }> {
  const allowlist = await getPortalAllowlist(tenant_id);
  const origin = toOrigin(url);
  if (allowlist.size === 0) return { allowed: true, origin, hadAllowlist: false };
  return { allowed: origin !== "" && allowlist.has(origin), origin, hadAllowlist: true };
}
