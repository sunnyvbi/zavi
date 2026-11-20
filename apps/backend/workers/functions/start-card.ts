
import { inngest } from "../client";
import { getBoolSetting } from "@/services/settings";
import type { StartCardParts, StartCardPartKey, StartCardProfileEvidence } from "@zavi/shared";
import {
  applyProfileToRow,
  contextFor,
  cancelCard,
  failCard,
  finishCard,
  runAndWriteStage,
  sendQueuedCardEmails,
  type StageResult,
} from "@/services/start-card/pipeline";
import {
  SCORER_VERSION,
  runAiStage,
  runCompareStage,
  runDesignStage,
  runDiagnosisStage,
  runGoogleStage,
  runProfileStage,
  runSeoStage,
  scoreCard,
  type StageContext,
  type StageOutcome,
} from "@/services/start-card/stages";
import { drainQueue, retentionCutoffIso } from "@/services/start-card/queue";
import {
  getCardById,
  isTenantFunded,
  listUnsettledTenantCards,
  purgeStaleQueueRows,
  updateCard,
} from "@/services/start-card/store";
import { TENANT_SETTLE_EVENT, kickTenantSettle } from "@/services/start-card/site-check-funding";
import { settleTenantCardFlow } from "@/services/start-card/site-check-settle";
import { tenantCardStartBlock } from "@/services/start-card/site-check-tool";

const PARALLEL_CHECKS: ReadonlyArray<readonly [StartCardPartKey, (ctx: StageContext) => Promise<StageOutcome<unknown>>]> = [
  ["google", runGoogleStage],
  ["ai", runAiStage],
  ["seo", runSeoStage],
  ["design", runDesignStage],
];

export const startCardFn = inngest.createFunction(
  {
    id: "start-card",
    retries: 2,
    idempotency: "event.data.card_id",
    concurrency: [{ limit: 10 }],
    onFailure: async ({ event, error }) => {
      const cardId = (event.data.event.data as { card_id?: string }).card_id;
      if (!cardId) return;
      console.error(`[start-card] worker failed for card: ${error?.message?.slice(0, 200)}`);
      await failCard(cardId, "worker_failed");
      await kickTenantSettleIfTenant(cardId).catch((e: Error) =>
        console.warn(`[start-card] tenant settle kick failed: ${e.message?.slice(0, 200)}`),
      );
    },
  },
  { event: "start-card/requested" },
  async ({ event, step }) => {
    const cardId = event.data.card_id;
    if (typeof cardId !== "string" || !cardId) return { status: "skip", reason: "no_card_id" };

    const card = await step.run("load-card", async () => {
      const row = await getCardById(cardId);
      return row
        ? {
            id: row.id,
            domain: row.domain,
            locale: row.locale,
            status: row.status,
            revoked: !!row.revoked_at,
            tenant: isTenantFunded(row),
            funding_tenant_id: isTenantFunded(row) ? (row.funding_tenant_id ?? null) : null,
          }
        : null;
    });
    if (!card) return { status: "skip", reason: "card_not_found" };
    if (card.status !== "running" || card.revoked) return { status: "skip", reason: `card_${card.status}` };

    const enabled = await getBoolSetting("start_card_enabled");
    if (!enabled) {
      await step.run("cancel", () => cancelCard(card.id, "disabled"));
      if (card.tenant) await step.sendEvent("tenant-settle", { name: TENANT_SETTLE_EVENT, data: { card_id: card.id } });
      return { status: "skip", reason: "disabled" };
    }

    if (card.tenant) {
      const block = await step.run("tenant-gate", async () => {
        const row = await getCardById(card.id);
        return row ? tenantCardStartBlock(row) : "run_stopped";
      });
      if (block) {
        await step.run("cancel-tenant", () => cancelCard(card.id, block));
        await step.sendEvent("tenant-settle-blocked", { name: TENANT_SETTLE_EVENT, data: { card_id: card.id } });
        return { status: "skip", reason: block };
      }
    }

    const parts: StartCardParts = {};
    let cost = 0;
    const take = (key: StartCardPartKey, r: StageResult) => {
      (parts as Record<string, unknown>)[key] = r.part;
      cost += r.cost_usd;
    };

    const profile = (await step.run("stage-profile", async () => {
      const r = await runAndWriteStage("profile", runProfileStage, contextFor(card, {}));
      if (r.part.state === "done") await applyProfileToRow(card.id, r.part.evidence as StartCardProfileEvidence);
      return r;
    })) as StageResult;
    take("profile", profile);

    const checks = (await Promise.all(
      PARALLEL_CHECKS.map(([key, fn]) =>
        step.run(`stage-${key}`, () => runAndWriteStage(key, fn, contextFor(card, parts))),
      ),
    )) as StageResult[];
    PARALLEL_CHECKS.forEach(([key], i) => take(key, checks[i]));

    take(
      "compare",
      (await step.run("stage-compare", () =>
        runAndWriteStage("compare", runCompareStage, contextFor(card, parts)),
      )) as StageResult,
    );

    const score = await step.run("score", async () => {
      const s = scoreCard(parts);
      await updateCard(card.id, { score: s, scorer_version: SCORER_VERSION, evidence: { parts } });
      return s;
    });

    take(
      "diagnosis",
      (await step.run("stage-diagnosis", () =>
        runAndWriteStage("diagnosis", (ctx) => runDiagnosisStage({ ...ctx, score }), contextFor(card, parts)),
      )) as StageResult,
    );

    await step.run("finish", () => finishCard(card.id, cost));
    if (card.tenant) await step.sendEvent("tenant-settle", { name: TENANT_SETTLE_EVENT, data: { card_id: card.id } });

    const emailed = await step.run("email-queued", () => sendQueuedCardEmails(card.id));

    return { status: "done", total: score.total, out_of: score.out_of, cost_usd: Number(cost.toFixed(4)), emailed };
  },
);

export const startCardQueueDrainFn = inngest.createFunction(
  { id: "start-card-queue-drain", concurrency: 1, retries: 1 },
  [{ cron: "*/10 * * * *" }, { event: "start-card/queue.drain" }],
  async ({ step }) => {
    const enabled = await step.run("enabled", () => getBoolSetting("start_card_enabled"));
    if (!enabled) {
      const purged = await step.run("purge", () => purgeStaleQueueRows(retentionCutoffIso()));
      return { status: "skip", reason: "disabled", purged };
    }
    return step.run("drain", () => drainQueue());
  },
);

async function kickTenantSettleIfTenant(cardId: string): Promise<void> {
  const row = await getCardById(cardId);
  if (row && isTenantFunded(row)) await kickTenantSettle(cardId);
}

export const startCardTenantSettleFn = inngest.createFunction(
  {
    id: "start-card-tenant-settle",
    retries: 4,
    concurrency: [{ key: "event.data.card_id", limit: 1 }],
  },
  { event: TENANT_SETTLE_EVENT },
  async ({ event, step }) => {
    const cardId = (event.data as { card_id?: unknown }).card_id;
    if (typeof cardId !== "string" || !cardId) return { status: "skip", reason: "no_card_id" };
    return settleTenantCardFlow(cardId, {
      run: (id, fn) => step.run(id, fn) as never,
      sleep: (id, d) => step.sleep(id, d),
    });
  },
);

export const startCardTenantSettleSweepFn = inngest.createFunction(
  { id: "start-card-tenant-settle-sweep", concurrency: 1, retries: 1 },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const ids = await step.run("list", () =>
      listUnsettledTenantCards(new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), 25),
    );
    if (ids.length > 0) {
      await step.sendEvent(
        "kick",
        ids.map((id) => ({ name: TENANT_SETTLE_EVENT, data: { card_id: id } })),
      );
    }
    return { kicked: ids.length };
  },
);
