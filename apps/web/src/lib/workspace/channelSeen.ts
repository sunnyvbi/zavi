import { apiFetch } from "@/lib/api";

export const CHANNEL_SEEN_ATTEMPTS = 4;
export const CHANNEL_SEEN_DEFAULT_WAIT_MS = 1000;
export const CHANNEL_SEEN_MAX_WAIT_MS = 10_000;

export type ChannelSeenOutcome = "seen" | "refused" | "gave_up" | "aborted";

function waitFor(res: Response): number {
  const raw = res.headers.get("Retry-After");
  const secs = raw === null || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(secs) || secs < 0) return CHANNEL_SEEN_DEFAULT_WAIT_MS;
  return Math.min(secs * 1000, CHANNEL_SEEN_MAX_WAIT_MS);
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function markChannelSeen(slug: string, signal: AbortSignal): Promise<ChannelSeenOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    if (signal.aborted) return "aborted";
    let res: Response | null = null;
    try {
      res = await apiFetch("/api/workspace/channel-seen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
        signal,
      });
    } catch {
      if (signal.aborted) return "aborted";
    }
    if (res?.ok) return "seen";
    if (res && res.status !== 503) return "refused";
    if (attempt >= CHANNEL_SEEN_ATTEMPTS) return "gave_up";
    if (!(await sleep(res ? waitFor(res) : CHANNEL_SEEN_DEFAULT_WAIT_MS, signal))) return "aborted";
  }
}
