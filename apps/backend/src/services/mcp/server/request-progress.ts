import type { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";

export const MCP_PROGRESS_INTERVAL_MS = 10_000;

export function startMcpProgress(
  token: unknown,
  request: { signal: AbortSignal; sendNotification: (notification: ProgressNotification) => Promise<void> },
): () => void {
  if ((typeof token !== "string" && typeof token !== "number") || request.signal.aborted) return () => {};
  const started = Date.now();
  let stopped = false;
  let sending = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    request.signal.removeEventListener("abort", stop);
  };
  const timer = setInterval(async () => {
    if (stopped || sending) return;
    sending = true;
    try {
      await request.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: (Date.now() - started) / 1_000 },
      });
    } catch {
      stop();
    } finally {
      sending = false;
    }
  }, MCP_PROGRESS_INTERVAL_MS);
  timer.unref?.();
  request.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
