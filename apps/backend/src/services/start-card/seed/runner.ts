
import type { StartCardRow, SeedClaimResult } from "../store";
import type { ReserveOutcome } from "./store";
import type { SeedStages } from "./run-card";
import type { StartCardScore } from "@zavi/shared";

export const RESERVE_USD = 1.0;

export type ItemOutcome = "done" | "skipped" | "failed" | "cap_reached" | "run_closed";

export type RunnerDeps = {
  admit: (domain: string) => Promise<{ ok: true; domain: string } | { ok: false; reason: string }>;
  reserve: (runId: string, domain: string, usd: number) => Promise<ReserveOutcome>;
  settle: (runId: string, domain: string, actualUsd: number) => Promise<void>;
  claim: (input: { run_id: string; domain: string }) => Promise<SeedClaimResult>;
  getCard: (id: string) => Promise<Pick<StartCardRow, "id" | "domain" | "locale" | "parts" | "status" | "revoked_at"> | null>;
  runCard: (card: Pick<StartCardRow, "id" | "domain" | "locale" | "parts">, stages: SeedStages) => Promise<{ cost_usd: number; score: StartCardScore }>;
  finish: (cardId: string, costUsd: number) => Promise<void>;
  fail: (cardId: string, reason: string) => Promise<void>;
  setItem: (runId: string, domain: string, patch: { state: string; card_id?: string | null; reason?: string | null; attempts?: number }) => Promise<void>;
  log: (line: string) => void;
};

export type SeedItem = { domain: string; attempts: number; card_id?: string | null };

export async function runSeedItem(runId: string, item: SeedItem, stages: SeedStages, d: RunnerDeps): Promise<ItemOutcome> {
  const domain = item.domain;
  const resumedItem = Boolean(item.card_id);
  if (!resumedItem) {
    const admitted = await d.admit(domain);
    if (!admitted.ok) {
      await d.setItem(runId, domain, { state: "skipped", reason: admitted.reason });
      return "skipped";
    }
    if (admitted.domain !== domain) {
      await d.setItem(runId, domain, { state: "skipped", reason: "domain_mismatch" });
      return "skipped";
    }
  }

  const r = await d.reserve(runId, domain, RESERVE_USD);
  if (r === "cap_reached") return "cap_reached";
  if (r === "settled") {
    await d.setItem(runId, domain, { state: "done" });
    return "done";
  }

  const c = await d.claim({ run_id: runId, domain });
  if (c.outcome === "run_closed") {
    await d.settle(runId, domain, resumedItem ? RESERVE_USD : 0);
    return "run_closed";
  }
  if (c.outcome === "suppressed" || c.outcome === "not_reserved") {
    await d.settle(runId, domain, resumedItem ? RESERVE_USD : 0);
    await d.setItem(runId, domain, { state: "skipped", reason: c.outcome });
    return "skipped";
  }

  if (!("id" in c)) return "skipped";
  const card = await d.getCard(c.id);
  if (!card || card.revoked_at) {
    await d.settle(runId, domain, resumedItem ? RESERVE_USD : 0);
    await d.setItem(runId, domain, { state: "skipped", card_id: c.id, reason: "card_removed" });
    return "skipped";
  }
  await d.setItem(runId, domain, { state: "running", card_id: card.id, attempts: item.attempts + 1 });

  if (card.status === "done") {
    await d.settle(runId, domain, RESERVE_USD);
    await d.setItem(runId, domain, { state: "done", card_id: card.id });
    return "done";
  }
  if (card.status !== "running") {
    await d.settle(runId, domain, RESERVE_USD);
    await d.setItem(runId, domain, { state: "failed", card_id: card.id, reason: `card_${card.status}` });
    return "failed";
  }

  const parts = (card.parts ?? {}) as Record<string, { state?: string } | undefined>;
  const resumed = resumedItem || Object.values(parts).some((p) => p?.state && p.state !== "pending");

  let res: { cost_usd: number };
  try {
    res = await d.runCard(card, stages);
  } catch (e) {
    const reason = ((e as Error)?.message ?? "error").slice(0, 120);
    d.log(`[seed-scan] ${domain} failed: ${reason}`);
    await d.fail(card.id, "seed_failed").catch(() => {});
    await d.settle(runId, domain, RESERVE_USD).catch(() => {});
    await d.setItem(runId, domain, { state: "failed", card_id: card.id, reason });
    return "failed";
  }
  await d.finish(card.id, res.cost_usd);
  await d.settle(runId, domain, resumed ? Math.max(RESERVE_USD, res.cost_usd) : res.cost_usd);
  await d.setItem(runId, domain, { state: "done", card_id: card.id });
  return "done";
}

export type LoopDeps = RunnerDeps & {
  pending: (runId: string, limit: number) => Promise<SeedItem[]>;
  takeLease: (runId: string) => Promise<boolean>;
  memoryFreePct: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
};

export type LoopSummary = {
  done: number;
  skipped: number;
  failed: number;
  stopped: "finished" | "cap_reached" | "run_closed" | "lease_lost" | "stopped" | "error";
};

export const MIN_FREE_MEMORY_PCT = 15;

export async function runSeedLoop(
  runId: string,
  stages: SeedStages,
  d: LoopDeps,
  opts: { concurrency: number; maxAttempts: number; renewMs?: number },
): Promise<LoopSummary> {
  const sum: LoopSummary = { done: 0, skipped: 0, failed: 0, stopped: "finished" };
  if (!(await d.takeLease(runId))) return { ...sum, stopped: "lease_lost" };
  let lost = false;
  let renewing: Promise<unknown> | null = null;
  const hb = setInterval(() => {
    if (renewing) return;
    renewing = d
      .takeLease(runId)
      .then((ok) => { if (!ok) lost = true; }, () => { lost = true; })
      .finally(() => { renewing = null; });
  }, opts.renewMs ?? 5 * 60_000);
  try {
    for (;;) {
      if (lost) return { ...sum, stopped: "lease_lost" };
      if (d.shouldStop()) return { ...sum, stopped: "stopped" };
      while ((await d.memoryFreePct()) < MIN_FREE_MEMORY_PCT) {
        d.log(`[seed-scan] free memory under ${MIN_FREE_MEMORY_PCT}%: pausing`);
        if (d.shouldStop()) return { ...sum, stopped: "stopped" };
        if (lost) return { ...sum, stopped: "lease_lost" };
        await d.sleep(60_000);
      }
      if (lost) return { ...sum, stopped: "lease_lost" };
      const pending = await d.pending(runId, opts.concurrency * 4);
      let closed = 0;
      for (const i of pending.filter((p) => p.attempts >= opts.maxAttempts)) {
        try {
          if (i.card_id) await d.fail(i.card_id, "seed_max_attempts");
          await d.settle(runId, i.domain, i.card_id ? RESERVE_USD : 0);
          await d.setItem(runId, i.domain, { state: "failed", reason: "max_attempts" });
          sum.failed++;
          closed++;
        } catch (e) {
          d.log(`[seed-scan] ${i.domain}: could not close after max attempts (${((e as Error)?.message ?? "").slice(0, 120)}); retried next pass`);
        }
      }
      const exhausted = pending.filter((p) => p.attempts >= opts.maxAttempts).length;
      if (exhausted > 0 && closed === 0) return { ...sum, stopped: "error" };
      const batch = pending.filter((i) => i.attempts < opts.maxAttempts).slice(0, opts.concurrency);
      if (batch.length === 0 && pending.length > 0) continue;
      if (batch.length === 0) return sum;

      const settled = await Promise.allSettled(batch.map((i) => runSeedItem(runId, i, stages, d)));
      const outcomes: ItemOutcome[] = [];
      let errors = 0;
      for (const [n, r] of settled.entries()) {
        if (r.status === "fulfilled") outcomes.push(r.value);
        else {
          errors++;
          d.log(`[seed-scan] ${batch[n].domain}: ${((r.reason as Error)?.message ?? "error").slice(0, 160)} (left for the next pass)`);
        }
      }
      for (const o of outcomes) {
        if (o === "done") sum.done++;
        else if (o === "skipped") sum.skipped++;
        else if (o === "failed") sum.failed++;
      }
      if (lost) return { ...sum, stopped: "lease_lost" };
      if (outcomes.includes("run_closed")) return { ...sum, stopped: "run_closed" };
      if (outcomes.includes("cap_reached")) return { ...sum, stopped: "cap_reached" };
      if (errors === batch.length) return { ...sum, stopped: "error" };
    }
  } finally {
    clearInterval(hb);
    if (renewing) await renewing;
  }
}
