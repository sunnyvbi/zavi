
import { inngest } from "../client";
import { ExpectedToolError } from "@/services/tools/types";
import { serviceClient } from "@/services/supabase";
import {
  execPlatform,
  execPlatformLabel,
  platformWriteEnabled,
} from "@/services/channels/exec-kill-switch";
import {
  settleChannelActionExec,
  toClaimResult,
  type ClaimedExecAction,
  type ClaimResult,
} from "@/services/channels/exec-actions";
import { logEvent } from "@/services/logging/logEvent";
import { readTenantDisabled } from "@/services/tenants/disabled";
import { readChannelStopped } from "@/services/growth/channel-stopped";
import { channelPlanLock } from "@/services/growth/preview-plan";
import { planUpgradeMessage } from "@/services/agents/entitlement";
import { PLAN_UPGRADE_REQUIRED, isTierGatedChannel } from "@/services/billing/tiers";
import { trackChannelActionExecuted } from "@/services/analytics/action-events";
import { safeExecReceipt } from "@/services/channels/exec-receipt";
import { FENCED_PLATFORMS, runWithWriteFence, type WriteFence } from "@/services/channels/write-fence";
import { ENVELOPE_CREATE_CLASSES } from "@/services/approvals/envelope-classes";

export async function claimChannelActionExec(actionId: string): Promise<ClaimResult> {
  const { data, error } = await serviceClient().rpc("claim_channel_action_exec", {
    p_action_id: actionId,
  });
  if (error) throw new Error(`claim_channel_action_exec failed: ${error.message}`);
  return toClaimResult(data);
}

export async function releaseChannelActionExecClaim(actionId: string, claimId: string): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("release_channel_action_exec_claim", {
    p_action_id: actionId,
    p_claim_id: claimId,
  });
  if (error) throw new Error(`release_channel_action_exec_claim failed: ${error.message}`);
  return data === true;
}

export const RETRYABLE_EXEC_CODES: ReadonlySet<string> = new Set(["creator_hire_release_pending"]);

export class RetryableExecError extends Error {
  constructor(public readonly code: string) {
    super(`channel action handler asked for a retry: ${code}`);
  }
}

export type ExecDecisionRow = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  decision_class: string;
  body: Record<string, unknown>;
  status: string;
  handler: string | null;
  approved_by?: string | null;
  approved_by_source?: string | null;
  exec_source: "channel_actions";
  claim_id?: string;
  test_stop_pause?: true;
};

export function buildExecDecisionRow(
  actionId: string,
  row: ClaimedExecAction,
  testStopPause = false,
): ExecDecisionRow {
  return {
    id: actionId,
    tenant_id: row.tenant_id,
    agent_run_id: row.agent_run_id,
    decision_class: row.exec_class,
    body: row.exec_payload,
    status: "dispatching",
    handler: row.exec_class,
    approved_by: row.approved_by,
    approved_by_source: row.approved_by_source,
    exec_source: "channel_actions",
    claim_id: row.claim_id,
    ...(testStopPause ? { test_stop_pause: true as const } : {}),
  };
}

export type ExecOutcome = {
  ok: boolean;
  skipped?:
    | "not_found"
    | "not_queued"
    | "in_flight"
    | "interrupted"
    | "no_handler"
    | "kill_switch"
    | "plan_upgrade_required"
    | "tenant_disabled"
    | "test_stop_founder_resumed"
    | "founder_stopped";
  error?: string;
  notice?: string;
  deferred?: boolean;
};

export type ExecHandlerResult = {
  execution_details?: import("@/services/connectors/reddit-ads/execute").RedditExecutionDetails;
  ok: boolean;
  error?: string;
  notice?: string;
  held_for_founder?: boolean;
  deferred?: boolean;
  code?: string;
  audience_mismatch?: boolean;
  not_sent?: boolean;
  checkout_url?: string | null;
  archived?: { group: boolean | null; group_name: string };
  created?: import("@/services/channels/created-object").CreatedObject;
  cut_guard_override?: true;
  places_change?: { before: string[]; after: string[] };
  location_undo?: import("@/services/tools/meta-ads/write/replace_ad_set_geo").ReplaceAdSetGeoBody;
  receipt?: import("@/services/channels/exec-receipt").ExecReceipt;
};

export type ExecHandler = (d: ExecDecisionRow) => Promise<ExecHandlerResult>;

export type ExecDeps = {
  claim: typeof claimChannelActionExec;
  settle: typeof settleChannelActionExec;
  loadHandler: (execClass: string) => Promise<ExecHandler | null>;
  writeEnabled: (execClass: string) => Promise<boolean>;
  channelLock: typeof channelPlanLock;
  execClassOf: (actionId: string) => Promise<string | null>;
  interruptedLinkedinLaunch: (tenantId: string, actionId: string) => Promise<import("@/services/ads-wallet/linkedin-launch").InterruptedLinkedinLaunch>;
  releaseClaim: typeof releaseChannelActionExecClaim;
  envelopeSwitchedOff: (row: { tenant_id: string; exec_class: string }, actionId: string) => Promise<boolean>;
  tenantDisabled: (tenantId: string) => Promise<boolean | null>;
  channelStopped: (tenantId: string, channelSlug: string) => Promise<boolean | null>;
  retimeFlight: (row: { tenant_id: string; exec_class: string; exec_payload: Record<string, unknown> }, actionId: string) => Promise<Record<string, unknown>>;
  tellOutcome: (o: import("@/services/approvals/direct-ask-outcome").DirectAskOutcome) => Promise<import("@/services/approvals/direct-ask-outcome").TellResult>;
  testStopPause: (tenantId: string, actionId: string, execClass: string, payload: unknown) => Promise<"stop" | "resumed" | null>;
  execProgressOf: (tenantId: string, actionId: string) => Promise<unknown>;
};

async function loadDecisionHandler(execClass: string): Promise<ExecHandler | null> {
  const mod = await import("./dispatch-decision");
  const handlers = mod.DECISION_HANDLERS as unknown as Record<string, ExecHandler>;
  return handlers[execClass] ?? null;
}

async function readExecClass(actionId: string): Promise<string | null> {
  const { data, error } = await serviceClient()
    .from("channel_actions")
    .select("exec_class")
    .eq("id", actionId)
    .maybeSingle();
  if (error) throw new Error(`exec_class read failed: ${error.message}`);
  return (data as { exec_class?: string | null } | null)?.exec_class ?? null;
}

async function readExecProgress(tenantId: string, actionId: string): Promise<unknown> {
  const { data, error } = await serviceClient()
    .from("channel_actions")
    .select("exec_progress")
    .eq("id", actionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`exec_progress read failed: ${error.message}`);
  return (data as { exec_progress?: unknown } | null)?.exec_progress ?? null;
}

const NOTHING_CHANGED = "Nothing in the account changed.";

export async function accountLineForGate(execClass: string, read: () => Promise<unknown>): Promise<string> {
  if (execClass !== "linkedin_ads.create_campaign_bundle") return NOTHING_CHANGED;
  const progress = await read().then((p) => p as Record<string, unknown> | null, () => undefined);
  if (progress === undefined)
    return "Zavi made no new change in LinkedIn this time. Anything it made on an earlier try is still there, as it was.";
  const made = progress?.creative_id
    ? "the campaign group, the paused campaign and the paused ad"
    : progress?.campaign_id
      ? "the campaign group and the paused campaign"
      : progress?.group_id
        ? "the campaign group"
        : null;
  if (!made) return progress?.in_flight ? "Zavi made no new change in LinkedIn this time. An earlier try may have reached LinkedIn, so check LinkedIn Campaign Manager before anything else." : NOTHING_CHANGED;
  return `Zavi made no new change in LinkedIn this time. What it made on an earlier try, ${made}, is still in LinkedIn and stays paused, so nothing can spend.`;
}

const EXEC_LEASE_MS = 10 * 60_000;

export async function readExecRow(actionId: string): Promise<{
  tenant_id: string;
  exec_class: string | null;
  exec_status: string | null;
  exec_result: Record<string, unknown> | null;
  exec_payload: unknown;
  exec_progress: unknown;
  approved_by_source: string | null;
  lease_expired: boolean;
} | null> {
  const { data, error } = await serviceClient()
    .from("channel_actions")
    .select("tenant_id, exec_class, exec_status, exec_result, exec_payload, exec_progress, exec_claimed_at, approved_by_source")
    .eq("id", actionId)
    .maybeSingle();
  if (error) throw new Error(`exec row read failed: ${error.message}`);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  const claimedAt = typeof r.exec_claimed_at === "string" ? Date.parse(r.exec_claimed_at) : NaN;
  return {
    tenant_id: String(r.tenant_id),
    exec_class: typeof r.exec_class === "string" ? r.exec_class : null,
    exec_status: typeof r.exec_status === "string" ? r.exec_status : null,
    exec_result: r.exec_result && typeof r.exec_result === "object" && !Array.isArray(r.exec_result) ? (r.exec_result as Record<string, unknown>) : null,
    exec_payload: r.exec_payload ?? null,
    exec_progress: r.exec_progress ?? null,
    approved_by_source: typeof r.approved_by_source === "string" ? r.approved_by_source : null,
    lease_expired: r.exec_status === "dispatching" && (!Number.isFinite(claimedAt) || claimedAt < Date.now() - EXEC_LEASE_MS),
  };
}

const DEFAULT_DEPS: ExecDeps = {
  claim: claimChannelActionExec,
  settle: settleChannelActionExec,
  loadHandler: loadDecisionHandler,
  writeEnabled: platformWriteEnabled,
  channelLock: channelPlanLock,
  execClassOf: readExecClass,
  interruptedLinkedinLaunch: async (tenantId, actionId) => (await import("@/services/ads-wallet/linkedin-launch")).judgeInterruptedLinkedinLaunch(tenantId, actionId),
  releaseClaim: releaseChannelActionExecClaim,
  envelopeSwitchedOff: async (row, actionId) => (await import("@/services/approvals/envelope-door")).envelopeLaunchSwitchedOff(row, actionId),
  tenantDisabled: readTenantDisabled,
  channelStopped: readChannelStopped,
  retimeFlight: async (row, actionId) => {
    const m = await import("@/services/approvals/approval-envelope");
    const env = await m.readApprovalEnvelope(row.tenant_id, "channel_actions", actionId).catch(() => null);
    if (!env || env.tenant_id !== row.tenant_id) return row.exec_payload;
    return m.retimeEnvelopeFlight(row.exec_class, row.exec_payload, env, Date.now()) as Record<string, unknown>;
  },
  tellOutcome: async (o) => (await import("@/services/approvals/direct-ask-outcome")).tellDirectAskOutcome(o),
  testStopPause: async (tenantId, actionId, execClass, payload) => (await import("@/services/growth/test-stops")).testStopPauseAuthority(tenantId, actionId, execClass, payload),
  execProgressOf: readExecProgress,
};

export type SettleInstruction = {
  tenant_id: string;
  claim_id: string | null;
  ok: boolean;
  error: string | null;
  result: Record<string, unknown>;
  exec_class?: string;
};

export type MutationResult = {
  settle: SettleInstruction | null;
  outcome: ExecOutcome;
  log: {
    ok: boolean;
    tenant_id: string;
    run_id: string | null;
    channel_slug: string;
    message: string;
  } | null;
};

const INTERRUPTED_NOTE =
  "This change was interrupted while it was being applied. Zavi did not retry it, because the change may already have gone through — check the account, then approve again if it did not.";

const INTERRUPTED_CREATE_NOTE =
  "This change was interrupted while it was being applied, and part of it may already have gone through. Zavi will not run it again, so no second copy is made. Check the account and finish or remove it there.";

const INTERRUPTED_UNCONFIRMED_NOTES: Record<string, string> = {
  "linkedin_ads.launch_campaign":
    "This launch was interrupted, so Zavi could not confirm whether it reached LinkedIn. Zavi is checking it now, and if it still cannot confirm the launch within about 15 minutes it pauses the campaign to be safe. The budget set aside for it stays held until Zavi confirms what happened. If the campaign is paused after that, review the launch again.",
};
const INTERRUPTED_CREATE_NOTHING_MADE_NOTE =
  "Zavi was interrupted before it created anything in LinkedIn, so nothing was made and nothing can spend. Choose Try again.";
const INTERRUPTED_CREATE_RESUMABLE_NOTE =
  "Zavi was interrupted while it was creating this campaign in LinkedIn. What it made so far is saved, and nothing in it can spend. Choose Try again: Zavi checks LinkedIn for the step it was on and finishes the rest without creating anything twice.";
const INTERRUPTED_LAUNCH_CONFIRMED_NOTE =
  "This launch went through and the campaign is live in LinkedIn Campaign Manager. Zavi was interrupted before it could close this card, so it will not send the launch again.";
const INTERRUPTED_LAUNCH_RECONCILED_NOTE =
  "An earlier attempt of this launch did not finish, and Zavi could not confirm whether it reached LinkedIn, so Zavi keeps the campaign paused to be safe. If it did reach LinkedIn it may have run for a short time. Check the campaign in LinkedIn Campaign Manager, then review the launch again.";
const INTERRUPTED_LAUNCH_NOT_SENT_NOTE =
  "This launch was interrupted before anything reached LinkedIn, so nothing was spent. Choose Try again to send it.";
const INTERRUPTED_LAUNCH_NOT_REOPENED_NOTE =
  "This launch was interrupted before anything reached LinkedIn, so nothing was spent. Zavi could not reopen this request, so approving this card again would do nothing. Review the launch again to send a new one.";

export function execCreatesProviderObjects(execClass: string | null): boolean {
  if (!execClass) return true;
  return /^(create|duplicate|prepare|replace_creative|swap_ad)(_|$)/.test(execClass.split(".")[1] ?? "");
}

export async function runChannelActionMutation(
  actionId: string,
  deps: Partial<ExecDeps> = {},
  opts: { retryable?: boolean; firstAttempt?: boolean } = {},
): Promise<MutationResult> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const untouched = opts.firstAttempt === true ? { nothing_written: true } : {};
  const claimed = await d.claim(actionId);

  if (!claimed.ok) {
    if (claimed.code === "not_found") {
      return { settle: null, outcome: { ok: true, skipped: "not_found" }, log: null };
    }
    if (claimed.exec_status === "dispatching") {
      if (!claimed.lease_expired) {
        return { settle: null, outcome: { ok: true, skipped: "in_flight" }, log: null };
      }
      const execClass = await d.execClassOf(actionId).catch(() => null);
      const checking = execClass ? INTERRUPTED_UNCONFIRMED_NOTES[execClass] : undefined;
      const launch = checking ? await d.interruptedLinkedinLaunch(claimed.tenant_id, actionId).catch(() => "unknown" as const) : null;
      if (launch === "not_sent" || launch === "not_reopened") {
        const reopened = launch === "not_sent";
        return {
          settle: {
            tenant_id: claimed.tenant_id,
            claim_id: null,
            ok: false,
            exec_class: execClass ?? "",
            error: reopened ? INTERRUPTED_LAUNCH_NOT_SENT_NOTE : INTERRUPTED_LAUNCH_NOT_REOPENED_NOTE,
            result: reopened ? { interrupted: true, lease_expired: true, code: "linkedin_ads_launch_not_sent" } : { code: "linkedin_ads_launch_not_reopened" },
          },
          outcome: { ok: false, skipped: "interrupted" },
          log: null,
        };
      }
      if (execClass === "linkedin_ads.create_campaign_bundle") {
        const progress = await d.execProgressOf(claimed.tenant_id, actionId).then((p) => ({ p }), () => null);
        const { linkedinCreateResumable } = await import("@/services/connectors/linkedin-ads/creation-progress");
        const judged = progress ? linkedinCreateResumable(progress.p) : null;
        if (judged?.resumable) {
          return {
            settle: {
              tenant_id: claimed.tenant_id,
              claim_id: null,
              ok: false,
              exec_class: execClass,
              error: judged.made ? INTERRUPTED_CREATE_RESUMABLE_NOTE : INTERRUPTED_CREATE_NOTHING_MADE_NOTE,
              result: { interrupted: true, lease_expired: true, code: "linkedin_ads_creation_incomplete" },
            },
            outcome: { ok: false, skipped: "interrupted" },
            log: null,
          };
        }
      }
      const unconfirmed = launch === "succeeded" ? INTERRUPTED_LAUNCH_CONFIRMED_NOTE : launch === "reconciled" ? INTERRUPTED_LAUNCH_RECONCILED_NOTE : checking;
      const creates = !!unconfirmed || execCreatesProviderObjects(execClass);
      return {
        settle: {
          tenant_id: claimed.tenant_id,
          claim_id: null,
          ok: false,
          exec_class: execClass ?? "",
          error: unconfirmed ?? (creates ? INTERRUPTED_CREATE_NOTE : INTERRUPTED_NOTE),
          result: {
            interrupted: true,
            lease_expired: true,
            ...(creates ? { code: "exec_outcome_unknown" } : {}),
          },
        },
        outcome: { ok: false, skipped: "interrupted" },
        log: null,
      };
    }
    return { settle: null, outcome: { ok: true, skipped: "not_queued" }, log: null };
  }

  const row = claimed.row;
  let accountLine: Promise<string> | null = null;
  const unchanged = () => (accountLine ??= accountLineForGate(row.exec_class, () => d.execProgressOf(row.tenant_id, actionId)));

  const disabled = await d.tenantDisabled(row.tenant_id);
  if (disabled === null && opts.retryable) {
    const released = await d.releaseClaim(actionId, row.claim_id).catch(() => false);
    if (released) throw new RetryableExecError("tenant_disabled_check_failed");
  }
  if (disabled !== false) {
    return {
      settle: {
        tenant_id: row.tenant_id,
        claim_id: row.claim_id,
        exec_class: row.exec_class,
        ok: false,
        error: disabled
          ? `This workspace is disabled, so Zavi did not apply this change. ${await unchanged()}`
          : `Zavi could not confirm this workspace is active, so it did not apply this change. ${await unchanged()} Approve it again to retry.`,
        result: { code: disabled ? "tenant_disabled" : "tenant_disabled_check_failed", ...untouched },
      },
      outcome: { ok: false, skipped: "tenant_disabled" },
      log: null,
    };
  }

  if (!(await d.writeEnabled(row.exec_class))) {
    const label = execPlatformLabel(row.exec_class);
    return {
      settle: {
        tenant_id: row.tenant_id,
        claim_id: row.claim_id,
        exec_class: row.exec_class,
        ok: false,
        error: `${label} changes are switched off at the platform level right now, so Zavi did not apply this one. ${await unchanged()} Approve it again once they are back on.`,
        result: { kill_switch: true, platform: execPlatform(row.exec_class), ...untouched },
      },
      outcome: { ok: false, skipped: "kill_switch" },
      log: null,
    };
  }

  if (ENVELOPE_CREATE_CLASSES.has(row.exec_class) && (await d.envelopeSwitchedOff(row, actionId))) {
    return {
      settle: {
        tenant_id: row.tenant_id,
        claim_id: row.claim_id,
        exec_class: row.exec_class,
        ok: false,
        error: `Launching ads straight from your ask is switched off right now, so Zavi did not launch this one. ${await unchanged()}`,
        result: { kill_switch: true, code: "ads_no_friction_off", ...untouched },
      },
      outcome: { ok: false, skipped: "kill_switch" },
      log: null,
    };
  }

  let testStopPause: "stop" | "resumed" | null = null;
  if (row.approved_by_source === "cgo" && /\.set_status$/.test(row.exec_class)) {
    try {
      testStopPause = await d.testStopPause(row.tenant_id, actionId, row.exec_class, row.exec_payload);
    } catch (e) {
      console.warn(`[dispatch-channel-action] ${actionId}: test stop authority unreadable: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  if (testStopPause === "resumed") {
    return {
      settle: {
        tenant_id: row.tenant_id,
        claim_id: row.claim_id,
        exec_class: row.exec_class,
        ok: false,
        error: "You switched this ad back on after Zavi stopped its test, so Zavi did not pause it again. Nothing in the account changed.",
        result: { code: "test_stop_founder_resumed", ...untouched },
      },
      outcome: { ok: false, skipped: "test_stop_founder_resumed" },
      log: null,
    };
  }

  if (isTierGatedChannel(row.channel_slug) && testStopPause !== "stop" && row.exec_class !== "linkedin_ads.set_status") {
    const lock = await d.channelLock(row.tenant_id, row.channel_slug);
    if (lock) {
      return {
        settle: {
          tenant_id: row.tenant_id,
          claim_id: row.claim_id,
        exec_class: row.exec_class,
          ok: false,
          error: `${planUpgradeMessage(row.channel_slug, lock.required_tier)} ${await unchanged()}`,
          result: { code: PLAN_UPGRADE_REQUIRED, required_tier: lock.required_tier, ...untouched },
        },
        outcome: { ok: false, skipped: "plan_upgrade_required" },
        log: null,
      };
    }
  }

  if (testStopPause !== "stop" && row.exec_class !== "linkedin_ads.set_status") {
    const stopped = await d.channelStopped(row.tenant_id, row.channel_slug);
    if (stopped === null && opts.retryable) {
      const released = await d.releaseClaim(actionId, row.claim_id).catch(() => false);
      if (released) throw new RetryableExecError("channel_stop_check_failed");
    }
    if (stopped !== false) {
      return {
        settle: {
          tenant_id: row.tenant_id,
          claim_id: row.claim_id,
          exec_class: row.exec_class,
          ok: false,
          error: stopped
            ? `You stopped this channel, so Zavi did not apply this change. ${await unchanged()}`
            : `Zavi could not check whether you stopped this channel, so it did not apply this change. ${await unchanged()} Approve it again to retry.`,
          result: { code: stopped ? "founder_stopped" : "channel_stop_check_failed", ...untouched },
        },
        outcome: { ok: false, skipped: "founder_stopped" },
        log: null,
      };
    }
  }

  const handler = await d.loadHandler(row.exec_class).catch(() => null);
  if (!handler) {
    return {
      settle: {
        tenant_id: row.tenant_id,
        claim_id: row.claim_id,
        exec_class: row.exec_class,
        ok: false,
        error: `No handler is registered for ${row.exec_class}.`,
        result: { no_handler: true, ...untouched },
      },
      outcome: { ok: false, skipped: "no_handler", error: `no handler for ${row.exec_class}` },
      log: null,
    };
  }

  const execRow = ENVELOPE_CREATE_CLASSES.has(row.exec_class)
    ? { ...row, exec_payload: await d.retimeFlight(row, actionId).catch(() => row.exec_payload) }
    : row;
  let result: ExecHandlerResult;
  const fence: WriteFence = { wrote: false };
  try {
    result = await runWithWriteFence(fence, () => handler(buildExecDecisionRow(actionId, execRow, testStopPause === "stop")));
  } catch (e) {
    if (opts.retryable && e instanceof ExpectedToolError && RETRYABLE_EXEC_CODES.has(e.code)) {
      const released = await d.releaseClaim(actionId, row.claim_id).catch(() => false);
      if (released) throw new RetryableExecError(e.code);
    }
    result = {
      ok: false,
      error: (e as Error).message,
      ...(e instanceof ExpectedToolError ? { code: e.code } : {}),
    };
  }

  if (result.ok && result.deferred) {
    return { settle: null, outcome: { ok: true, deferred: true }, log: null };
  }

  const receipt = result.ok ? safeExecReceipt(result.receipt) : null;
  const unwritten = !fence.wrote && FENCED_PLATFORMS.has(execPlatform(row.exec_class)) ? untouched : {};
  return {
    settle: {
      tenant_id: row.tenant_id,
      claim_id: row.claim_id,
      exec_class: row.exec_class,
      ok: result.ok,
      error: result.ok ? result.notice ?? null : result.error ?? "The change did not go through.",
      result: result.ok
        ? { ...(result.execution_details ? { execution_details: result.execution_details } : {}), notice: result.notice ?? null, ...(result.created ? { created: result.created } : {}), ...(result.cut_guard_override === true ? { cut_guard_override: true } : {}), ...(result.places_change ? { places_change: result.places_change } : {}), ...(result.location_undo ? { location_undo: result.location_undo } : {}), ...(receipt ? { receipt } : {}) }
        : result.held_for_founder
          ? { ...(result.execution_details ? { execution_details: result.execution_details } : {}), error: result.error ?? null, held_for_founder: true, ...(result.code ? { code: result.code } : {}), ...(result.not_sent ? { not_sent: true } : {}), ...unwritten }
          : result.code
            ? { ...(result.execution_details ? { execution_details: result.execution_details } : {}), error: result.error ?? null, code: result.code, ...(result.created ? { created: result.created } : {}), ...(result.checkout_url ? { checkout_url: result.checkout_url } : {}), ...(result.archived ? { archived: result.archived } : {}), ...(result.audience_mismatch ? { audience_mismatch: true } : {}), ...(result.not_sent ? { not_sent: true } : {}), ...unwritten }
            : { error: result.error ?? null, ...unwritten },
    },
    outcome: { ok: result.ok, error: result.error, notice: result.notice },
    log: {
      ok: result.ok,
      tenant_id: row.tenant_id,
      run_id: row.agent_run_id,
      channel_slug: row.channel_slug,
      message: `${row.channel_slug} ${row.exec_class}`,
    },
  };
}

export async function settleChannelActionOutcome(
  actionId: string,
  mutation: MutationResult,
  deps: Partial<ExecDeps> = {},
): Promise<ExecOutcome> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const owed = mutation.settle;
  let settlementLanded = false;
  let tellNow = false;
  if (owed) {
    const settled = await d.settle(owed.tenant_id, {
      actionId,
      ok: owed.ok,
      error: owed.error,
      result: owed.result,
      claimId: owed.claim_id,
      execClass: owed.exec_class ?? "",
    });
    const takeoverAlreadyDone = owed.claim_id === null && settled.code === "not_dispatching";
    if (!settled.ok && !takeoverAlreadyDone) {
      throw new Error(
        `settle_channel_action_exec refused for ${actionId}: ${settled.code ?? "unknown"}`,
      );
    }
    settlementLanded = settled.ok && !settled.replayed;
    const heldBack = (owed.result as { held_for_founder?: unknown } | null)?.held_for_founder === true;
    if (settlementLanded && !owed.ok && !heldBack) {
      await (await import("@/services/growth/move-group")).tellPairedPartialForAction(owed.tenant_id, actionId, owed.error);
    }
    tellNow = settled.ok;
  }
  if (mutation.log) {
    void logEvent({
      level: mutation.log.ok ? "info" : "warn",
      source: "channel_actions.exec",
      code: mutation.log.ok ? "channel.action_executed" : "channel.action_exec_failed",
      message: mutation.log.message,
      tenant_id: mutation.log.tenant_id,
      run_id: mutation.log.run_id ?? undefined,
    });
    if (mutation.log.ok && settlementLanded) {
      trackChannelActionExecuted({
        tenant_id: mutation.log.tenant_id,
        channel_slug: mutation.log.channel_slug,
      });
    }
  }
  if (owed && tellNow && owed.exec_class !== undefined && (owed.exec_class === "" || ENVELOPE_CREATE_CLASSES.has(owed.exec_class))) {
    const r = owed.result as { code?: unknown; created?: unknown; held_for_founder?: unknown };
    if (r.held_for_founder !== true) {
      const told = await d.tellOutcome({
        tenant_id: owed.tenant_id,
        action_id: actionId,
        ok: owed.ok,
        text: owed.error,
        code: typeof r.code === "string" ? r.code : null,
        created: r.created && typeof r.created === "object" ? (r.created as { object_type?: string; id?: string }) : null,
      }).catch(() => "failed");
      if (told === "failed") throw new Error(`direct-ask outcome for ${actionId} was not delivered; retrying the settle step`);
    }
  }
  if (owed && owed.ok && (owed.result as { location_undo?: unknown } | undefined)?.location_undo) {
    const { fileLocationUndoAfterSettle } = await import("@/services/tools/meta-ads/write/location-undo");
    await fileLocationUndoAfterSettle(owed.tenant_id, actionId, mutation.log?.run_id ?? null, (owed.result as { location_undo: unknown }).location_undo);
  }
  return mutation.outcome;
}

export async function executeChannelAction(
  actionId: string,
  deps: Partial<ExecDeps> = {},
): Promise<ExecOutcome> {
  return settleChannelActionOutcome(actionId, await runChannelActionMutation(actionId, deps), deps);
}

export const dispatchChannelActionFn = inngest.createFunction(
  { id: "dispatch-channel-action", retries: 4 },
  { event: "channel-action.approved" },
  async ({ event, step, logger, attempt }) => {
    const action_id = String(event.data?.action_id ?? "");
    if (!action_id) return { ok: false, error: "missing_action_id" };
    const mutation = await step.run("execute", () =>
      runChannelActionMutation(action_id, {}, { retryable: (attempt ?? 0) < 4, firstAttempt: (attempt ?? 0) === 0 }),
    );
    const res = await step.run("settle", () =>
      settleChannelActionOutcome(action_id, mutation as MutationResult),
    );
    if (!res.ok) {
      logger.warn(`dispatch-channel-action: ${action_id} — ${res.skipped ?? res.error}`);
    }
    return res;
  },
);
