import { generatePlatformImage } from "@/services/launch-video/platform-higgsfield";
import type { MediaRequest, SubmitResult } from "../types";

export async function higgsfieldSubmit(model: string, req: MediaRequest): Promise<SubmitResult> {
  const r = await generatePlatformImage({ prompt: req.prompt ?? "", aspect_ratio: req.aspect_ratio ?? "1:1" });
  if (!r.ok) {
    const reason = r.reason === "vendor_wallet_exhausted" ? "out_of_credits" : r.reason === "credential_rejected" ? "not_configured" : "vendor_error";
    return { ok: false, reason, error: r.error };
  }
  return { ok: true, job: { vendor: "higgsfield", model, id: r.jobId ?? `hf-${Date.now()}`, inline: { url: r.imageUrl, mime: "image/png" } } };
}
