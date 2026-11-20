
import type { EngineEvent, NormalizedUsage } from "./types";

export type WithBudgetMonitorOpts = {
  headroomUsd: number;
  reservationUsd: number;
  margin: number;
  model: string;
  shouldAbortForBudget: (
    accruedUsd: number,
    headroomUsd: number,
    marginUsd: number,
    reservationUsd?: number,
  ) => boolean;
  estimateCostUsd: (model: string, usage: NormalizedUsage) => number;
  abort: AbortController;
  onAbortEvent: (info: { accruedUsd: number; headroomUsd: number }) => void;
};

export async function* withBudgetMonitor(
  stream: AsyncIterable<EngineEvent>,
  opts: WithBudgetMonitorOpts,
): AsyncIterable<EngineEvent> {
  let accruedUsd = 0;
  let aborted = false;

  for await (const e of stream) {
    if (e.type === "usage") {
      if (Number.isFinite(opts.headroomUsd)) {
        accruedUsd += opts.estimateCostUsd(opts.model, e.usage);
        if (
          !aborted &&
          opts.shouldAbortForBudget(
            accruedUsd,
            opts.headroomUsd,
            opts.margin,
            opts.reservationUsd,
          )
        ) {
          aborted = true;
          opts.onAbortEvent({ accruedUsd, headroomUsd: opts.headroomUsd });
          if (!opts.abort.signal.aborted) opts.abort.abort();
        }
      }
      yield e;
      continue;
    }

    if (e.type === "terminal") {
      yield e;
      continue;
    }

    if (aborted) continue;
    yield e;
  }
}
