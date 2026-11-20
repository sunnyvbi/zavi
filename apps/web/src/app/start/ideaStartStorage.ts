import { START_ROUTE } from "@/lib/onboardingRoutes";
import { isIdeaImageDataUrl } from "./IdeaImageAttach";
import type { PickedTemplate } from "@/lib/workspace/siteTemplates";
export const PENDING_BUILD_KEY = "praxis_pending_build";
type PendingBuild = {
  intent: "fresh";
  idea?: string;
  images?: string[];
  template?: PickedTemplate;
  at: number;
  dispatched?: boolean;
};
const STASH_TTL_MS = 24 * 60 * 60 * 1000;
const AUTO_RESUME_WINDOW_MS = 30 * 60 * 1000;
const SIGN_IN_CLOCK_SLACK_MS = 2 * 60 * 1000;
export const RESUME_BUILD_PARAM = "resume";
export const BUILD_SIGNUP_NEXT = `${START_ROUTE}?${RESUME_BUILD_PARAM}=build`;
export function mayAutoResume(
  pending: Pick<PendingBuild, "at" | "dispatched">,
  lastSignInAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (pending.dispatched) return false;
  const signedInAt = Date.parse(lastSignInAt ?? "");
  if (!Number.isFinite(signedInAt)) return false;
  return (
    signedInAt >= pending.at - SIGN_IN_CLOCK_SLACK_MS &&
    now - pending.at <= AUTO_RESUME_WINDOW_MS
  );
}
export function readStash(): PendingBuild | null {
  for (const store of stashStores()) {
    try {
      const raw = store.getItem(PENDING_BUILD_KEY);
      if (!raw) continue;
      const pending = JSON.parse(raw) as PendingBuild;
      if (pending.intent !== "fresh") return null;
      if (
        !Number.isFinite(pending.at) ||
        Date.now() - pending.at > STASH_TTL_MS
      ) {
        clearStash();
        return null;
      }
      return pending;
    } catch {
      continue;
    }
  }
  return null;
}
const PENDING_IMAGES_KEY = `${PENDING_BUILD_KEY}:images`;
export function writeStash(p: Omit<PendingBuild, "at">): boolean {
  const { images, ...rest } = p;
  const raw = JSON.stringify({ ...rest, at: Date.now() });
  clearStash();
  if (images?.length) {
    try {
      window.sessionStorage.setItem(PENDING_IMAGES_KEY, JSON.stringify(images));
    } catch {}
  }
  for (const store of stashStores()) {
    try {
      store.setItem(PENDING_BUILD_KEY, raw);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
export function stashedTemplate(pending: PendingBuild): PickedTemplate | null {
  const t = pending.template;
  return t &&
    typeof t.id === "string" &&
    typeof t.label === "string" &&
    typeof t.idea === "string"
    ? { id: t.id, label: t.label, idea: t.idea }
    : null;
}
export function stashedImages(_pending: PendingBuild): string[] {
  try {
    const raw =
      typeof window === "undefined"
        ? null
        : window.sessionStorage.getItem(PENDING_IMAGES_KEY);
    const images = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(images)
      ? images.filter(isIdeaImageDataUrl).slice(0, 3)
      : [];
  } catch {
    return [];
  }
}
export function markStashDispatched() {
  for (const store of stashStores()) {
    try {
      const raw = store.getItem(PENDING_BUILD_KEY);
      if (!raw) continue;
      const pending = JSON.parse(raw) as PendingBuild;
      store.setItem(
        PENDING_BUILD_KEY,
        JSON.stringify({ ...pending, dispatched: true }),
      );
      return;
    } catch {
      continue;
    }
  }
}
export function clearStash() {
  try {
    if (typeof window !== "undefined")
      window.sessionStorage.removeItem(PENDING_IMAGES_KEY);
  } catch {}
  for (const store of stashStores()) {
    try {
      store.removeItem(PENDING_BUILD_KEY);
    } catch {
      continue;
    }
  }
}
function stashStores(): Storage[] {
  if (typeof window === "undefined") return [];
  const out: Storage[] = [];
  try {
    out.push(window.localStorage);
  } catch {}
  try {
    out.push(window.sessionStorage);
  } catch {}
  return out;
}
