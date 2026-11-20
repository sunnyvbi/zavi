
import type {
  StartCardDiagnosisEvidence,
  StartCardPart,
  StartCardPartKey,
  StartCardParts,
  StartCardProfileEvidence,
} from "@zavi/shared";
import { logEvent } from "@/services/logging/logEvent";
import { workspaceUrl } from "@/services/web-base";
import { sendStartCardReadyEmail } from "@/email/sendAuthEmail";
import { releaseCardBudget, settleCardBudget } from "./budget";
import {
  deleteQueueRow,
  detachQueueRow,
  getCardById,
  listQueueRowsForCard,
  setCardPart,
  updateCard,
  type StartCardRow,
} from "./store";
import { StageUnavailableError, type StageContext, type StageOutcome } from "./stages";
import { asVisitorCountry } from "./checks/country";
import { withVendorContext } from "@/services/vendors/usage";

export type StageResult = { part: StartCardPart<unknown>; cost_usd: number };

export async function executeStage<E>(
  key: StartCardPartKey,
  fn: (ctx: StageContext) => Promise<StageOutcome<E>>,
  ctx: StageContext,
): Promise<StageResult> {
  const started = Date.now();
  const fetched_at = () => new Date().toISOString();
  try {
    const out = await fn(ctx);
    const part: StartCardPart<unknown> = {
      state: "done",
      evidence: out.evidence as unknown,
      ...(typeof out.points === "number" ? { points: out.points } : {}),
      ...(typeof out.max_points === "number" ? { max_points: out.max_points } : {}),
      fetched_at: fetched_at(),
    };
    logStage(key, "done", out.cost_usd, Date.now() - started);
    return { part, cost_usd: safeCost(out.cost_usd) };
  } catch (e) {
    const unavailable = e instanceof StageUnavailableError;
    const reason = unavailable ? e.reason.slice(0, 64) : "stage_error";
    const cost = unavailable ? safeCost(e.cost_usd) : 0;
    if (!unavailable) {
      console.error(`[start-card] stage ${key} threw: ${(e as Error)?.message?.slice(0, 300)}`);
    }
    logStage(key, `unavailable:${reason}`, cost, Date.now() - started);
    return {
      part: { state: "unavailable", evidence: null, unavailable_reason: reason, fetched_at: fetched_at() },
      cost_usd: cost,
    };
  }
}

function safeCost(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function logStage(key: string, outcome: string, cost: number, ms: number): void {
  void logEvent({
    level: "info",
    source: "start_card",
    code: `stage_${key}`.slice(0, 64),
    message: `start_card.stage key=${key} outcome=${outcome} est_cost_usd=${safeCost(cost).toFixed(4)} ms=${ms}`,
    meta: { ms },
  });
}

export async function runAndWriteStage<E>(
  key: StartCardPartKey,
  fn: (ctx: StageContext) => Promise<StageOutcome<E>>,
  ctx: StageContext,
): Promise<StageResult> {
  const result = await withVendorContext({ tenant_id: ctx.funding_tenant_id ?? null, source: "start_card" }, () =>
    executeStage(key, fn, ctx),
  );
  await setCardPart(ctx.card_id, key, result.part);
  return result;
}

export async function applyProfileToRow(cardId: string, profile: StartCardProfileEvidence | null): Promise<void> {
  if (!profile) return;
  await updateCard(cardId, { search_term: profile.search_term || null, locale: profile.country });
}

export function contextFor(
  row: Pick<StartCardRow, "id" | "domain"> & { locale?: string | null; funding_tenant_id?: string | null },
  parts: StartCardParts,
): StageContext {
  const profile = parts.profile?.state === "done" ? (parts.profile.evidence as StartCardProfileEvidence) : null;
  return {
    card_id: row.id,
    domain: row.domain,
    url: `https://${row.domain}/`,
    profile,
    parts,
    visitor_country: asVisitorCountry(row.locale),
    funding_tenant_id: row.funding_tenant_id ?? null,
  };
}

function isTenantFunded(row: Pick<StartCardRow, "funding_kind">): boolean {
  return row.funding_kind === "tenant_credits";
}

export async function finishCard(cardId: string, costUsd: number): Promise<void> {
  const row = await getCardById(cardId);
  if (!row || row.status !== "running") return;
  const spent = Number(costUsd.toFixed(4));
  await updateCard(cardId, { status: "done", spent_usd: spent });
  if (!isTenantFunded(row) && row.budget_day) {
    await settleCardBudget(row.budget_day, Number(row.reserved_usd), spent);
  }
  void logEvent({
    level: "info",
    source: "start_card",
    code: "card_done",
    message: `start_card.done funding=${row.funding_kind ?? "public_budget"} est_cost_usd=${spent.toFixed(4)} reserved_usd=${Number(row.reserved_usd).toFixed(4)}`,
  });
}

export async function failCard(cardId: string, reason: string): Promise<void> {
  const row = await getCardById(cardId);
  if (!row || row.status !== "running") return;
  await updateCard(cardId, { status: "failed", error: reason.slice(0, 200), spent_usd: Number(row.reserved_usd) });
}

export async function cancelCard(cardId: string, reason: string): Promise<void> {
  const row = await getCardById(cardId);
  if (!row || row.status !== "running") return;
  const started = Object.values(row.parts ?? {}).some((p) => p && p.state !== "pending");
  if (started) {
    await updateCard(cardId, { status: "failed", error: reason.slice(0, 200), spent_usd: Number(row.reserved_usd) });
    return;
  }
  await updateCard(cardId, { status: "failed", error: reason.slice(0, 200) });
  if (!isTenantFunded(row) && row.budget_day) await releaseCardBudget(row.budget_day, Number(row.reserved_usd));
}

async function releaseDeadCardRows(card: Pick<StartCardRow, "id" | "status" | "revoked_at" | "created_at">): Promise<void> {
  for (const q of await listQueueRowsForCard(card.id)) {
    const retry = !card.revoked_at && card.status === "failed" && Date.parse(card.created_at) < Date.parse(q.created_at);
    try {
      if (retry) await detachQueueRow(q.id);
      else await deleteQueueRow(q.id);
    } catch (e) {
      console.error(`[start-card] dead card row cleanup failed: ${(e as Error)?.message?.slice(0, 200)}`);
    }
  }
}

export async function sendQueuedCardEmails(cardId: string): Promise<{ sent: number; failed: number }> {
  const row = await getCardById(cardId);
  if (row && (row.revoked_at || row.status === "failed")) {
    await releaseDeadCardRows(row);
    return { sent: 0, failed: 0 };
  }
  if (!row || row.status !== "done") return { sent: 0, failed: 0 };
  const rows = await listQueueRowsForCard(cardId);
  const diagnosis = row.parts?.diagnosis?.state === "done" ? (row.parts.diagnosis.evidence as StartCardDiagnosisEvidence) : null;
  const profile = row.parts?.profile?.state === "done" ? (row.parts.profile.evidence as StartCardProfileEvidence | null) : null;
  let sent = 0;
  let failed = 0;
  for (const q of rows) {
    try {
      const r = await sendStartCardReadyEmail({
        email: q.email,
        domain: row.domain,
        strategyUrl: `${workspaceUrl()}?tab=growth-strategy`,
        card: { score: row.score ?? null, diagnosis, companyName: profile?.company_name ?? null },
      });
      if (!r.sent) {
        failed++;
        continue;
      }
      await deleteQueueRow(q.id);
      sent++;
    } catch (e) {
      failed++;
      console.error(`[start-card] card email failed: ${(e as Error)?.message?.slice(0, 200)}`);
    }
  }
  return { sent, failed };
}
