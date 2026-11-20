
import { checkSiteReachable, normalizeSiteInput, type NormalizeError, type SiteInput } from "./request";

export type AdmitRefusal = NormalizeError | "unsafe_url" | "unreachable";

export type AdmitResult<S> =
  | { ok: true; site: SiteInput }
  | { ok: false; code: AdmitRefusal }
  | { ok: false; stopped: S };

export async function admitSite<S = never>(
  raw: unknown,
  gate?: () => Promise<S | null>,
): Promise<AdmitResult<S>> {
  const shaped = normalizeSiteInput(raw);
  if (!shaped.ok) return { ok: false, code: shaped.error };
  if (gate) {
    const stop = await gate();
    if (stop !== null) return { ok: false, stopped: stop };
  }
  const unreachable = await checkSiteReachable(shaped.value);
  if (unreachable) return { ok: false, code: unreachable };
  return { ok: true, site: shaped.value };
}
