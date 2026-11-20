
import type { MediaVendor } from "./types";

export const EXHAUSTED_COOLDOWN_MS = 10 * 60 * 1000;

const exhaustedAt = new Map<MediaVendor, number>();
const alertedDay = new Map<MediaVendor, string>();

export function __resetVendorAlertsForTests(): void {
  exhaustedAt.clear();
  alertedDay.clear();
}

export function isVendorExhausted(vendor: MediaVendor, nowMs: number = Date.now()): boolean {
  const at = exhaustedAt.get(vendor);
  return at !== undefined && nowMs - at < EXHAUSTED_COOLDOWN_MS;
}

export function reportVendorOutOfCredits(vendor: MediaVendor, model: string, task: string, now: Date = new Date()): void {
  exhaustedAt.set(vendor, now.getTime());
  const day = now.toISOString().slice(0, 10);
  if (alertedDay.get(vendor) === day) return;
  alertedDay.set(vendor, day);
  void import("@/services/logging/alert")
    .then(({ alert }) =>
      alert({
        source: "media-router",
        code: "media_vendor_out_of_credits",
        msg:
          `Media vendor ${vendor} is out of credits (model ${model.slice(0, 80)}, task ${task}). ` +
          "Site photos fall back to the next configured vendor; generated images, videos and voiceovers on this vendor fail until the account is topped up.",
        email: { dedupeKey: `media_vendor_out_of_credits:${vendor}:${day}`, subjectDetail: `top up ${vendor}` },
      }),
    )
    .catch(() => undefined);
}
