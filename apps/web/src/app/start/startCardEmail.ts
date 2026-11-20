import { apiFetch } from "@/lib/api";
import { START_CARD_PUBLIC_ID_RE } from "@/lib/start-card/api";
import type { StartCardState } from "./useStartCard";

export const START_CARD_EMAIL_TIMEOUT_MS = 3_000;

export type StartCardEmailTarget = {
  startCardId?: string | null;
  startCardSite?: string | null;
};

export function startCardEmailTarget(state: StartCardState): StartCardEmailTarget {
  if (state.phase === "card") return { startCardId: state.publicId };
  if (state.phase === "captcha" || state.phase === "creating" || state.phase === "queued") {
    return { startCardSite: state.domain };
  }
  return {};
}

export async function emailStartCard(target: StartCardEmailTarget): Promise<void> {
  const publicId = target.startCardId && START_CARD_PUBLIC_ID_RE.test(target.startCardId) ? target.startCardId : null;
  const payload = publicId ? { public_id: publicId } : target.startCardSite ? { url: target.startCardSite } : null;
  if (!payload) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, START_CARD_EMAIL_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      apiFetch("/api/onboarding/start-card-email", {
        method: "POST",
        body: JSON.stringify(payload),
        signal: controller.signal,
        retryOnNetworkError: false,
      }),
      deadline,
    ]);
  } catch {
    return;
  } finally {
    clearTimeout(timer);
  }
}
