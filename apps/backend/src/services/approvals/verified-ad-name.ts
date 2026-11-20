
import { isAdChangeHeadlineClass } from "@zavi/shared";
import type { EmitDecisionFn } from "@/services/channels/exec-emit";

export type NameReader = (exec_class: string, payload: Record<string, unknown>, ids: string[]) => Promise<string[]>;

const READ_TIMEOUT_MS = 4000;
const NAME_MAX = 200;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function headlineObjectId(decision_class: string, b: Record<string, unknown>): string | null {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null);
  if (decision_class.startsWith("meta_ads.")) return s(b.ad_set_id) ?? s(b.object_id) ?? s(b.campaign_id);
  if (decision_class.startsWith("google_ads.")) {
    if (b.level === "ad") return null;
    return b.level === "ad_group" ? s(b.ad_group_id) : s(b.campaign_id);
  }
  return null;
}

export async function withVerifiedName(
  tenant_id: string,
  decision_class: string,
  body: unknown,
  read?: NameReader,
): Promise<unknown> {
  const b = obj(body);
  if (!b || !isAdChangeHeadlineClass(decision_class)) return body;
  const { verified_name: _drop, ...rest } = b;
  void _drop;
  const id = headlineObjectId(decision_class, rest);
  if (!id) return rest;
  try {
    const reader = read ?? (await import("@/services/growth/open-advice")).liveAdNameReader(tenant_id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const names = await Promise.race([
      reader(decision_class, rest, [id]),
      new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve([]), READ_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    const name = typeof names[0] === "string" ? names[0].replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
    return name ? { ...rest, verified_name: name } : rest;
  } catch {
    return rest;
  }
}

export function verifiedNameEmit<F extends EmitDecisionFn>(tenant_id: string, emit: F | undefined, read?: NameReader): F | undefined {
  if (!emit) return undefined;
  return (async (decision_class: string, body: unknown) => emit(decision_class, await withVerifiedName(tenant_id, decision_class, body, read))) as F;
}
