
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { enrichInvestorEmail, isSendableEmail } from "@/services/fundraising/enrich";
import { createManualOutreachTask } from "@/services/fundraising/manual-tasks";
import { decideOnDecision } from "@/services/approvals/decide-service";
import { withVendorContext } from "@/services/vendors/usage";

type AngelRoundRequestedEvent = {
  data: {
    tenant_id: string;
    run_id?: string | null;
    requested_by: string;
  };
};

type StrategyInvestor = {
  firm?: string | null;
  name?: string | null;
  channel_segment?: string | null;
  copy_variants?: {
    cold_email?: { subject?: string; body?: string } | null;
    linkedin_dm?: string | null;
    warm_intro_blurb?: string | null;
  } | null;
  contact_hint?: string | null;
};

type SendMode = "off" | "test" | "live";
async function loadSendMode(tenant_id: string): Promise<{
  send_mode: SendMode;
  updated_by: string | null;
}> {
  const { data, error } = await serviceClient()
    .from("fundraising_round_config")
    .select("send_mode, updated_by")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error || !data) return { send_mode: "off", updated_by: null };
  const row = data as { send_mode?: unknown; updated_by?: unknown };
  const mode =
    row.send_mode === "test" || row.send_mode === "live" ? row.send_mode : "off";
  const updatedBy =
    typeof row.updated_by === "string" && row.updated_by.length > 0
      ? row.updated_by
      : null;
  return { send_mode: mode, updated_by: updatedBy };
}

async function resolveFounderEmail(user_id: string): Promise<string | null> {
  try {
    const { data, error } = await serviceClient().auth.admin.getUserById(user_id);
    if (error) return null;
    const email = data?.user?.email;
    return typeof email === "string" && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

async function proposeFundraisingDecision(args: {
  tenant_id: string;
  strategy_run_id: string;
  investor_id_hint: string | null;
  recipient: string;
  subject: string;
  body_text: string;
  sender?: string;
  test_recipient?: string;
}): Promise<{ decision_id: string } | { error: string }> {
  const body = {
    recipient: args.recipient,
    channel: "email",
    subject: args.subject,
    body_text: args.body_text,
    ...(args.sender ? { sender: args.sender } : {}),
    strategy_run_id: args.strategy_run_id,
    ...(args.investor_id_hint ? { investor_id: args.investor_id_hint } : {}),
    ...(args.test_recipient ? { test_recipient: args.test_recipient } : {}),
  };
  const { data, error } = await serviceClient().rpc("emit_decision", {
    p_tenant_id: args.tenant_id,
    p_agent_run_id: args.strategy_run_id,
    p_decision_class: "fundraising.outbound.send",
    p_body: body as object,
  });
  if (error) {
    return { error: `emit_decision failed: ${error.message}` };
  }
  return { decision_id: data as string };
}

async function loadLatestStrategyRun(tenant_id: string): Promise<{
  run_id: string;
  investors: StrategyInvestor[];
} | null> {
  const svc = serviceClient();
  const { data, error } = await svc
    .from("agent_runs")
    .select("id, parsed")
    .eq("tenant_id", tenant_id)
    .eq("agent_slug", "fundraising")
    .eq("status", "success")
    .order("enqueued_at", { ascending: false })
    .limit(20);
  if (error || !Array.isArray(data)) return null;

  for (const row of data as Array<{ id: string; parsed: unknown }>) {
    const parsed = row.parsed as { mode?: unknown; investors?: unknown } | null;
    if (!parsed || parsed.mode !== "strategy") continue;
    if (!Array.isArray(parsed.investors) || parsed.investors.length === 0) continue;
    return { run_id: row.id, investors: parsed.investors as StrategyInvestor[] };
  }
  return null;
}

function extractDomain(contactHint: string): string | undefined {
  const trimmed = contactHint.trim();
  if (trimmed.includes("@")) {
    return trimmed.split("@")[1]?.split("?")[0]?.toLowerCase();
  }
  if (trimmed.includes(".") && !trimmed.includes(" ")) {
    return trimmed.toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  }
  return undefined;
}

export const fundraisingRunAngelRoundFn = inngest.createFunction(
  {
    id: "fundraising-run-angel-round",
    retries: 1,
    concurrency: { limit: 1 },
  },
  { event: "fundraising/angel-round.requested" },
  async ({ event, step, logger }) => {
    const { tenant_id, requested_by } = (event as AngelRoundRequestedEvent).data;

    if (!tenant_id || typeof tenant_id !== "string") {
      logger.error("[fundraising-run-angel-round] missing tenant_id in event", {});
      return { ok: false, error: "missing_tenant_id" };
    }
    if (!requested_by || typeof requested_by !== "string") {
      logger.error("[fundraising-run-angel-round] missing requested_by in event", {});
      return { ok: false, error: "missing_requested_by" };
    }

    const strategyRun = await step.run("load-strategy-run", async () => {
      return await loadLatestStrategyRun(tenant_id);
    });

    if (!strategyRun) {
      logger.warn(
        "[fundraising-run-angel-round] no strategy run found — founder must run 'prepare outreach plan' first",
        { tenant_id },
      );
      void logEvent({
        level: "warn",
        source: "fundraising.run-angel-round",
        code: "fundraising_angel_round_no_strategy",
        meta: { tenant_id },
      });
      return { ok: false, error: "no_strategy_run" };
    }

    const { run_id: strategy_run_id, investors } = strategyRun;

    const alreadyProcessed = await step.run("idempotency-check", async () => {
      const { count } = await serviceClient()
        .from("fundraising_send_audit")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenant_id)
        .eq("run_id", strategy_run_id);
      return (count ?? 0) > 0;
    });
    if (alreadyProcessed) {
      console.warn(
        `[fundraising-run-angel-round] strategy run ${strategy_run_id} already has audit rows — idempotent skip (no re-send)`,
      );
      void logEvent({
        level: "info",
        source: "fundraising.angel-round",
        code: "fundraising_angel_round_idempotent_skip",
        meta: { tenant_id, run_id: strategy_run_id },
      });
      return { ok: true, skipped: "already_processed" };
    }

    const gate = await step.run("load-send-gate", async () => {
      const { send_mode, updated_by } = await loadSendMode(tenant_id);
      let testRecipient: string | null = null;
      if (send_mode === "test") {
        testRecipient =
          (await resolveFounderEmail(requested_by)) ??
          (updated_by ? await resolveFounderEmail(updated_by) : null);
      }
      return { send_mode, testRecipient };
    });
    const testRecipient = gate.testRecipient ?? undefined;

    const counts = await step.run("enrich-and-propose", () => withVendorContext({ tenant_id, source: "fundraising" }, async () => {
      let proposed = 0;
      let manual = 0;
      let skipped = 0;
      let errors = 0;
      const decisionIds: string[] = [];

      for (const investor of investors) {
        const segment = investor.channel_segment ?? "missing-contact";
        const name = investor.name ?? "";
        const firm = investor.firm ?? "";
        const contactHint = investor.contact_hint ?? "";

        if (segment === "do-not-contact") {
          skipped++;
          continue;
        }

        if (
          segment === "linkedin-only" ||
          segment === "warm-intro" ||
          segment === "missing-contact"
        ) {
          await createManualOutreachTask({
            tenant_id,
            run_id: strategy_run_id,
            investor: {
              name: name || undefined,
              firm: firm || undefined,
              linkedin_handle:
                segment === "linkedin-only" ? contactHint || undefined : undefined,
              linkedin_dm: investor.copy_variants?.linkedin_dm || undefined,
            },
            reason:
              segment === "linkedin-only"
                ? "linkedin_only"
                : segment === "warm-intro"
                  ? "linkedin_only"
                  : "missing_contact",
          });
          manual++;
          continue;
        }

        if (segment !== "email-ready") {
          skipped++;
          continue;
        }

        let enriched = null;
        try {
          const domain = extractDomain(contactHint);
          enriched = await enrichInvestorEmail({
            firm: firm || "Unknown",
            name: name || "Unknown",
            domain,
          });
        } catch (e) {
          logger.warn(
            `[fundraising-run-angel-round] enrichment threw for investor, routing to manual task`,
            { error: (e as Error).message },
          );
          await createManualOutreachTask({
            tenant_id,
            run_id: strategy_run_id,
            investor: { name: name || undefined, firm: firm || undefined },
            reason: "low_confidence_email",
          });
          errors++;
          continue;
        }

        if (!isSendableEmail(enriched)) {
          await createManualOutreachTask({
            tenant_id,
            run_id: strategy_run_id,
            investor: { name: name || undefined, firm: firm || undefined },
            reason: enriched ? "low_confidence_email" : "missing_contact",
          });
          manual++;
          continue;
        }

        const coldEmail = investor.copy_variants?.cold_email;
        const subject = coldEmail?.subject?.trim() || `Introduction — Zavi`;
        const bodyText = coldEmail?.body?.trim() || `Hi,\n\nI wanted to reach out…`;

        const proposalResult = await proposeFundraisingDecision({
          tenant_id,
          strategy_run_id,
          investor_id_hint: null,
          recipient: enriched.email,
          subject,
          body_text: bodyText,
          ...(testRecipient ? { test_recipient: testRecipient } : {}),
        });

        if ("error" in proposalResult) {
          logger.warn(
            "[fundraising-run-angel-round] proposal emit failed",
            { error: proposalResult.error },
          );
          errors++;
          continue;
        }

        decisionIds.push(proposalResult.decision_id);
        proposed++;
      }

      void logEvent({
        level: "info",
        source: "fundraising.run-angel-round",
        code: "fundraising_angel_round_batch_proposed",
        meta: {
          tenant_id,
          strategy_run_id,
          proposed,
          manual,
          skipped,
          errors,
        },
      });

      return { proposed, manual, skipped, errors, decisionIds };
    }));

    if (counts.decisionIds.length === 0) {
      logger.info(
        "[fundraising-run-angel-round] no decisions proposed — no email-ready investors or all routed to manual",
        {},
      );
      return {
        ok: true,
        strategy_run_id,
        proposed: counts.proposed,
        manual: counts.manual,
        skipped: counts.skipped,
        errors: counts.errors,
        approved: 0,
        auto_approved: false,
        note: "no_email_ready_investors",
      };
    }

    const sendMode = gate.send_mode;
    const testMode = sendMode === "test";
    const autoApprove = sendMode === "test" || sendMode === "live";

    if (!autoApprove) {
      void logEvent({
        level: "info",
        source: "fundraising.run-angel-round",
        code: "fundraising_angel_round_left_proposed",
        meta: {
          tenant_id,
          strategy_run_id,
          count: counts.decisionIds.length,
          reason: "send_mode is off — proposals left for manual review",
        },
      });
      return {
        ok: true,
        strategy_run_id,
        proposed: counts.proposed,
        manual: counts.manual,
        skipped: counts.skipped,
        errors: counts.errors,
        approved: 0,
        auto_approved: false,
        note: "left_proposed_for_review",
        decision_ids: counts.decisionIds,
      };
    }

    const approveResult = await step.run("approve-batch", async () => {
      let approved = 0;
      let approveErrors = 0;

      for (const decision_id of counts.decisionIds) {
        const r = await decideOnDecision({
          decision_id,
          tenant_id,
          action: "approve",
          actor: { user_id: requested_by },
        });
        if (r.ok && r.changed) {
          approved++;
        } else if (!r.ok) {
          approveErrors++;
          logger.warn(
            "[fundraising-run-angel-round] per-decision approve failed",
            { decision_id, code: r.code },
          );
        }
      }

      return { approved, approveErrors };
    });

    void logEvent({
      level: "info",
      source: "fundraising.run-angel-round",
      code: "fundraising_angel_round_approved",
      meta: {
        tenant_id,
        strategy_run_id,
        approved: approveResult.approved,
        approve_errors: approveResult.approveErrors,
        test_mode: testMode,
      },
    });

    return {
      ok: true,
      strategy_run_id,
      proposed: counts.proposed,
      manual: counts.manual,
      skipped: counts.skipped,
      errors: counts.errors,
      approved: approveResult.approved,
      approve_errors: approveResult.approveErrors,
      auto_approved: true,
      test_mode: testMode,
    };
  },
);
