import type { JobRef, MediaRequest, PollResult, RouteEntry, SubmitResult } from "../types";
import { falCancel, falPollOnce, falSubmit, type CancelOutcome } from "./fal";
import { openaiSubmit } from "./openai";
import { geminiSubmit } from "./gemini";
import { higgsfieldSubmit } from "./higgsfield";

export function vendorSubmit(entry: RouteEntry, req: MediaRequest): Promise<SubmitResult> {
  switch (entry.vendor) {
    case "fal": return falSubmit(entry.model, req);
    case "openai": return openaiSubmit(entry.model, req);
    case "gemini": return geminiSubmit(entry.model, req);
    case "higgsfield": return higgsfieldSubmit(entry.model, req);
  }
}

export async function vendorPollOnce(job: JobRef): Promise<PollResult> {
  if (job.inline) return { state: "done", url: job.inline.url, mime: job.inline.mime };
  if (job.vendor === "fal") return falPollOnce(job);
  return { state: "failed", reason: "vendor_error", error: `no poller for ${job.vendor}` };
}

export async function vendorCancel(job: JobRef): Promise<CancelOutcome> {
  if (job.inline) return "too_late";
  if (job.vendor === "fal") return falCancel(job);
  return "error";
}

export async function vendorKeyPresent(vendor: RouteEntry["vendor"]): Promise<boolean> {
  if (vendor === "higgsfield") return (await import("@/services/launch-video/platform-higgsfield-mcp")).isPlatformMcpConfigured().catch(() => false);
  const k = vendor === "fal" ? "FAL_KEY" : vendor === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
  return (process.env[k] || "").trim().length > 0;
}
