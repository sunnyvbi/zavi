
import { SITE_IMAGE_MARKER } from "./constants";

export type SitePhotoCheck =
  | { kind: "ok"; count: number }
  | { kind: "never_called" }
  | { kind: "none_landed" }
  | { kind: "unknown" };

export function photoCheckFromMarker(raw: string | null): SitePhotoCheck {
  if (raw === null) return { kind: "never_called" };
  try {
    const v = JSON.parse(raw) as { images?: unknown };
    if (!Array.isArray(v?.images)) return { kind: "unknown" };
    return v.images.length > 0 ? { kind: "ok", count: v.images.length } : { kind: "none_landed" };
  } catch {
    return { kind: "unknown" };
  }
}

export const PHOTOS_NEVER_CALLED_NUDGE =
  "Before you finish: the site has no photos because add_site_images was never called. Call it once now with a hero and the key sections' photos, put each result on its section (src, srcset, width, height, alt), then finish. If none land, keep the no-image layout.";

export const PHOTOS_NONE_LANDED_NUDGE =
  "Before you finish: no photo landed on the site. Call add_site_images once more with new slugs for the hero and the key sections, put what lands on its section, then finish. If none land again, keep the no-image layout and finish.";

export type SitePhotoStopDeps = {
  readMarker: () => Promise<string | null>;
  noPhotosAsked: boolean;
  onNudge?: (kind: "never_called" | "none_landed") => void;
};

type StopInput = { hook_event_name?: string; stop_hook_active?: boolean };
type StopOutput = { decision?: "block"; reason?: string };

export function sitePhotosStopHook(deps: SitePhotoStopDeps): (input: unknown) => Promise<StopOutput> {
  let nudged = false;
  return async (input) => {
    const i = (input ?? {}) as StopInput;
    if (nudged || deps.noPhotosAsked || i.stop_hook_active === true) return {};
    let check: SitePhotoCheck;
    try {
      check = photoCheckFromMarker(await deps.readMarker());
    } catch {
      check = { kind: "unknown" };
    }
    if (check.kind !== "never_called" && check.kind !== "none_landed") return {};
    nudged = true;
    deps.onNudge?.(check.kind);
    return { decision: "block", reason: check.kind === "never_called" ? PHOTOS_NEVER_CALLED_NUDGE : PHOTOS_NONE_LANDED_NUDGE };
  };
}

export function photoMarkerPath(repoRoot: string): string {
  return `${repoRoot.replace(/\/+$/, "")}/${SITE_IMAGE_MARKER}`;
}

export function isFirstSiteBuildPass(payload: unknown): boolean {
  const p = payload as { fast_single_pass?: unknown; stage?: unknown; repair_mode?: unknown; refine_mode?: unknown; site_id?: unknown } | null;
  return !!p && p.fast_single_pass === true && p.stage === "build" && p.repair_mode !== true && p.refine_mode !== true && typeof p.site_id === "string";
}

export async function sitePhotosStopHookFor(input: {
  payload: unknown;
  tenant_id: string;
  run_id: string;
  site_images: boolean;
  repoRoot: string;
  getSandboxId: () => Promise<string>;
}): Promise<((hookInput: unknown) => Promise<StopOutput>) | null> {
  if (!input.site_images || !isFirstSiteBuildPass(input.payload)) return null;
  const [{ execCommand }, { briefAsksNoImages }, { logEvent }] = await Promise.all([
    import("@/services/sandbox/e2b-client"),
    import("@/services/sites/site-gate"),
    import("@/services/logging/logEvent"),
  ]);
  const idea = String((input.payload as { idea?: unknown }).idea ?? "");
  const path = photoMarkerPath(input.repoRoot);
  const q = `'${path.replace(/'/g, "'\\''")}'`;
  return sitePhotosStopHook({
    noPhotosAsked: briefAsksNoImages(idea),
    async readMarker() {
      const r = await execCommand(await input.getSandboxId(), `if [ -e ${q} ]; then cat ${q}; else printf __none__; fi`, 30_000);
      if (r.exit_code !== 0) throw new Error("marker read failed");
      return r.stdout === "__none__" ? null : r.stdout;
    },
    onNudge(kind) {
      void logEvent({ level: "warn", source: "site-images", code: "site_images.build_end_retry", tenant_id: input.tenant_id, run_id: input.run_id, meta: { skipped_reason: kind } });
    },
  });
}
