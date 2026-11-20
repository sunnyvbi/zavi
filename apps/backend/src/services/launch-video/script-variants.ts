
import type { LaunchVideoIntake, VariantScriptOverlay } from "./brief-mapper";

export interface ResolvedVariant {
  label: string;
  intake: LaunchVideoIntake;
}

export const MAX_VIDEO_OUTPUTS = 6;

function stripScripts(intake: LaunchVideoIntake): LaunchVideoIntake {
  const { scripts: _drop, ...rest } = intake as LaunchVideoIntake & { scripts?: unknown };
  return rest as LaunchVideoIntake;
}

function mergeOverlay(base: LaunchVideoIntake, overlay: VariantScriptOverlay): LaunchVideoIntake {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overlay)) {
    if (v !== undefined) out[k] = v;
  }
  return out as LaunchVideoIntake;
}

export function resolveScriptVariants(intake: LaunchVideoIntake): ResolvedVariant[] {
  const overlays = Array.isArray(intake.scripts) ? (intake.scripts as VariantScriptOverlay[]) : [];
  const base = stripScripts(intake);
  const variants: ResolvedVariant[] = [{ label: "A", intake: base }];
  overlays.forEach((overlay, i) => {
    variants.push({
      label: String.fromCharCode("B".charCodeAt(0) + i),
      intake: mergeOverlay(base, overlay),
    });
  });
  return variants;
}

export function applyHookPack(intake: LaunchVideoIntake): LaunchVideoIntake {
  if (Array.isArray(intake.scripts) && intake.scripts.length > 0) return intake;
  const raw = Array.isArray(intake.hook_pack) ? intake.hook_pack : [];
  const seen = new Set<string>();
  const hooks: string[] = [];
  for (const h of raw) {
    const t = (h ?? "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hooks.push(t);
    if (hooks.length >= MAX_VIDEO_OUTPUTS) break;
  }
  if (hooks.length < 2) return intake;
  const [first, ...rest] = hooks;
  const { hook_pack: _drop, ...base } = intake as LaunchVideoIntake & { hook_pack?: unknown };
  return {
    ...(base as LaunchVideoIntake),
    one_liner: first,
    scripts: rest.map((hook) => ({ one_liner: hook })),
  };
}

export function capVariantsForAspects(
  variants: ResolvedVariant[],
  aspectCount: number,
  maxOutputs: number = MAX_VIDEO_OUTPUTS,
): { kept: ResolvedVariant[]; capped: boolean } {
  const a = Math.max(1, aspectCount);
  const maxVariants = Math.max(1, Math.floor(maxOutputs / a));
  if (variants.length <= maxVariants) return { kept: variants, capped: false };
  return { kept: variants.slice(0, maxVariants), capped: true };
}
