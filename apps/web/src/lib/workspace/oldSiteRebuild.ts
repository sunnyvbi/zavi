
import { apiFetch } from "@/lib/api";

export const OLD_SITE_FROZEN_CODE = "old_site_frozen";

export const REBUILD_OLD_SITE_LABEL = "Rebuild on the new builder";

export const OLD_SITE_FROZEN_FALLBACK =
  "This site was made with our earlier builder. It stays live exactly as it is, but it can't be changed anymore. " +
  `To make changes, choose "${REBUILD_OLD_SITE_LABEL}". That starts a fresh site with the same name and description. ` +
  "Your old site's saved data, like form entries or sign-ups, does not move over. " +
  "Your old site stays live until you point your domain at the new one.";

export const REBUILD_DATA_NOTE =
  "Starts a fresh site with the same name and description. Saved data, like form entries or sign-ups, does not move over. Your old site stays live until you point your domain at the new one.";

export type OldSiteFrozenRefusal = { kind: "old_site_frozen"; message: string };

export function oldSiteFrozenFrom(body: unknown): OldSiteFrozenRefusal | null {
  const error = (body as { error?: { code?: unknown; message?: unknown; chat?: unknown } } | null)?.error;
  if (!error || error.code !== OLD_SITE_FROZEN_CODE) return null;
  const text = typeof error.chat === "string" && error.chat.trim()
    ? error.chat.trim()
    : typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : OLD_SITE_FROZEN_FALLBACK;
  return { kind: "old_site_frozen", message: text };
}

export function isOldSiteFrozen(value: unknown): value is OldSiteFrozenRefusal {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "old_site_frozen";
}

export type RebuildOutcome =
  | { kind: "started"; conductorRunId: string; already: boolean }
  | { kind: "starting" }
  | { kind: "error"; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requestOldSiteRebuild(): Promise<RebuildOutcome> {
  try {
    const res = await apiFetch("/api/workspace/website/rebuild-old-site", { method: "POST", body: JSON.stringify({}) });
    const body = (await res.json().catch(() => null)) as {
      conductor_run_id?: unknown;
      already?: unknown;
      starting?: unknown;
      error?: { message?: unknown };
    } | null;
    if (res.status === 202 || body?.starting === true) return { kind: "starting" };
    if (res.ok && typeof body?.conductor_run_id === "string" && UUID_RE.test(body.conductor_run_id)) {
      return { kind: "started", conductorRunId: body.conductor_run_id, already: body.already === true };
    }
    const message = typeof body?.error?.message === "string" && body.error.message.trim()
      ? body.error.message.trim()
      : "We couldn't start the rebuild. Nothing was changed. Please try again.";
    return { kind: "error", message };
  } catch {
    return { kind: "error", message: "We couldn't reach Zavi. Check your connection and try again." };
  }
}

export function rebuildBuildHref(conductorRunId: string): string {
  return `/workspace?tab=build&build=${encodeURIComponent(conductorRunId)}`;
}
