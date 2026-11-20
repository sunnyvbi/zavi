
import { HarnessFailure } from "@/services/eval/shadow-harness";
import type { Provider } from "@/services/llm/models";
import type { OpenRouterVerdict } from "@/services/llm/openrouter";
import type { TaskFixture } from "./fixtures";
import type { ManifestEntry } from "./manifest";
import {
  attributeTrialFailure,
  reservationFor,
  withBenchRetries,
  type AttemptResult,
  type SpendLedger,
  type TrialOutcomeKind,
} from "./spend";

export type TrialToolCall = { name: string; code?: string; status?: string };

export type TrialRaw = {
  output_text: string | null;
  parse_ok: boolean;
  tool_calls: TrialToolCall[];
  route_verdict: OpenRouterVerdict | "sdk";
  surfaced_tools?: string[];
  code_diff?: string;
  engineer_checks?: {
    typecheck_ok: boolean | null;
    typecheck_verified: boolean | null;
    tests_failed: number | null;
  };
};

export type TrialRequest = { fixture: TaskFixture; model: ManifestEntry; trial: number };

export type RunTrialFn = (req: TrialRequest) => Promise<AttemptResult<TrialRaw>>;

export type TrialResult = {
  task_id: string;
  unit: string;
  cohort: TaskFixture["cohort"];
  company: string;
  model_key: string;
  trial: number;
  outcome: TrialOutcomeKind | "discarded_unpinned" | "capped";
  raw: TrialRaw | null;
  billedUsd: number;
  attempts: number;
  error?: string;
  harness_sha?: string;
  model_id?: string;
  upstream?: string | null;
  fixture_version?: number;
};

class Semaphore {
  private waiters: Array<() => void> = [];
  constructor(private free: number) {}
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release(): void {
    const w = this.waiters.shift();
    if (w) w();
    else this.free++;
  }
}

export type RunTrialsOptions = {
  fixtures: ReadonlyArray<TaskFixture>;
  model: ManifestEntry;
  trials: number;
  concurrency: number;
  sandboxConcurrency: number;
  ledger: SpendLedger;
  runTrial: RunTrialFn;
  provider: Provider;
  sleep?: (ms: number) => Promise<void>;
};

export async function runTrials(o: RunTrialsOptions): Promise<TrialResult[]> {
  if (!(o.trials >= 1) || !(o.concurrency >= 1) || !(o.sandboxConcurrency >= 1)) {
    throw new HarnessFailure("trials, concurrency and sandbox concurrency must be >= 1");
  }
  const units: TrialRequest[] = [];
  for (const fixture of o.fixtures) {
    for (let t = 1; t <= o.trials; t++) units.push({ fixture, model: o.model, trial: t });
  }
  const sandboxes = new Semaphore(o.sandboxConcurrency);
  const results: TrialResult[] = [];
  let next = 0;
  let stop = false;
  let abort: unknown = null;

  const worker = async () => {
    while (!stop && abort === null) {
      const i = next++;
      if (i >= units.length) return;
      const req = units[i];
      const slug = req.fixture.agent_slug;
      const needsBox = slug === "engineer";
      if (needsBox) await sandboxes.acquire();
      try {
        const out = await withBenchRetries(() => o.runTrial(req), {
          provider: o.provider,
          sleep: o.sleep,
          reserve: {
            ledger: o.ledger,
            usd: reservationFor("run", slug, req.fixture.cohort),
            label: `run:${req.fixture.task_id}#${req.trial}`,
          },
        });
        if (out.kind === "capped") {
          stop = true;
          if (out.attempts === 0) continue;
        }
        const base = {
          task_id: req.fixture.task_id,
          unit: req.fixture.unit,
          cohort: req.fixture.cohort,
          company: req.fixture.company,
          model_key: req.model.key,
          trial: req.trial,
          billedUsd: out.billedUsd,
          attempts: out.attempts,
        };
        if (out.kind === "ok") {
          if (out.value.route_verdict === "no_usage_cost") {
            throw new HarnessFailure(
              `${req.model.key}: responses carry no usage/pricing; refusing the model (D9)`,
            );
          }
          results.push({
            ...base,
            outcome: out.value.route_verdict === "unpinned_route" ? "discarded_unpinned" : "completed",
            raw: out.value,
          });
        } else if (out.kind === "infra") {
          results.push({ ...base, outcome: "infra", raw: null, error: out.error });
        } else if (out.kind === "capped") {
          results.push({ ...base, outcome: "capped", raw: null, error: out.error });
        } else {
          results.push({
            ...base,
            outcome: attributeTrialFailure(out.error, o.provider),
            raw: null,
            error: (out.error as Error)?.message ?? String(out.error),
          });
        }
      } catch (e) {
        abort = e;
      } finally {
        if (needsBox) sandboxes.release();
      }
    }
  };

  await Promise.all(Array.from({ length: o.concurrency }, () => worker()));
  if (abort !== null) {
    throw abort instanceof HarnessFailure
      ? abort
      : new HarnessFailure(`bench aborted: ${(abort as Error)?.message ?? String(abort)}`);
  }
  return results.sort((a, b) =>
    a.task_id === b.task_id ? a.trial - b.trial : a.task_id < b.task_id ? -1 : 1,
  );
}
