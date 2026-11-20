
import type { Provider } from "@/services/llm/models";
import { classifyProviderError } from "@/services/llm/provider-errors";
import { classifyFailureOrigin, HarnessFailure } from "@/services/eval/shadow-harness";

export const RESERVE_USD = {
  engineer: 4,
  channel: 6,
  run: 2,
  judge: 0.5,
} as const;

export function reservationFor(kind: "run" | "judge", agentSlug?: string, cohort?: "role" | "channel"): number {
  if (kind === "judge") return RESERVE_USD.judge;
  if (agentSlug === "engineer") return RESERVE_USD.engineer;
  return cohort === "channel" ? RESERVE_USD.channel : RESERVE_USD.run;
}

export type Reservation = { id: number; usd: number; label: string };

export class SpendLedger {
  private spent = 0;
  private inFlight = new Map<number, Reservation>();
  private nextId = 1;
  private stoppedByCap = false;
  stopReason: "reservation_exceeded" | null = null;
  readonly settled: Array<{ label: string; reserved: number; actual: number }> = [];

  constructor(readonly maxUsd: number) {
    if (!(Number.isFinite(maxUsd) && maxUsd > 0)) {
      throw new HarnessFailure(`--max-usd must be a finite number > 0, got ${maxUsd}`);
    }
  }

  get spentUsd(): number {
    return this.spent;
  }
  get inFlightUsd(): number {
    let s = 0;
    for (const r of this.inFlight.values()) s += r.usd;
    return s;
  }
  get partial(): boolean {
    return this.stoppedByCap;
  }

  tryReserve(usd: number, label: string): Reservation | null {
    if (this.stopReason !== null || this.spent + this.inFlightUsd + usd > this.maxUsd) {
      this.stoppedByCap = true;
      return null;
    }
    const r: Reservation = { id: this.nextId++, usd, label };
    this.inFlight.set(r.id, r);
    return r;
  }

  settle(r: Reservation, actualUsd: number | null | undefined): void {
    if (!this.inFlight.delete(r.id)) {
      throw new HarnessFailure(`reservation ${r.id} settled twice or never made`);
    }
    const known = typeof actualUsd === "number" && Number.isFinite(actualUsd) && actualUsd >= 0;
    const actual = known ? (actualUsd as number) : r.usd;
    this.spent += actual;
    this.settled.push({ label: r.label, reserved: r.usd, actual });
    if (actual > r.usd) {
      this.stoppedByCap = true;
      this.stopReason = "reservation_exceeded";
    }
  }
}

export type AttemptResult<T> = { value: T; billedUsd: number | undefined };

export type BilledError = Error & { billedUsd?: number };

export type RetryOutcome<T> =
  | { kind: "ok"; value: T; billedUsd: number; attempts: number }
  | { kind: "infra"; error: string; billedUsd: number; attempts: number }
  | { kind: "failed"; error: unknown; billedUsd: number; attempts: number }
  | { kind: "capped"; error: string; billedUsd: number; attempts: number };

export const RETRY_MAX_ATTEMPTS = 4;
export const RETRY_CEILING_MS = 60_000;

export function isRetryableProviderError(err: unknown, provider: Provider): boolean {
  const { kind } = classifyProviderError(err, provider);
  return kind === "rate_limit" || kind === "server_error" || kind === "network_error";
}

export async function withBenchRetries<T>(
  attempt: () => Promise<AttemptResult<T>>,
  opts: {
    provider: Provider;
    sleep?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    baseMs?: number;
    reserve?: { ledger: SpendLedger; usd: number; label: string };
  },
): Promise<RetryOutcome<T>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const max = opts.maxAttempts ?? RETRY_MAX_ATTEMPTS;
  const base = opts.baseMs ?? 2_000;
  let billed = 0;
  const book = (res: Reservation | null, usd: number | undefined) => {
    if (res) {
      const before = opts.reserve!.ledger.spentUsd;
      opts.reserve!.ledger.settle(res, usd);
      billed += opts.reserve!.ledger.spentUsd - before;
    } else {
      billed += typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : 0;
    }
  };
  for (let i = 1; i <= max; i++) {
    let res: Reservation | null = null;
    if (opts.reserve) {
      res = opts.reserve.ledger.tryReserve(opts.reserve.usd, `${opts.reserve.label}#a${i}`);
      if (!res) {
        return { kind: "capped", error: "--max-usd reached", billedUsd: billed, attempts: i - 1 };
      }
    }
    try {
      const r = await attempt();
      book(res, r.billedUsd);
      return { kind: "ok", value: r.value, billedUsd: billed, attempts: i };
    } catch (e) {
      book(res, (e as BilledError)?.billedUsd);
      if (e instanceof HarnessFailure) throw e;
      if (!isRetryableProviderError(e, opts.provider)) {
        return { kind: "failed", error: e, billedUsd: billed, attempts: i };
      }
      if (i === max) {
        return { kind: "infra", error: (e as Error).message, billedUsd: billed, attempts: i };
      }
      await sleep(Math.min(RETRY_CEILING_MS, base * 2 ** (i - 1)));
    }
  }
  /* istanbul ignore next */
  throw new HarnessFailure("withBenchRetries: unreachable");
}

export type TrialOutcomeKind =
  | "completed"
  | "model_failure"
  | "context_too_small"
  | "infra"
  | "unattributed";

export function attributeTrialFailure(err: unknown, provider: Provider): TrialOutcomeKind {
  if (classifyProviderError(err, provider).kind === "context_length") return "context_too_small";
  const origin = classifyFailureOrigin(err, provider);
  if (origin === "harness") {
    throw err instanceof HarnessFailure
      ? err
      : new HarnessFailure((err as Error)?.message ?? String(err));
  }
  if (isRetryableProviderError(err, provider)) return "infra";
  return origin === "model" ? "model_failure" : "unattributed";
}
