
import { classifyProviderError, isRetryableSameModel } from "./provider-errors";
import { DEFAULT_PROVIDER, type Provider } from "./models";

export type ProviderRetryOpts = {
  provider?: Provider;
  attempts?: number;
  baseMs?: number;
  maxDelayMs?: number;
  label?: string;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withProviderRetry<T>(
  fn: () => Promise<T>,
  opts: ProviderRetryOpts = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseMs = opts.baseMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 4000;
  const sleep = opts.sleep ?? defaultSleep;
  const provider = opts.provider ?? DEFAULT_PROVIDER;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const info = classifyProviderError(e, provider);
      const isLast = i === attempts - 1;
      if (!isRetryableSameModel(info.kind) || isLast) throw e;
      const expo = Math.min(maxDelayMs, baseMs * 2 ** i);
      const wait = info.retryDelayMs != null ? Math.min(maxDelayMs, info.retryDelayMs) : expo;
      const jitter = wait * 0.2 * Math.random();
      if (opts.label) {
        console.warn(
          `[provider-retry] ${opts.label}: ${info.kind} attempt ${i + 1}/${attempts}, waiting ${Math.round(
            wait + jitter,
          )}ms`,
        );
      }
      await sleep(wait + jitter);
    }
  }
  throw lastErr;
}
