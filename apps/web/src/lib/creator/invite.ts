
import { apiUrl } from "@/lib/api";

export type InvitePrefill = { name: string; email: string };

export async function fetchInvitePrefill(token: string): Promise<InvitePrefill | null> {
  try {
    const res = await fetch(apiUrl(`/api/creators/invite/prefill?t=${encodeURIComponent(token)}`), { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { name?: unknown; email?: unknown };
    return typeof j.email === "string" && j.email ? { name: typeof j.name === "string" ? j.name : "", email: j.email } : null;
  } catch {
    return null;
  }
}
