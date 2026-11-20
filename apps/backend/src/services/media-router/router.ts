import { getBoolSetting } from "@/services/settings";
import { generatePlatformImage, isPlatformHiggsfieldConfigured } from "@/services/launch-video/platform-higgsfield";
import { activeRoute, ROUTES } from "./table";
import { priceUsd } from "./prices";
import { vendorCancel, vendorKeyPresent, vendorPollOnce, vendorSubmit } from "./vendors";
import type { JobRef, MediaFailReason, MediaRequest, MediaResult, MediaTask, MediaVendor, PollResult, RouteEntry, SubmitResult } from "./types";
import { isVendorExhausted, reportVendorOutOfCredits } from "./vendor-alert";
import { devStubMedia, isDevStubbed } from "./dev-stub";
import { MEDIA_LEG_MAX_POLLS, MEDIA_LEG_POLL_DELAY_MS } from "@/services/launch-video/render-budget";

export async function isMediaRouterEnabled(): Promise<boolean> {
  if (!(process.env.FAL_KEY || "").trim()) return false;
  try {
    return await getBoolSetting("media_router_enabled");
  } catch {
    return true;
  }
}

const LEGACY_RAIL_CANNOT: ReadonlySet<MediaTask> = new Set<MediaTask>(["image.edit", "image.vector"]);

export async function isTaskConfigured(task: MediaTask): Promise<boolean> {
  if (isDevStubbed(task)) return true;
  if (!(await isMediaRouterEnabled())) {
    if (LEGACY_RAIL_CANNOT.has(task)) return false;
    return isPlatformHiggsfieldConfigured();
  }
  return vendorKeyPresent(activeRoute(task).vendor);
}

export function submitMedia(task: MediaTask, req: MediaRequest): Promise<SubmitResult> {
  return vendorSubmit(activeRoute(task), req);
}

export function pollMediaOnce(job: JobRef): Promise<PollResult> {
  return vendorPollOnce(job);
}

export async function cancelMedia(job: JobRef): Promise<"requested" | "too_late" | "not_found" | "error"> {
  try {
    return await vendorCancel(job);
  } catch {
    return "error";
  }
}

export function estimateCost(task: MediaTask, req: MediaRequest): number {
  return priceUsd(activeRoute(task), req, {});
}

export function costForJob(job: JobRef, req: MediaRequest, done: { duration_s?: number }): number {
  return priceUsd({ vendor: job.vendor, model: job.model, enabled: true }, req, done);
}

export async function downloadMedia(url: string, maxBytes: number, timeoutMs = 60_000): Promise<Uint8Array | null> {
  if (!/^(https:|data:)/i.test(url)) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    return b.byteLength > 0 && b.byteLength <= maxBytes ? b : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type GenerateOpts = {
  pollDelayMs?: number;
  maxPolls?: number;
  resume?: JobRef;
  onSubmitted?: (job: JobRef) => Promise<void>;
};

export function generateMedia(task: MediaTask, req: MediaRequest, opts: GenerateOpts = {}): Promise<MediaResult> {
  return generateOnRoute(task, activeRoute(task), req, opts);
}

async function generateOnRoute(task: MediaTask, entry: RouteEntry, req: MediaRequest, opts: GenerateOpts): Promise<MediaResult> {
  if (isDevStubbed(task) && !opts.resume) {
    const stub = await devStubMedia(task, req);
    if (stub) return stub;
  }
  const r = await generateOnRouteInner(entry, req, opts);
  if (!r.ok && r.reason === "out_of_credits") reportVendorOutOfCredits(r.vendor ?? entry.vendor, r.model ?? entry.model, task);
  return r;
}

async function generateOnRouteInner(entry: RouteEntry, req: MediaRequest, opts: GenerateOpts): Promise<MediaResult> {
  let job: JobRef;
  if (opts.resume) {
    job = opts.resume;
  } else {
    const s = await vendorSubmit(entry, req);
    if (!s.ok) {
      return {
        ok: false,
        reason: s.reason,
        error: s.error,
        vendor: entry.vendor,
        model: entry.model,
        ...(submitProvablyUnbilled(s) ? { unbilled_at_submit: true } : {}),
        ...(typeof s.http_status === "number" ? { http_status: s.http_status } : {}),
      };
    }
    job = s.job;
    if (opts.onSubmitted) {
      try {
        await opts.onSubmitted(job);
      } catch (e) {
        await cancelMedia(job);
        return { ok: false, reason: "vendor_error", error: `could not record the ${entry.model} job: ${(e as Error).message}`, vendor: entry.vendor, model: entry.model };
      }
    }
  }
  const ran: RouteEntry = opts.resume ? { vendor: job.vendor, model: job.model, enabled: true } : entry;
  const maxPolls = opts.maxPolls ?? MEDIA_LEG_MAX_POLLS;
  for (let i = 0; i < maxPolls; i++) {
    const p = await vendorPollOnce(job);
    if (p.state === "done") {
      return { ok: true, url: p.url, mime: p.mime, duration_s: p.duration_s, ...(p.words ? { words: p.words } : {}), vendor: ran.vendor, model: ran.model, cost_usd: priceUsd(ran, req, p) };
    }
    if (p.state === "failed") {
      return { ok: false, reason: p.reason, error: p.error, vendor: ran.vendor, model: ran.model, ...(typeof p.http_status === "number" ? { http_status: p.http_status } : {}) };
    }
    await sleep(opts.pollDelayMs ?? MEDIA_LEG_POLL_DELAY_MS);
  }
  if ((await cancelMedia(job)) === "too_late") {
    const p = await vendorPollOnce(job);
    if (p.state === "done") {
      return { ok: true, url: p.url, mime: p.mime, duration_s: p.duration_s, vendor: ran.vendor, model: ran.model, cost_usd: priceUsd(ran, req, p) };
    }
  }
  return { ok: false, reason: "timeout", error: `${ran.model} poll timeout`, vendor: ran.vendor, model: ran.model };
}

function submitProvablyUnbilled(s: Extract<SubmitResult, { ok: false }>): boolean {
  if (typeof s.http_status === "number") return s.http_status >= 400 && s.http_status < 500;
  return s.reason === "not_configured";
}

function safeToFallBack(r: Extract<MediaResult, { ok: false }>): boolean {
  return r.unbilled_at_submit === true && r.reason !== "refused" && r.reason !== "timeout";
}
export const MAX_FALLBACK_ATTEMPTS = 3;

export async function fallbackChain(task: MediaTask): Promise<RouteEntry[]> {
  const enabled = ROUTES[task].filter((r) => r.enabled);
  if (isDevStubbed(task)) return enabled.slice(0, 1);
  const keyed = (await Promise.all(enabled.map(async (r) => ((await vendorKeyPresent(r.vendor).catch(() => false)) ? r : null)))).filter(
    (r): r is RouteEntry => r !== null,
  );
  const seen = new Set<string>();
  const unique = keyed.filter((r) => (seen.has(r.vendor) ? false : (seen.add(r.vendor), true)));
  const fresh = unique.filter((r) => !isVendorExhausted(r.vendor));
  const tired = unique.filter((r) => isVendorExhausted(r.vendor));
  return [...fresh, ...tired].slice(0, MAX_FALLBACK_ATTEMPTS);
}

export async function isTaskConfiguredWithFallback(task: MediaTask): Promise<boolean> {
  if (isDevStubbed(task)) return true;
  if (!(await isMediaRouterEnabled())) return isTaskConfigured(task);
  return (await fallbackChain(task)).length > 0;
}

export type FallbackMediaResult = MediaResult & {
  attempts: Array<{ vendor: MediaVendor; model: string; reason: MediaFailReason }>;
};

export async function generateMediaWithFallback(
  task: MediaTask,
  req: MediaRequest,
  opts: Pick<GenerateOpts, "pollDelayMs" | "maxPolls"> = {},
): Promise<FallbackMediaResult> {
  const chain = await fallbackChain(task);
  const attempts: FallbackMediaResult["attempts"] = [];
  if (chain.length === 0) {
    return { ok: false, reason: "not_configured", error: `no configured vendor for ${task}`, attempts };
  }
  let last: MediaResult | null = null;
  for (const entry of chain) {
    const r = await generateOnRoute(task, entry, req, { pollDelayMs: opts.pollDelayMs, maxPolls: opts.maxPolls });
    if (r.ok || !safeToFallBack(r)) return { ...r, attempts };
    attempts.push({ vendor: entry.vendor, model: entry.model, reason: r.reason });
    last = r;
  }
  const credits = attempts.find((a) => a.reason === "out_of_credits");
  const final = last as Extract<MediaResult, { ok: false }>;
  return { ...final, reason: credits ? "out_of_credits" : final.reason, attempts };
}

export type RoutedImage =
  | { ok: true; imageUrl: string; mime?: string; cost_usd: number; model: string }
  | { ok: false; error: string; reason: MediaFailReason };

export async function routeImage(task: MediaTask, req: MediaRequest): Promise<RoutedImage> {
  if (!(await isMediaRouterEnabled()) && !isDevStubbed(task)) {
    if (LEGACY_RAIL_CANNOT.has(task)) {
      return { ok: false, error: `${task} needs the media router (FAL_KEY); the legacy image rail cannot serve it`, reason: "not_configured" };
    }
    const r = await generatePlatformImage({ prompt: req.prompt ?? "", aspect_ratio: req.aspect_ratio ?? "1:1" });
    if (!r.ok) return { ok: false, error: r.error, reason: "vendor_error" };
    return { ok: true, imageUrl: r.imageUrl, cost_usd: 0, model: "higgsfield-legacy" };
  }
  const r = await generateMedia(task, req);
  if (!r.ok) return { ok: false, error: r.error, reason: r.reason };
  return { ok: true, imageUrl: r.url, mime: r.mime, cost_usd: r.cost_usd, model: r.model };
}

export async function cacheModelTag(task: MediaTask): Promise<string> {
  return (await isMediaRouterEnabled()) ? activeRoute(task).model : "higgsfield-legacy";
}
