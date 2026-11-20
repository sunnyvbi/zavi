
import { createHash } from "node:crypto";
import { serviceClient } from "@/services/supabase";
import { writeNote } from "@/services/memory";
import { inngest } from "@/../workers/client";
import { loadGlobalAgentDefinition } from "@/services/agents/registry";

function autoBakeThreshold(): number {
  const raw = Number(process.env.ADMIN_CORRECTION_AUTOBAKE_N);
  if (!Number.isFinite(raw)) return 3;
  return Math.max(2, Math.floor(raw));
}

const BAKE_DECISION_CLASS = "proposed_rule";
const BAKE_HANDLER = "praxis.bake_rule";

export type AdminCorrectionAction = "edit" | "reject";

export type StaffActor = { user_id: string; email?: string };

export type CorrectionActorKind = "staff" | "customer";

export type CaptureAdminCorrectionInput = {
  tenant_id: string;
  decision_id: string;
  decision_class: string;
  actor: StaffActor;
  actor_kind?: CorrectionActorKind;
  action: AdminCorrectionAction;
  before_body?: Record<string, unknown> | null;
  after_body?: Record<string, unknown> | null;
  reason?: string | null;
};

export type CaptureAdminCorrectionResult = {
  captured: boolean;
  note_id?: string;
  occurrence_count?: number;
  baked?: boolean;
  bake_decision_id?: string;
};

function slugFromDecisionClass(decisionClass: string): string {
  return (decisionClass.split(".")[0] ?? "").trim();
}

function normalizeKey(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[`*_#>~]/g, "")
    .trim()
    .slice(0, 2000);
}

function correctionKey(input: CaptureAdminCorrectionInput): string {
  if (input.action === "reject") {
    return `reject:${normalizeKey(input.reason ?? "")}`;
  }
  const before = input.before_body ?? {};
  const after = input.after_body ?? {};
  const changedKeys = Object.keys(after)
    .filter((k) => JSON.stringify(after[k]) !== JSON.stringify((before as Record<string, unknown>)[k]))
    .sort();
  if (changedKeys.length === 0) {
    return `edit:${normalizeKey(JSON.stringify(after))}`;
  }
  const parts = changedKeys.map((k) => `${k}=${normalizeKey(String(JSON.stringify(after[k])))}`);
  return `edit:${parts.join("|")}`;
}

function signatureFor(agentSlug: string, decisionClass: string, key: string): string {
  return createHash("sha256")
    .update(`${agentSlug}\n${decisionClass}\n${key}`)
    .digest("hex")
    .slice(0, 32);
}

function hasSemanticDelta(input: CaptureAdminCorrectionInput): boolean {
  if (input.action === "reject") {
    if ((input.actor_kind ?? "staff") === "customer") return true;
    const r = (input.reason ?? "").trim();
    return r.length > 0 && r !== "(no reason given)";
  }
  const before = JSON.stringify(input.before_body ?? {});
  const after = JSON.stringify(input.after_body ?? {});
  return after !== "{}" && after !== before;
}

function renderNoteBody(input: CaptureAdminCorrectionInput): string {
  const who = (input.actor_kind ?? "staff") === "customer" ? "The customer" : "Staff";
  if (input.action === "reject") {
    return [
      `${who} REJECTED a proposed \`${input.decision_class}\` action.`,
      ``,
      `Reason: ${input.reason ?? "(no reason given)"}`,
      ``,
      `Lesson: do not propose this action in this situation again.`,
    ].join("\n");
  }
  const before = JSON.stringify(input.before_body ?? {}, null, 2);
  const after = JSON.stringify(input.after_body ?? {}, null, 2);
  return [
    `${who} CORRECTED a proposed \`${input.decision_class}\` action before approving it.`,
    ``,
    `Before (what the agent proposed):`,
    "```json",
    before.slice(0, 4000),
    "```",
    ``,
    `After (the corrected version staff approved):`,
    "```json",
    after.slice(0, 4000),
    "```",
    ``,
    `Lesson: prefer the corrected shape next time.`,
  ].join("\n");
}

export async function captureAdminCorrection(
  input: CaptureAdminCorrectionInput,
): Promise<CaptureAdminCorrectionResult> {
  if (!hasSemanticDelta(input)) {
    return { captured: false };
  }

  const agentSlug = slugFromDecisionClass(input.decision_class);
  if (!agentSlug) {
    console.warn(
      `[capture-admin-correction] empty agent_slug from decision_class '${input.decision_class}'; skipping`,
    );
    return { captured: false };
  }

  const key = correctionKey(input);
  const signature = signatureFor(agentSlug, input.decision_class, key);
  const svc = serviceClient();
  const actorKind: CorrectionActorKind = input.actor_kind ?? "staff";

  let note_id: string | undefined;
  try {
    const res = await writeNote(input.tenant_id, {
      note_type: "agent_feedback",
      source: actorKind === "customer" ? "operator_feedback" : "praxis_staff",
      tags: [
        `agent:${agentSlug}`,
        "admin-correction",
        `decision:${input.decision_id}`,
        `actor:${actorKind}`,
        ...(input.actor.email ? [`${actorKind}:${input.actor.email}`] : [`${actorKind}-id:${input.actor.user_id}`]),
      ],
      body_markdown: renderNoteBody(input),
    });
    note_id = res.note_id;
  } catch (e) {
    console.warn(
      `[capture-admin-correction] writeNote failed for ${agentSlug}: ${(e as Error)?.message ?? e}`,
    );
  }

  let occurrence_count: number | undefined;
  try {
    const { data, error } = await svc.rpc("record_admin_correction", {
      p_tenant_id: input.tenant_id,
      p_agent_slug: agentSlug,
      p_signature: signature,
      p_decision_id: input.decision_id,
      p_decision_class: input.decision_class,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    occurrence_count = Number((row as { occurrence_count?: number })?.occurrence_count ?? 0);
  } catch (e) {
    console.warn(
      `[capture-admin-correction] record_admin_correction failed for ${agentSlug}: ${(e as Error)?.message ?? e}`,
    );
  }

  try {
    const afterBody =
      input.action === "reject"
        ? { should_not_emit: true, decision_class: input.decision_class }
        : input.after_body ?? {};
    await svc.rpc("record_admin_correction_eval_case", {
      p_tenant_id: input.tenant_id,
      p_agent_slug: agentSlug,
      p_decision_class: input.decision_class,
      p_signature: signature,
      p_before_body: input.before_body ?? {},
      p_after_body: afterBody,
      p_rationale: input.action === "reject" ? input.reason ?? null : "staff edit",
      p_decision_id: input.decision_id,
    });
  } catch (e) {
    console.warn(
      `[capture-admin-correction] record_admin_correction_eval_case failed for ${agentSlug}: ${(e as Error)?.message ?? e}`,
    );
  }

  let baked = false;
  let bake_decision_id: string | undefined;
  if (
    actorKind !== "customer" &&
    occurrence_count !== undefined &&
    occurrence_count === autoBakeThreshold() &&
    loadGlobalAgentDefinition(agentSlug)
  ) {
    try {
      const r = await proposeAutoBake(input.tenant_id, agentSlug, signature, input);
      baked = r.baked;
      bake_decision_id = r.decision_id;
    } catch (e) {
      console.warn(
        `[capture-admin-correction] auto-bake failed for ${agentSlug}: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  return { captured: true, note_id, occurrence_count, baked, bake_decision_id };
}

async function proposeAutoBake(
  tenantId: string,
  agentSlug: string,
  signature: string,
  input: CaptureAdminCorrectionInput,
): Promise<{ baked: boolean; decision_id?: string }> {
  const svc = serviceClient();
  const idemKey = `admin-correction:${signature}`;

  const { data: claimed, error: claimErr } = await svc.rpc("claim_admin_correction_bake", {
    p_tenant_id: tenantId,
    p_agent_slug: agentSlug,
    p_signature: signature,
  });
  if (claimErr) throw new Error(claimErr.message);
  if (claimed !== true) {
    return { baked: false };
  }

  const ruleBody =
    input.action === "reject"
      ? `Do not propose ${input.decision_class} actions in situations like the one staff repeatedly rejected. Reason given: ${(input.reason ?? "(no reason given)").slice(0, 600)}`
      : `When proposing ${input.decision_class}, prefer the corrected shape staff have repeatedly applied (see standing operator/staff feedback for the before/after).`;

  const { data: inserted, error: insErr } = await svc
    .from("decisions")
    .insert({
      tenant_id: tenantId,
      agent_run_id: null,
      decision_class: BAKE_DECISION_CLASS,
      body: {
        rule_body_markdown: ruleBody.slice(0, 1500),
        target_agent_slug: agentSlug,
        origin: "admin_correction_auto_bake",
        bake_idem_key: idemKey,
      },
      status: "proposed",
      autonomy_at_emit: "approval",
      handler: BAKE_HANDLER,
    })
    .select("id")
    .single<{ id: string }>();
  if (insErr || !inserted) {
    try {
      await svc
        .from("admin_correction_bake_claims")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("agent_slug", agentSlug)
        .eq("signature", signature);
    } catch {
    }
    throw new Error(insErr?.message ?? "auto-bake insert failed: no id");
  }
  return { baked: true, decision_id: inserted.id };
}
