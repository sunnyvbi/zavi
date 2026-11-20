
import { apiUrl } from "@/lib/api";

export function parseIosAppStoreLive(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Record<string, unknown>).isIosAppStoreLive === true
  );
}

export async function getIosAppStoreLive(): Promise<boolean> {
  try {
    const res = await fetch(apiUrl("/api/mobile/config"), {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    return parseIosAppStoreLive(await res.json());
  } catch {
    return false;
  }
}
