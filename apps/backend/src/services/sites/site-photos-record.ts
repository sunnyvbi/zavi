
import { isFirstSiteBuildPass, photoCheckFromMarker, photoMarkerPath } from "@/services/site-images/build-end-check";
import { recordSitePhotos } from "./site-photos";

type Exec = (sandbox_id: string, cmd: string, timeoutMs: number) => Promise<{ exit_code: number; stdout: string }>;

export function recordsPhotos(payload: unknown, noPhotosAsked: (idea: string) => boolean): boolean {
  const p = payload as { photo_retry?: unknown; refine_mode?: unknown; site_id?: unknown; idea?: unknown } | null;
  if (!p || typeof p.site_id !== "string" || !p.site_id) return false;
  const retry = p.photo_retry === true && p.refine_mode === true;
  if (!retry && !isFirstSiteBuildPass(payload)) return false;
  return retry || !noPhotosAsked(String(p.idea ?? ""));
}

export async function recordBuildPhotos(
  input: { tenant_id: string; payload: unknown; sandbox_id: string; repoRoot: string },
  deps: { exec?: Exec; record?: typeof recordSitePhotos; noPhotosAsked?: (idea: string) => boolean } = {},
): Promise<void> {
  try {
    const noPhotosAsked = deps.noPhotosAsked ?? (await import("./site-gate")).briefAsksNoImages;
    if (!recordsPhotos(input.payload, noPhotosAsked)) return;
    const exec = deps.exec ?? (await import("@/services/sandbox/e2b-client")).execCommand;
    const path = photoMarkerPath(input.repoRoot);
    const q = `'${path.replace(/'/g, "'\\''")}'`;
    const r = await exec(input.sandbox_id, `if [ -e ${q} ]; then cat ${q}; else printf __none__; fi`, 15_000);
    if (r.exit_code !== 0) return;
    const check = photoCheckFromMarker(r.stdout === "__none__" ? null : r.stdout);
    const site_id = (input.payload as { site_id: string }).site_id;
    await (deps.record ?? recordSitePhotos)({ tenant_id: input.tenant_id, site_id, check });
  } catch (e) {
    console.warn(`[site-photos] post-run record skipped: ${(e as Error)?.message ?? e}`);
  }
}
