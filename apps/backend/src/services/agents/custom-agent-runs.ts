
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import {
  customDeliverSchema,
  deliverBelongsToTenant,
  type CustomDeliver,
} from "./custom-agents";
import type { ReminderDeliveryDeps } from "./reminders";

export const CUSTOM_SUMMARY_MAX = 2048;
export const CUSTOM_PAUSE_AFTER_FAILURES = 3;
const BODY_MAX = 32000;
const SLACK_TEXT_MAX = 39000;

import {
  customTriggerIdFromPayload,
  parseWatchResult,
  pendingUrlBaselineFromPayload,
  promptSafeFingerprint,
  stripWatchResult,
} from "./custom-agent-payload";
export {
  CUSTOM_SCHEDULE_TASK,
  CUSTOM_WATCH_TASK,
  buildCustomSchedulePayload,
  buildCustomWatchPayload,
  customTriggerIdFromPayload,
  parseWatchResult,
  stripWatchResult,
  type CustomSchedulePayload,
  type WatchResult,
} from "./custom-agent-payload";

export function resolveCustomDeliver(
  trigger: { deliver: unknown },
  agent: { default_deliver: unknown },
): { ok: true; deliver: CustomDeliver | null } | { ok: false } {
  const raw = trigger.deliver != null ? trigger.deliver : agent.default_deliver;
  if (raw == null) return { ok: true, deliver: null };
  const parsed = customDeliverSchema.safeParse(raw);
  return parsed.success ? { ok: true, deliver: parsed.data } : { ok: false };
}

export const CUSTOM_WHATSAPP_PENDING = "__pending__:whatsapp_window_closed";
const DEFER_PREFIX = "__defer__:";
const TRANSIENT_PREFIX = "__transient__:";

export type WhatsAppPark = {
  agent_id: string;
  trigger_id: string | null;
  run_id: string | null;
  summary: string | null;
};

export type CustomDeliveryDeps = Pick<
  ReminderDeliveryDeps,
  "scrub" | "postToThread" | "postToSlack" | "postToSlackDm" | "postToTelegram" | "postToDiscord"
> & {
  postToWhatsApp: (p: {
    tenant_id: string;
    wa_id: string;
    phone_number_id: string;
    text: string;
    park?: WhatsAppPark;
  }) => Promise<string | null>;
  postToEmail: (p: {
    tenant_id: string;
    run_id: string;
    agent_name: string;
    body: string;
    notice_agent_id?: string;
    ready_agent_id?: string;
  }) => Promise<string | null>;
  threadInTenant: (tenant_id: string, thread_id: string) => Promise<boolean>;
};

export async function deliverCustomAgentResult(
  args: {
    tenant_id: string;
    run_id: string;
    agent_name: string;
    deliver: CustomDeliver;
    text: string;
    notice_agent_id?: string;
    ready_agent_id?: string;
    park?: WhatsAppPark;
  },
  deps: CustomDeliveryDeps,
): Promise<string | null> {
  const parsed = customDeliverSchema.safeParse(args.deliver);
  if (!parsed.success) return "destination malformed";
  const target = parsed.data;
  const tenant_id = args.tenant_id;
  try {
    const body = deps.scrub(args.text).slice(0, BODY_MAX);
    switch (target.kind) {
      case "chat_thread": {
        if (!(await deps.threadInTenant(tenant_id, target.thread_id))) {
          return "destination thread not found for tenant";
        }
        return await deps.postToThread({ tenant_id, thread_id: target.thread_id, body });
      }
      case "slack_thread":
        return await deps.postToSlack({
          tenant_id,
          channel_id: target.channel_id,
          thread_ts: target.thread_ts,
          ...(target.team_id ? { team_id: target.team_id } : {}),
          text: body.slice(0, SLACK_TEXT_MAX),
        });
      case "slack_channel":
        return await deps.postToSlack({
          tenant_id,
          channel_id: target.channel_id,
          ...(target.team_id ? { team_id: target.team_id } : {}),
          text: body.slice(0, SLACK_TEXT_MAX),
        });
      case "slack_dm": {
        if (!deps.postToSlackDm) return "no slack DM sender wired";
        const err = await deps.postToSlackDm({
          tenant_id,
          slack_user_id: target.slack_user_id,
          ...(target.team_id ? { team_id: target.team_id } : {}),
          text: body.slice(0, SLACK_TEXT_MAX),
        });
        if (!err || !target.fallback) return err;
        const fb = target.fallback;
        const fbErr = await deps.postToSlack({
          tenant_id,
          channel_id: fb.channel_id,
          ...(fb.kind === "slack_thread" ? { thread_ts: fb.thread_ts } : {}),
          ...(fb.team_id ? { team_id: fb.team_id } : {}),
          text: body.slice(0, SLACK_TEXT_MAX),
        });
        return fbErr ? `dm failed (${err}); fallback failed (${fbErr})` : null;
      }
      case "whatsapp":
        return await deps.postToWhatsApp({
          tenant_id,
          wa_id: target.wa_id,
          phone_number_id: target.phone_number_id,
          text: body,
          ...(args.park ? { park: args.park } : {}),
        });
      case "telegram":
        if (!deps.postToTelegram) return "no telegram sender wired";
        return await deps.postToTelegram({ tenant_id, chat_id: target.chat_id, text: body });
      case "discord":
        if (!deps.postToDiscord) return "no discord sender wired";
        return await deps.postToDiscord({
          tenant_id,
          channel_id: target.channel_id,
          guild_id: target.guild_id,
          text: body,
        });
      case "email":
        return await deps.postToEmail({
          tenant_id,
          run_id: args.run_id,
          agent_name: args.agent_name,
          body,
          ...(args.notice_agent_id ? { notice_agent_id: args.notice_agent_id } : {}),
          ...(args.ready_agent_id ? { ready_agent_id: args.ready_agent_id } : {}),
        });
      default: {
        const never: never = target;
        return `unknown destination ${(never as { kind?: string }).kind ?? ""}`;
      }
    }
  } catch (e) {
    return (e as Error).message.slice(0, 500);
  }
}

export function customAgentPagePath(agent_id: string): string {
  return `/workspace?tab=agent-builder&agent=${encodeURIComponent(agent_id)}`;
}

export const CUSTOM_NOTICE_EMAIL_CTA = "Open the agent in Zavi";

export function customAgentRunPath(agent_id: string, run_id: string, tenant_id: string): string {
  const qs = new URLSearchParams({ tab: "agent-builder", agent: agent_id, run: run_id, company: tenant_id });
  return `/workspace?${qs.toString()}`;
}

export const CUSTOM_READY_EMAIL_CTA = "See it in Zavi";

export function composeCustomEmailBody(outputText: string | null, watchSummary?: string): string {
  const out = (outputText ?? "").trim();
  const head = (watchSummary ?? "").trim();
  const body = head.length > 0 ? `${head}${out.length > 0 ? `\n\n${out}` : ""}` : out;
  return body.length > 0 ? body : "The run finished without any output.";
}

function deliveryErrorCode(err: string): string {
  return /^[a-z_]{1,40}$/.test(err) ? err : "send_failed";
}

export function composeCustomResultBody(agentName: string, outputText: string | null): string {
  const out = (outputText ?? "").trim();
  return `From your agent "${agentName}":\n\n${out.length > 0 ? out : "The run finished without any output."}`;
}

export function composeCustomWatchBody(agentName: string, summary: string, details: string): string {
  const d = details.trim();
  return `From your agent "${agentName}":\n\n${summary.trim()}${d.length > 0 ? `\n\n${d}` : ""}`;
}

export function composeWatchNoChange(summary: string): string {
  const s = summary.trim();
  return s.length > 0 ? `No change. ${s}` : "No change.";
}

export function composeCustomPauseNotice(agentName: string): string {
  return `Your agent "${agentName}" is paused. Its last ${CUSTOM_PAUSE_AFTER_FAILURES} scheduled runs did not finish, so it stopped instead of failing again. Check its instructions in Agent Builder and resume it when you are ready.`;
}

export function composeCustomCreditsNotice(agentName: string): string {
  return `Your agent "${agentName}" skipped its scheduled run because this workspace is out of credits. It will run again on its next schedule once credits are added. You can add credits on the Billing page.`;
}

type AgentFacts = { id: string; name: string; status: string; default_deliver: unknown };
type TriggerFacts = {
  id: string;
  agent_id: string;
  deliver: unknown;
  kind?: "schedule" | "watch";
  last_fingerprint?: string | null;
};

async function loadAgentFacts(tenant_id: string, agent_id: string): Promise<AgentFacts | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("custom_agents")
    .select("id, name, status, default_deliver")
    .eq("id", agent_id)
    .maybeSingle<AgentFacts>();
  return error ? null : (data ?? null);
}

async function loadAgentFactsBySlug(tenant_id: string, slug: string): Promise<AgentFacts | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("custom_agents")
    .select("id, name, status, default_deliver")
    .eq("slug", slug)
    .maybeSingle<AgentFacts>();
  return error ? null : (data ?? null);
}

async function loadTriggerFacts(tenant_id: string, trigger_id: string): Promise<TriggerFacts | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("custom_agent_triggers")
    .select("id, agent_id, deliver, kind, last_fingerprint")
    .eq("id", trigger_id)
    .maybeSingle<TriggerFacts>();
  return error ? null : (data ?? null);
}

export type WatchStatePatch = {
  last_fingerprint?: string | null;
  url_baseline?: Record<string, string>;
};

async function saveWatchState(
  tenant_id: string,
  agent_id: string,
  trigger_id: string,
  patch: WatchStatePatch,
): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("custom_agent_triggers")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", trigger_id)
    .eq("agent_id", agent_id);
  if (error) throw new Error(`watch state write failed: ${error.message}`);
}

export function setupBlockKey(parsed: unknown): string | null {
  const p = parsed as { envelope_kind?: unknown; missing_connectors?: unknown; missing_vault_keys?: unknown } | null;
  if (!p || typeof p !== "object" || p.envelope_kind !== "setup_required") return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").sort().join(",") : "");
  return `setup_required:${list(p.missing_connectors)}|${list(p.missing_vault_keys)}`;
}

async function readSetupBlockEmailed(tenant_id: string, trigger_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("custom_agent_triggers")
    .select("last_setup_block_emailed")
    .eq("id", trigger_id)
    .maybeSingle<{ last_setup_block_emailed: string | null }>();
  if (error) throw new Error(`setup block read failed: ${error.message}`);
  return data?.last_setup_block_emailed ?? null;
}

async function writeSetupBlockEmailed(tenant_id: string, agent_id: string, trigger_id: string, key: string | null): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("custom_agent_triggers")
    .update({ last_setup_block_emailed: key })
    .eq("id", trigger_id)
    .eq("agent_id", agent_id);
  if (error) throw new Error(`setup block write failed: ${error.message}`);
}

export type OutcomeResult = { failures: number; just_paused: boolean; applied: boolean };

export async function recordCustomAgentOutcome(args: {
  tenant_id: string;
  agent_id: string;
  trigger_id: string | null;
  outcome: "delivered" | "failed";
  key: string;
  summary?: string | null;
}): Promise<OutcomeResult | null> {
  const { data, error } = await tenantRpc(asTenantId(args.tenant_id), "record_custom_agent_outcome", {
    p_agent_id: args.agent_id,
    p_trigger_id: args.trigger_id,
    p_outcome: args.outcome,
    p_key: args.key,
    p_summary: args.summary ?? null,
  });
  if (error) throw new Error(`record_custom_agent_outcome failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { o_failures: number; o_just_paused: boolean; o_applied: boolean }
    | null
    | undefined;
  if (!row) return null;
  return { failures: row.o_failures, just_paused: !!row.o_just_paused, applied: !!row.o_applied };
}

async function releaseCreditsNotice(tenant_id: string, agent_id: string): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("custom_agents")
    .update({ credits_notice_at: null })
    .eq("id", agent_id)
    .not("credits_notice_at", "is", null);
  if (error) console.warn(`[custom-agent] credits notice release failed agent=${agent_id}: ${error.message}`);
}

async function claimCreditsNotice(tenant_id: string, agent_id: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("custom_agents")
    .update({ credits_notice_at: new Date().toISOString() })
    .eq("id", agent_id)
    .is("credits_notice_at", null)
    .select("id");
  return !error && Array.isArray(data) && data.length === 1;
}

export type CustomRunSeams = {
  loadAgent: typeof loadAgentFacts;
  loadAgentBySlug: typeof loadAgentFactsBySlug;
  loadTrigger: typeof loadTriggerFacts;
  recordOutcome: typeof recordCustomAgentOutcome;
  claimCreditsNotice: typeof claimCreditsNotice;
  saveWatchState?: typeof saveWatchState;
  releaseCreditsNotice?: typeof releaseCreditsNotice;
  readSetupBlockEmailed?: typeof readSetupBlockEmailed;
  writeSetupBlockEmailed?: typeof writeSetupBlockEmailed;
  delivery: () => Promise<CustomDeliveryDeps>;
  warn: (s: string) => void;
  alertFailure?: (p: CustomRunFailureAlert) => Promise<void>;
  parkForHandoff?: (p: { tenant_id: string; run_id: string; output: string }) => Promise<boolean>;
};

export async function defaultCustomDeliveryDeps(
  scrub: (text: string) => string,
  threadMeta?: { agent_run_id?: string; from_agent_slug?: string },
): Promise<CustomDeliveryDeps> {
  const { reminderDeliveryDeps } = await import("./reminder-delivery-deps");
  const base = reminderDeliveryDeps({ scrub, threadMeta });
  return {
    scrub: base.scrub,
    postToThread: async (p) => {
      const tc = tenantClient(asTenantId(p.tenant_id));
      const { error } = await tc.from("agent_thread_messages").insert({
        thread_id: p.thread_id,
        sender_role: "assistant",
        body: p.body,
        ...(threadMeta?.agent_run_id ? { agent_run_id: threadMeta.agent_run_id } : {}),
        meta: {
          ...(threadMeta?.from_agent_slug ? { from_agent_slug: threadMeta.from_agent_slug } : {}),
          custom_agent: true,
        },
      });
      if (error) return error.message;
      await tc.from("agent_threads").update({ last_message_at: new Date().toISOString() }).eq("id", p.thread_id);
      return null;
    },
    postToSlack: base.postToSlack,
    postToSlackDm: base.postToSlackDm,
    postToTelegram: base.postToTelegram,
    postToDiscord: base.postToDiscord,
    postToWhatsApp: (p) => sendOrParkWhatsApp(p),
    postToEmail: async (p) => {
      const { sendAgentResultEmail } = await import("@/email/sendAgentResult");
      const r = await sendAgentResultEmail({
        tenant_id: p.tenant_id,
        run_id: p.run_id,
        agent_slug: p.agent_name,
        agent_name_is_typed: true,
        thread_owner_slug: "operator",
        body: p.body,
        ...(p.notice_agent_id
          ? { link: { path: customAgentPagePath(p.notice_agent_id), text: CUSTOM_NOTICE_EMAIL_CTA } }
          : p.ready_agent_id
            ? {
                link: { path: customAgentRunPath(p.ready_agent_id, p.run_id, p.tenant_id), text: CUSTOM_READY_EMAIL_CTA },
                ready: true,
              }
            : {}),
      });
      return r.sent ? null : r.reason;
    },
    threadInTenant: (tenant_id, thread_id) =>
      deliverBelongsToTenant(tenant_id, { kind: "chat_thread", thread_id }),
  };
}

const defaultSeams = (scrub: (t: string) => string, threadMeta?: { agent_run_id?: string; from_agent_slug?: string }): CustomRunSeams => ({
  loadAgent: loadAgentFacts,
  loadAgentBySlug: loadAgentFactsBySlug,
  loadTrigger: loadTriggerFacts,
  recordOutcome: recordCustomAgentOutcome,
  claimCreditsNotice,
  saveWatchState,
  releaseCreditsNotice,
  readSetupBlockEmailed,
  writeSetupBlockEmailed,
  delivery: () => defaultCustomDeliveryDeps(scrub, threadMeta),
  parkForHandoff: async (p) => {
    const { parkCustomHandoff } = await import("./custom-agent-handoff");
    return parkCustomHandoff(p);
  },
  warn: (s) => console.warn(s),
  alertFailure: alertCustomRunFailure,
});

export type CustomRunFailureKind =
  | "run_failed"
  | "watch_unparseable"
  | "delivery_failed"
  | "agent_or_trigger_missing"
  | "finish_hook_error";

export type CustomRunFailureAlert = {
  tenant_id: string;
  run_id: string;
  agent_slug: string;
  agent_id: string | null;
  kind: CustomRunFailureKind;
};

function adminBase(): string {
  return (process.env.ADMIN_ORIGIN || "https://admin.zaviagent.com").replace(/\/$/, "");
}

async function alertCustomRunFailure(p: CustomRunFailureAlert): Promise<void> {
  try {
    const { alert } = await import("@/services/logging/alert");
    await alert({
      msg: `custom agent run ${p.kind} run=${p.run_id} agent=${p.agent_slug}`,
      source: "custom-agent-run",
      code: "custom_agent_run_failed",
      tenant_id: p.tenant_id,
      email: {
        dedupeKey: `custom_agent_failed:${p.run_id}`,
        subjectDetail: `${p.kind} · ${p.agent_slug}`,
        detail: [
          `A scheduled custom-agent run did not settle: ${p.kind}.`,
          `tenant_id: ${p.tenant_id}`,
          `agent: ${p.agent_slug}${p.agent_id ? ` (${p.agent_id})` : ""}`,
          `run_id: ${p.run_id}`,
          `Run (error, events, trace): ${adminBase()}/runs/${p.run_id}`,
        ].join("\n"),
      },
    });
  } catch {
  }
}

async function sendNotice(
  tenant_id: string,
  agent: AgentFacts,
  trigger: { deliver: unknown },
  text: string,
  seams: CustomRunSeams,
): Promise<string | null> {
  const dest = resolveCustomDeliver(trigger, agent);
  if (!dest.ok || !dest.deliver) return "no destination";
  const deps = await seams.delivery();
  return deliverCustomAgentResult(
    {
      tenant_id,
      run_id: "",
      agent_name: agent.name,
      deliver: dest.deliver,
      text,
      notice_agent_id: agent.id,
      park: { agent_id: agent.id, trigger_id: null, run_id: null, summary: null },
    },
    deps,
  );
}

export async function recordCustomAgentFailure(
  args: { tenant_id: string; agent_id: string; trigger_id: string | null; key: string },
  seams: CustomRunSeams = defaultSeams((t) => t),
): Promise<OutcomeResult | null> {
  const res = await seams.recordOutcome({ ...args, outcome: "failed" });
  if (res?.just_paused) {
    const agent = await seams.loadAgent(args.tenant_id, args.agent_id);
    const trigger = args.trigger_id ? await seams.loadTrigger(args.tenant_id, args.trigger_id) : null;
    if (agent) {
      const err = await sendNotice(
        args.tenant_id,
        agent,
        trigger ?? { deliver: null },
        composeCustomPauseNotice(agent.name),
        seams,
      );
      if (err) seams.warn(`[custom-agent] pause notice not delivered agent=${agent.id}: ${err}`);
    }
  }
  return res;
}

export type FinishCustomRunInput = {
  tenant_id: string;
  run_id: string;
  agent_slug: string;
  custom_agent_id: string | null;
  custom_trigger_id: string | null;
  payload: unknown;
  status: "success" | "error" | "failed" | "cancelled";
  output_text: string | null;
  will_retry: boolean;
  error?: string | null;
  handoff_joined?: boolean;
  setup_required?: string | null;
};

export type FinishCustomRunResult =
  | "skipped_cancelled"
  | "skipped_retrying"
  | "skipped_outage"
  | "skipped_missing"
  | "delivered"
  | "no_destination"
  | "failed_run"
  | "failed_delivery"
  | "pending_whatsapp"
  | "deferred"
  | "waiting_handoff"
  | "watch_no_change"
  | "watch_unparseable"
  | "transient_delivery"
  | "setup_repeat_not_emailed";

export async function finishCustomAgentRun(
  input: FinishCustomRunInput,
  seams: CustomRunSeams,
): Promise<FinishCustomRunResult> {
  const { tenant_id, run_id } = input;
  let pagedAgentId: string | null = input.custom_agent_id;
  const page = async (kind: CustomRunFailureKind) => {
    if (!seams.alertFailure) return;
    try {
      await seams.alertFailure({ tenant_id, run_id, agent_slug: input.agent_slug, agent_id: pagedAgentId, kind });
    } catch {
    }
  };
  try {
    if (input.status === "cancelled") return "skipped_cancelled";
    if (input.status !== "success" && input.will_retry) return "skipped_retrying";
    if (input.status !== "success" && input.error) {
      const { isProviderOutageError } = await import("./infra-retry");
      if (isProviderOutageError(input.error)) return "skipped_outage";
    }
    if (input.status !== "success") await page("run_failed");
    const agent = input.custom_agent_id
      ? await seams.loadAgent(tenant_id, input.custom_agent_id)
      : await seams.loadAgentBySlug(tenant_id, input.agent_slug);
    const trigger_id = input.custom_trigger_id ?? customTriggerIdFromPayload(input.payload);
    const trigger = trigger_id ? await seams.loadTrigger(tenant_id, trigger_id) : null;
    if (!agent || !trigger || trigger.agent_id !== agent.id) {
      if (input.status === "success") await page("agent_or_trigger_missing");
      return "skipped_missing";
    }
    pagedAgentId = agent.id;
    const key = `run:${run_id}`;
    const failure = { tenant_id, agent_id: agent.id, trigger_id: trigger.id, key };

    if (input.status !== "success") {
      await recordCustomAgentFailure(failure, seams);
      return "failed_run";
    }

    let output = (input.output_text ?? "").trim();
    let summary = output.length > 0 ? output.slice(0, CUSTOM_SUMMARY_MAX) : null;
    let text = composeCustomResultBody(agent.name, output);
    let emailBody = composeCustomEmailBody(output);
    const watchPatch: WatchStatePatch = {};
    const persistWatch = async () => {
      if (Object.keys(watchPatch).length === 0 || !seams.saveWatchState) return;
      try {
        await seams.saveWatchState(tenant_id, agent.id, trigger.id, watchPatch);
      } catch (e) {
        seams.warn(`[custom-agent] ${(e as Error).message} run=${run_id}`);
      }
    };
    if (trigger.kind === "watch" && !input.setup_required) {
      const wr = parseWatchResult(input.output_text);
      if (!wr) {
        seams.warn(`[custom-agent] watch run without a valid watch_result block run=${run_id}`);
        await recordCustomAgentFailure(failure, seams);
        await page("watch_unparseable");
        return "watch_unparseable";
      }
      const pending = pendingUrlBaselineFromPayload(input.payload);
      if (pending) watchPatch.url_baseline = pending;
      const fp = promptSafeFingerprint(wr.fingerprint);
      if (wr.condition_met && fp.length === 0) {
        seams.warn(`[custom-agent] watch fingerprint empty after normalizing run=${run_id}`);
        await recordCustomAgentFailure(failure, seams);
        await page("watch_unparseable");
        return "watch_unparseable";
      }
      if (!wr.condition_met || fp === promptSafeFingerprint(trigger.last_fingerprint)) {
        if (!wr.condition_met && trigger.last_fingerprint != null) watchPatch.last_fingerprint = null;
        await persistWatch();
        await seams.recordOutcome({
          ...failure,
          outcome: "delivered",
          summary: composeWatchNoChange(wr.summary).slice(0, CUSTOM_SUMMARY_MAX),
        });
        return "watch_no_change";
      }
      output = stripWatchResult(input.output_text);
      summary = (wr.summary || output).slice(0, CUSTOM_SUMMARY_MAX) || null;
      text = composeCustomWatchBody(agent.name, wr.summary, output);
      emailBody = composeCustomEmailBody(output, wr.summary);
      watchPatch.last_fingerprint = fp;
    }
    const remember = persistWatch;
    const dest = resolveCustomDeliver(trigger, agent);
    if (!dest.ok) {
      await recordCustomAgentFailure(failure, seams);
      await page("delivery_failed");
      return "failed_delivery";
    }
    if (!dest.deliver) {
      await remember();
      await seams.recordOutcome({ ...failure, outcome: "delivered", summary });
      return "no_destination";
    }
    if (!input.handoff_joined && trigger.kind !== "watch" && seams.parkForHandoff) {
      if (await seams.parkForHandoff({ tenant_id, run_id, output })) return "waiting_handoff";
    }
    const deps = await seams.delivery();
    const setupKey = input.setup_required ?? null;
    let repeatSetup = false;
    if (setupKey && seams.readSetupBlockEmailed) {
      try {
        repeatSetup = (await seams.readSetupBlockEmailed(tenant_id, trigger.id)) === setupKey;
      } catch (e) {
        seams.warn(`[custom-agent] ${(e as Error).message} run=${run_id}`);
      }
    }
    const markEmailed = async () => {
      if (!seams.writeSetupBlockEmailed) return;
      try {
        await seams.writeSetupBlockEmailed(tenant_id, agent.id, trigger.id, setupKey);
      } catch (e) {
        seams.warn(`[custom-agent] ${(e as Error).message} run=${run_id}`);
      }
    };
    const destination = dest.deliver;
    const emailReady = async () => {
      if (destination.kind === "email" || repeatSetup) return;
      const mailErr = await deliverCustomAgentResult(
        { tenant_id, run_id, agent_name: agent.name, deliver: { kind: "email" }, text: emailBody, ready_agent_id: agent.id },
        deps,
      );
      if (mailErr) seams.warn(`[custom-agent] ready email not sent run=${run_id}: ${deliveryErrorCode(mailErr)}`);
      else await markEmailed();
    };
    if (destination.kind === "email" && repeatSetup) {
      await remember();
      await seams.recordOutcome({ ...failure, outcome: "delivered", summary });
      return "setup_repeat_not_emailed";
    }
    const err = await deliverCustomAgentResult(
      {
        tenant_id,
        run_id,
        agent_name: agent.name,
        deliver: dest.deliver,
        text,
        park: { agent_id: agent.id, trigger_id: trigger.id, run_id, summary },
      },
      deps,
    );
    if (err === CUSTOM_WHATSAPP_PENDING) {
      await remember();
      await emailReady();
      return "pending_whatsapp";
    }
    if (err?.startsWith(DEFER_PREFIX)) {
      seams.warn(`[custom-agent] result deferred to another host run=${run_id}: ${err}`);
      return "deferred";
    }
    if (err?.startsWith(TRANSIENT_PREFIX)) {
      seams.warn(`[custom-agent] result not delivered (transient) run=${run_id}: ${err}`);
      await page("delivery_failed");
      return "transient_delivery";
    }
    if (err) {
      seams.warn(`[custom-agent] result not delivered run=${run_id}: ${deliveryErrorCode(err)}`);
      await recordCustomAgentFailure(failure, seams);
      await page("delivery_failed");
      return "failed_delivery";
    }
    await remember();
    await seams.recordOutcome({ ...failure, outcome: "delivered", summary });
    if (destination.kind === "email") await markEmailed();
    await emailReady();
    return "delivered";
  } catch (e) {
    seams.warn(`[custom-agent] finish hook failed run=${run_id}: ${(e as Error).message}`);
    await page("finish_hook_error");
    return "skipped_missing";
  }
}

export function finishCustomAgentRunProd(
  input: FinishCustomRunInput,
  scrub: (text: string) => string,
  from_agent_slug: string,
): Promise<FinishCustomRunResult> {
  return finishCustomAgentRun(
    input,
    defaultSeams(scrub, { agent_run_id: input.run_id, from_agent_slug }),
  );
}

export async function noteCustomAgentCreditSkip(
  tenant_id: string,
  trigger_id: string,
  seams: CustomRunSeams = defaultSeams((t) => t),
): Promise<"notified" | "already_notified" | "skipped"> {
  try {
    const trigger = await seams.loadTrigger(tenant_id, trigger_id);
    if (!trigger) return "skipped";
    const agent = await seams.loadAgent(tenant_id, trigger.agent_id);
    if (!agent) return "skipped";
    if (!(await seams.claimCreditsNotice(tenant_id, agent.id))) return "already_notified";
    const err = await sendNotice(tenant_id, agent, trigger, composeCustomCreditsNotice(agent.name), seams);
    if (err && err !== CUSTOM_WHATSAPP_PENDING) {
      seams.warn(`[custom-agent] credits notice not delivered agent=${agent.id}: ${err}`);
      await seams.releaseCreditsNotice?.(tenant_id, agent.id);
      return "skipped";
    }
    return "notified";
  } catch (e) {
    seams.warn(`[custom-agent] credits skip note failed trigger=${trigger_id}: ${(e as Error).message}`);
    return "skipped";
  }
}

export type ParkResult =
  | { kind: "inserted"; id: string }
  | { kind: "duplicate"; id: string; nudged: boolean; delivered: boolean }
  | { kind: "error"; error: string };

export type WhatsAppSeams = {
  ownsNumber: (phone_number_id: string) => boolean;
  binding: (a: { tenant_id: string; wa_id: string; phone_number_id: string }) => Promise<{ window_expires_at: string | null } | null>;
  windowIsOpen: (windowExpiresAt: string | null) => boolean;
  send: (a: { wa_id: string; text: string; windowExpiresAt: string | null }) => Promise<
    { ok: true } | { ok: false; windowClosed?: boolean; sent: number; error: string }
  >;
  nudge: (a: { wa_id: string }) => Promise<{ ok: boolean; error?: string }>;
  hasPending: (a: { tenant_id: string; wa_id: string; phone_number_id: string }) => Promise<boolean>;
  park: (a: { tenant_id: string; wa_id: string; phone_number_id: string; text: string; park: WhatsAppPark }) => Promise<ParkResult>;
  markNudged: (a: { tenant_id: string; id: string }) => Promise<string | null>;
  discard: (a: { tenant_id: string; id: string }) => Promise<string | null>;
  warn: (s: string) => void;
};

async function defaultWhatsAppSeams(): Promise<WhatsAppSeams> {
  const { whatsappOwnsNumber } = await import("@/services/connectors/whatsapp/adapter");
  const { findEnabledWhatsAppBinding } = await import("@/services/connectors/whatsapp/binding");
  const wa = await import("@/services/tools/whatsapp/_client");
  return {
    ownsNumber: whatsappOwnsNumber,
    binding: findEnabledWhatsAppBinding,
    windowIsOpen: (w) => wa.windowIsOpen(w),
    send: async (a) => {
      const r = await wa.postWhatsAppReply(a);
      return r.ok ? { ok: true } : { ok: false, windowClosed: r.windowClosed, sent: r.sent, error: r.error };
    },
    nudge: async (a) => {
      const r = await wa.postWhatsAppWindowTemplate(a);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    hasPending: async (a) => {
      const { data, error } = await tenantClient(asTenantId(a.tenant_id))
        .from("custom_agent_whatsapp_pending")
        .select("id")
        .eq("phone_number_id", a.phone_number_id)
        .eq("wa_id", a.wa_id)
        .is("delivered_at", null)
        .not("nudged_at", "is", null)
        .limit(1);
      return !error && Array.isArray(data) && data.length > 0;
    },
    park: async (a) => {
      const tc = tenantClient(asTenantId(a.tenant_id));
      const { data, error } = await tc
        .from("custom_agent_whatsapp_pending")
        .insert({
          agent_id: a.park.agent_id,
          trigger_id: a.park.trigger_id,
          run_id: a.park.run_id,
          wa_id: a.wa_id,
          phone_number_id: a.phone_number_id,
          text: a.text,
          summary: a.park.summary,
        })
        .select("id")
        .single<{ id: string }>();
      if (!error && data) return { kind: "inserted", id: data.id };
      if (error && (error as { code?: string }).code === "23505" && a.park.run_id) {
        const { data: ex } = await tc
          .from("custom_agent_whatsapp_pending")
          .select("id, nudged_at, delivered_at")
          .eq("run_id", a.park.run_id)
          .maybeSingle<{ id: string; nudged_at: string | null; delivered_at: string | null }>();
        if (ex) {
          return { kind: "duplicate", id: ex.id, nudged: ex.nudged_at != null, delivered: ex.delivered_at != null };
        }
      }
      return { kind: "error", error: error?.message ?? "insert returned no row" };
    },
    markNudged: async (a) => {
      const { data, error } = await tenantClient(asTenantId(a.tenant_id))
        .from("custom_agent_whatsapp_pending")
        .update({ nudged_at: new Date().toISOString() })
        .eq("id", a.id)
        .select("id");
      if (error) return error.message;
      return Array.isArray(data) && data.length === 1 ? null : "no parked row matched";
    },
    discard: async (a) => {
      const { error } = await tenantClient(asTenantId(a.tenant_id))
        .from("custom_agent_whatsapp_pending")
        .delete()
        .eq("id", a.id);
      return error ? error.message : null;
    },
    warn: (s) => console.warn(s),
  };
}

export async function sendOrParkWhatsApp(
  p: { tenant_id: string; wa_id: string; phone_number_id: string; text: string; park?: WhatsAppPark },
  seamsIn?: WhatsAppSeams,
): Promise<string | null> {
  try {
    const seams = seamsIn ?? (await defaultWhatsAppSeams());
    if (!seams.ownsNumber(p.phone_number_id)) {
      return `${DEFER_PREFIX}whatsapp number ${p.phone_number_id} is not served by this host`;
    }
    const binding = await seams.binding({ tenant_id: p.tenant_id, wa_id: p.wa_id, phone_number_id: p.phone_number_id });
    if (!binding) return "whatsapp thread no longer enabled for this tenant";
    if (seams.windowIsOpen(binding.window_expires_at)) {
      const r = await seams.send({ wa_id: p.wa_id, text: p.text, windowExpiresAt: binding.window_expires_at });
      if (r.ok) return null;
      if (!(r.windowClosed && r.sent === 0)) return r.error || "whatsapp send failed";
    }
    if (!p.park) return "whatsapp window closed";
    const where = { tenant_id: p.tenant_id, wa_id: p.wa_id, phone_number_id: p.phone_number_id };
    const parked = await seams.park({ ...where, text: p.text, park: p.park });
    if (parked.kind === "error") return `whatsapp park failed: ${parked.error}`;
    const id = parked.id;
    const dup = parked.kind === "duplicate";
    if (dup && parked.delivered) return CUSTOM_WHATSAPP_PENDING;
    if (dup && parked.nudged) return CUSTOM_WHATSAPP_PENDING;
    const stamp = async (): Promise<void> => {
      const err = await seams.markNudged({ tenant_id: p.tenant_id, id });
      if (err) seams.warn(`[custom-agent] whatsapp nudge not recorded on row ${id}: ${err}`);
    };
    if (await seams.hasPending(where)) {
      await stamp();
      return CUSTOM_WHATSAPP_PENDING;
    }
    let n: { ok: boolean; error?: string };
    try {
      n = await seams.nudge({ wa_id: p.wa_id });
    } catch (e) {
      n = { ok: false, error: (e as Error).message };
    }
    if (n.ok) {
      await stamp();
      return CUSTOM_WHATSAPP_PENDING;
    }
    if (dup) {
      seams.warn(`[custom-agent] whatsapp nudge failed on parked row ${id}: ${n.error ?? "unknown"}`);
      return CUSTOM_WHATSAPP_PENDING;
    }
    const delErr = await seams.discard({ tenant_id: p.tenant_id, id });
    if (delErr) return `whatsapp nudge failed and the parked row could not be removed: ${delErr}`;
    return `whatsapp window closed and nudge template failed: ${n.error ?? "unknown"}`;
  } catch (e) {
    return (e as Error).message.slice(0, 500);
  }
}

export type PendingWhatsAppRow = {
  id: string;
  agent_id: string;
  trigger_id: string | null;
  run_id: string | null;
  text: string;
  summary: string | null;
};

export type FlushSeams = {
  loadPending: (tenant_id: string, phone_number_id: string, wa_id: string, limit: number) => Promise<PendingWhatsAppRow[]>;
  claim: (tenant_id: string, id: string) => Promise<boolean>;
  unclaim: (tenant_id: string, id: string) => Promise<void>;
  whatsapp: () => Promise<WhatsAppSeams>;
  recordOutcome: typeof recordCustomAgentOutcome;
  warn: (s: string) => void;
};

export const WHATSAPP_FLUSH_CAP = 5;

const defaultFlushSeams: FlushSeams = {
  loadPending: async (tenant_id, phone_number_id, wa_id, limit) => {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("custom_agent_whatsapp_pending")
      .select("id, agent_id, trigger_id, run_id, text, summary")
      .eq("phone_number_id", phone_number_id)
      .eq("wa_id", wa_id)
      .is("delivered_at", null)
      .order("created_at", { ascending: true })
      .limit(limit);
    return error ? [] : ((data ?? []) as PendingWhatsAppRow[]);
  },
  claim: async (tenant_id, id) => {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("custom_agent_whatsapp_pending")
      .update({ delivered_at: new Date().toISOString() })
      .eq("id", id)
      .is("delivered_at", null)
      .select("id");
    return !error && Array.isArray(data) && data.length === 1;
  },
  unclaim: async (tenant_id, id) => {
    await tenantClient(asTenantId(tenant_id))
      .from("custom_agent_whatsapp_pending")
      .update({ delivered_at: null })
      .eq("id", id);
  },
  whatsapp: () => defaultWhatsAppSeams(),
  recordOutcome: recordCustomAgentOutcome,
  warn: (s) => console.warn(s),
};

export async function flushCustomAgentWhatsAppPending(
  args: { tenant_id: string; phone_number_id: string; wa_id: string },
  seams: FlushSeams = defaultFlushSeams,
): Promise<number> {
  let sent = 0;
  try {
    const rows = await seams.loadPending(args.tenant_id, args.phone_number_id, args.wa_id, WHATSAPP_FLUSH_CAP);
    if (rows.length === 0) return 0;
    const wa = await seams.whatsapp();
    const binding = await wa.binding(args);
    if (!binding) return 0;
    for (const row of rows) {
      if (!(await seams.claim(args.tenant_id, row.id))) continue;
      const r = await wa.send({ wa_id: args.wa_id, text: row.text, windowExpiresAt: binding.window_expires_at });
      if (!r.ok && r.sent === 0) {
        await seams.unclaim(args.tenant_id, row.id);
        seams.warn(`[custom-agent] whatsapp pending send failed row=${row.id}: ${r.error}`);
        break;
      }
      sent += 1;
      if (row.run_id && row.trigger_id) {
        await seams.recordOutcome({
          tenant_id: args.tenant_id,
          agent_id: row.agent_id,
          trigger_id: row.trigger_id,
          outcome: "delivered",
          key: `run:${row.run_id}`,
          summary: row.summary,
        });
      }
    }
  } catch (e) {
    seams.warn(`[custom-agent] whatsapp pending flush failed: ${(e as Error).message}`);
  }
  return sent;
}

export type AltTerminalRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string | null;
  status: string;
  error: string | null;
  infra_retry_count: number | null;
  last_progress_at: string | null;
  payload: unknown;
  custom_agent_id?: string | null;
  custom_trigger_id?: string | null;
};

export async function settleCustomAgentAltTerminal(
  row: AltTerminalRow,
  seams?: CustomRunSeams,
): Promise<FinishCustomRunResult | "not_custom"> {
  const { isCustomAgentSlug } = await import("@/services/billing/tiers");
  if (row.trigger !== "cron" || !isCustomAgentSlug(row.agent_slug)) return "not_custom";
  const { willBeInfraRetried } = await import("./infra-retry");
  const will_retry = willBeInfraRetried({
    id: row.id,
    tenant_id: row.tenant_id,
    agent_slug: row.agent_slug,
    status: row.status,
    error: row.error,
    infra_retry_count: row.infra_retry_count ?? 0,
    last_progress_at: row.last_progress_at,
  });
  return finishCustomAgentRun(
    {
      tenant_id: row.tenant_id,
      run_id: row.id,
      agent_slug: row.agent_slug,
      custom_agent_id: row.custom_agent_id ?? null,
      custom_trigger_id: row.custom_trigger_id ?? null,
      payload: row.payload,
      status: "failed",
      output_text: null,
      will_retry,
      error: row.error,
    },
    seams ?? defaultSeams((t) => t),
  );
}
