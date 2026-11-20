import { z } from "zod";
import { deliverImage, type SkippedImage } from "@/services/reports/deliver-image";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";
import { assertReviewable, readAction } from "./action-execution";

export const adImagePrompt = z.object({ prompt: z.string().trim().min(3).max(900), variation: z.number().int().min(1).max(100).optional() }).strict();

export function variationPrompt(prompt: string, variation = 1): string {
  return variation > 1 ? `${prompt}\n\nVersion ${variation}: a clearly different composition, angle and setting from earlier versions.` : prompt;
}

const SKIP_MESSAGE: Record<SkippedImage["reason"], { code: string; message: string }> = {
  insufficient_credits: { code: "insufficient_credits", message: "You don't have enough credits for an AI image. Add credits or upload your own image." },
  refused: { code: "image_refused", message: "The image model declined this description. Change the wording and try again, or upload your own image." },
  vendor_out_of_credits: { code: "image_service_unavailable", message: "Zavi's image service is unavailable right now. Upload your own image instead." },
  not_configured: { code: "image_service_unavailable", message: "Zavi's image service is unavailable right now. Upload your own image instead." },
  over_daily_cap: { code: "image_daily_limit", message: "This workspace reached today's AI image limit. Upload your own image instead." },
  meter_error: { code: "image_unavailable", message: "Zavi could not start the image. Try again in a moment." },
  generation_failed: { code: "image_unavailable", message: "The image did not come out. Try again in a moment." },
  download_failed: { code: "image_unavailable", message: "The image did not come out. Try again in a moment." },
  unsupported_type: { code: "image_unavailable", message: "The image did not come out. Try again in a moment." },
  store_failed: { code: "image_unavailable", message: "The image could not be saved. Try again in a moment." },
  transform_failed: { code: "image_unavailable", message: "The image could not be saved. Try again in a moment." },
  charge_failed: { code: "image_unavailable", message: "Zavi could not record the charge for this image, so it was not kept. Try again in a moment." },
  deadline: { code: "image_unavailable", message: "The image took too long. Try again in a moment." },
  preview_render_used: { code: "image_unavailable", message: "This run already made its images. Upload your own image instead." },
};

export async function createAdImage(tenantId: string, actionId: string, input: unknown): Promise<{ image_path: string }> {
  const { prompt, variation } = adImagePrompt.parse(input);
  const row = await readAction(tenantId, actionId);
  assertReviewable(row);
  if (!row.run_id) throw new ExpectedToolError("image_service_unavailable", "AI images are not available for this draft. Upload your own image.");
  const result = await deliverImage(
    { tenant_id: tenantId, run_id: row.run_id, stageable: true },
    { prompts: [{ prompt: variationPrompt(prompt, variation), filename: "chatgpt-ad-image" }], aspect_ratio: "1:1", mode: "photo" },
  );
  const image = result.images[0];
  if (image?.image_path) return { image_path: image.image_path };
  const skip = result.skipped[0];
  if (image && !image.image_path) {
    void logEvent({ level: "error", source: "chatgpt-ads", code: "chatgpt_ads.ad_image_copy_failed", tenant_id: tenantId, run_id: row.run_id });
    throw new ExpectedToolError("image_unavailable", "The image was made but could not be attached. It is in your Files; upload it from there.");
  }
  const mapped = skip ? SKIP_MESSAGE[skip.reason] : SKIP_MESSAGE.generation_failed;
  if (!skip || !["insufficient_credits", "refused"].includes(skip.reason)) {
    void logEvent({ level: "warn", source: "chatgpt-ads", code: "chatgpt_ads.ad_image_failed", tenant_id: tenantId, run_id: row.run_id, meta: { failure_class: mapped.code } });
  }
  throw new ExpectedToolError(mapped.code, mapped.message);
}
