import { supabase } from "./supabase";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64UrlDecode(input: string): string | null {
  const clean = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of padded) {
    if (ch === "=") break;
    const idx = B64.indexOf(ch);
    if (idx === -1) return null;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(
      bytes.map((b) => "%" + b.toString(16).padStart(2, "0")).join(""),
    );
  } catch {
    return null;
  }
}

export function decodeActiveTenantClaim(jwt: string): string | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  const json = base64UrlDecode(part);
  if (!json) return null;
  try {
    const payload = JSON.parse(json) as {
      app_metadata?: { active_tenant_id?: string };
    };
    const v = payload.app_metadata?.active_tenant_id;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function currentTenantClaim(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? decodeActiveTenantClaim(token) : null;
}

export async function refreshSessionUntilClaim(
  targetTenantId: string,
  attempts = 3,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const { data, error } = await supabase.auth.refreshSession();
      if (!error) {
        const token = data.session?.access_token;
        if (token && decodeActiveTenantClaim(token) === targetTenantId) return true;
      }
    } catch {
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  return false;
}
