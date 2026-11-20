
import type { CreateAdSetBody } from "@/services/tools/meta-ads/write/_decision-bodies";
import type { MarketFitVerdict } from "./constants";
import { PENDING_STRATEGIST_CLASS } from "./constants";
import { isPendingStrategistBody } from "./pending-body";
import { reconstructCreateBody, buildVerdictAnnotation } from "./reconstruct";

export type ParkedDecision = {
  id: string;
  tenant_id: string;
  decision_class: string;
  body: Record<string, unknown>;
  agent_run_id: string | null;
  status: string;
};

export type ResolveVerdictInput = {
  pending_decision_id: string;
  tenant_id: string;
  verdict: MarketFitVerdict;
  reason: string;
  review_run_id?: string | null;
};

export type ResolveVerdictDeps = {
  claimForResolve: (pendingDecisionId: string, tenantId: string) => Promise<boolean>;
  getParkedDecision: (
    pendingDecisionId: string,
    tenantId: string,
  ) => Promise<ParkedDecision | null>;
  findExistingFinalCreate: (
    pendingDecisionId: string,
    tenantId: string,
  ) => Promise<{ id: string } | null>;
  emitFinalCreate: (args: {
    tenant_id: string;
    agent_run_id: string | null;
    body: Record<string, unknown>;
  }) => Promise<string>;
  finalizeApproved: (
    pendingDecisionId: string,
    tenantId: string,
    finalDecisionId: string,
  ) => Promise<boolean>;
  finalizeBounced: (
    pendingDecisionId: string,
    tenantId: string,
    reason: string,
  ) => Promise<boolean>;
  recoverApproved: (
    pendingDecisionId: string,
    tenantId: string,
    finalDecisionId: string,
  ) => Promise<boolean>;
  supersedeFailureNotice: (pendingDecisionId: string, tenantId: string) => Promise<void>;
  releaseClaim: (pendingDecisionId: string, tenantId: string) => Promise<void>;
  log: (evt: {
    level: "info" | "warn";
    code: string;
    tenant_id: string;
    meta?: Record<string, unknown>;
  }) => Promise<void>;
};

export type ResolveVerdictResult =
  | { ok: true; outcome: "approved"; final_decision_id: string }
  | { ok: true; outcome: "bounced" }
  | {
      ok: false;
      outcome:
        | "lost_race"
        | "parked_missing"
        | "wrong_class"
        | "reconstruct_failed"
        | "emit_failed";
    };

export async function resolveMarketFitVerdict(
  input: ResolveVerdictInput,
  deps: ResolveVerdictDeps,
): Promise<ResolveVerdictResult> {
  const { pending_decision_id, tenant_id, verdict } = input;
  const reason = (input.reason ?? "").trim().slice(0, 500);

  const won = await deps.claimForResolve(pending_decision_id, tenant_id);
  if (!won) {
    await deps.log({
      level: "info",
      code: "strategist_review_claim_lost",
      tenant_id,
      meta: { pending_decision_id },
    });
    return { ok: false, outcome: "lost_race" };
  }

  const parked = await deps.getParkedDecision(pending_decision_id, tenant_id);
  if (!parked) {
    await deps.releaseClaim(pending_decision_id, tenant_id);
    await deps.log({
      level: "warn",
      code: "strategist_review_parked_missing",
      tenant_id,
      meta: { pending_decision_id },
    });
    return { ok: false, outcome: "parked_missing" };
  }

  if (parked.decision_class !== PENDING_STRATEGIST_CLASS || !isPendingStrategistBody(parked.body)) {
    await deps.releaseClaim(pending_decision_id, tenant_id);
    await deps.log({
      level: "warn",
      code: "strategist_review_wrong_class",
      tenant_id,
      meta: { pending_decision_id, decision_class: parked.decision_class },
    });
    return { ok: false, outcome: "wrong_class" };
  }

  if (verdict === "bounce") {
    const flipped = await deps.finalizeBounced(pending_decision_id, tenant_id, reason);
    await deps.log({
      level: "info",
      code: flipped ? "strategist_review_bounced" : "strategist_review_bounce_noop",
      tenant_id,
      meta: { pending_decision_id },
    });
    return { ok: true, outcome: "bounced" };
  }

  const existing = await deps.findExistingFinalCreate(pending_decision_id, tenant_id);
  let finalDecisionId: string;
  if (existing) {
    finalDecisionId = existing.id;
    await deps.log({
      level: "info",
      code: "strategist_review_emit_idempotent_hit",
      tenant_id,
      meta: { pending_decision_id, final_decision_id: finalDecisionId },
    });
  } else {
    const createBody: CreateAdSetBody | null = reconstructCreateBody(parked.body);
    if (!createBody) {
      await deps.releaseClaim(pending_decision_id, tenant_id);
      await deps.log({
        level: "warn",
        code: "strategist_review_reconstruct_failed",
        tenant_id,
        meta: { pending_decision_id },
      });
      return { ok: false, outcome: "reconstruct_failed" };
    }
    const finalBody: Record<string, unknown> = {
      ...createBody,
      strategist_verdict: buildVerdictAnnotation(reason),
      strategist_gate: { origin_pending_decision_id: pending_decision_id },
    };
    try {
      finalDecisionId = await deps.emitFinalCreate({
        tenant_id,
        agent_run_id: parked.agent_run_id,
        body: finalBody,
      });
    } catch (e) {
      await deps.releaseClaim(pending_decision_id, tenant_id);
      await deps.log({
        level: "warn",
        code: "strategist_review_emit_failed",
        tenant_id,
        meta: { pending_decision_id, error: (e as Error).message },
      });
      return { ok: false, outcome: "emit_failed" };
    }
  }

  const flipped = await deps.finalizeApproved(pending_decision_id, tenant_id, finalDecisionId);
  if (!flipped) {
    await deps.recoverApproved(pending_decision_id, tenant_id, finalDecisionId);
  }
  await deps.supersedeFailureNotice(pending_decision_id, tenant_id);
  await deps.log({
    level: "info",
    code: flipped ? "strategist_review_approved" : "strategist_review_approved_reconciled",
    tenant_id,
    meta: { pending_decision_id, final_decision_id: finalDecisionId },
  });
  return { ok: true, outcome: "approved", final_decision_id: finalDecisionId };
}
