
import { apiFetch } from "@/lib/api";
import { captureEvent } from "@/lib/analytics/posthog";

export const READ_BACKOFF_MS: readonly number[] = [500, 1500];

function backoff(): readonly number[] {
  const override = (globalThis as { __ZAVI_READ_BACKOFF_MS__?: readonly number[] }).__ZAVI_READ_BACKOFF_MS__;
  return Array.isArray(override) ? override : READ_BACKOFF_MS;
}

function retryableStatus(status: number, linkedin: boolean): boolean {
  return status === 408 || (!linkedin && status === 429) || status >= 500;
}

const BUSY_CODE = /busy|rate_?limit|throttl/i;

async function providerBusy(res: Response): Promise<boolean> {
  if (res.headers?.get?.("Retry-After")) return true;
  const code = await errorCode(res);
  return !!code && BUSY_CODE.test(code);
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function errorCode(res: Response): Promise<string | null> {
  try {
    if (typeof res.clone !== "function") return null;
    const body = (await res.clone().json()) as { error?: { code?: unknown } | unknown; code?: unknown };
    const raw =
      (body && typeof body.error === "object" && body.error !== null
        ? (body.error as { code?: unknown }).code
        : undefined) ?? body?.code;
    return typeof raw === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export type ReadFailure = {
  read: string;
  slug: string;
  status: number;
  code: string | null;
  ms: number;
  attempts: number;
};

export function reportReadFailure(f: ReadFailure): void {
  try {
    console.warn("[channel-read] failed", f);
    captureEvent("channel_read_failed", f);
  } catch {
  }
}

export async function readWithRetry(path: string, meta: { read: string; slug: string }): Promise<Response> {
  const delays = backoff();
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt >= delays.length;
    try {
      const res = await apiFetch(path);
      if (res.ok) return res;
      const linkedin = meta.slug === "linkedin_ads";
      if (last || !retryableStatus(res.status, linkedin) || (linkedin && await providerBusy(res))) {
        if (res.status !== 404) {
          void errorCode(res).then((code) =>
            reportReadFailure({ ...meta, status: res.status, code, ms: Date.now() - started, attempts: attempt + 1 }),
          );
        }
        return res;
      }
    } catch (e) {
      if (!isAbort(e)) {
        reportReadFailure({ ...meta, status: 0, code: "network", ms: Date.now() - started, attempts: attempt + 1 });
      }
      throw e;
    }
    const ms = delays[attempt] ?? 0;
    if (ms > 0) await sleep(ms);
  }
}
