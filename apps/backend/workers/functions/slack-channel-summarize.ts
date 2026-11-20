
import { MODELS } from "@/services/llm/models";
import { createHash } from "node:crypto";

import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { slackFetchWithBackoff } from "@/services/tools/slack/_retry";
import { redactValue } from "@/services/redactor";
import { getAnthropic, PRICING } from "@/services/anthropic";
import { estimateTokens } from "@/services/onboarding/enrichment/pricing";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

const SUMMARY_MODEL = MODELS.anthropic.sonnet;
const MAX_HISTORY_MESSAGES_PER_CHANNEL = 500;
const HISTORY_PAGE_SIZE = 200;
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 20;
const MAX_INPUT_TOKENS = 8000;
const MAX_OPUS_OUTPUT_TOKENS = 1024;
const OPUS_5XX_MAX_RETRIES = 3;
const SUMMARY_MD_HARD_CAP_CHARS = 1500;
const COLD_START_EXPECTED_CENTS = 1;
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

type ConnectorRow = { tenant_id: string };

type SlackChannelRow = {
  channel_id: string;
  team_id: string;
  name: string;
  is_archived: boolean;
  member_count: number;
  last_summary_cents: number | null;
};

type SlackAttachment = { text?: string; fallback?: string };

type SlackBlock = {
  type?: string;
  text?: { text?: string; type?: string };
  elements?: Array<{ text?: string; elements?: Array<{ text?: string }> }>;
};

type SlackFile = { name?: string; title?: string };

type SlackMessage = {
  ts?: string;
  thread_ts?: string;
  user?: string;
  username?: string;
  text?: string;
  subtype?: string;
  profile?: { display_name?: string; real_name?: string };
  attachments?: SlackAttachment[];
  blocks?: SlackBlock[];
  files?: SlackFile[];
  reactions?: Array<{ count?: number }>;
};

type HistoryResp = {
  ok?: boolean;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

type NormalizedMessage = {
  ts: string;
  user_label: string;
  text: string;
  quoted_text: string;
  file_names: string[];
  reactions_count: number;
  thread_ts?: string;
};

type OpusSidecar = {
  topics: string[];
  active_users: string[];
  message_count: number;
  distinct_user_count: number;
};

type OpusOutput = {
  summary_md: string;
  sidecar: OpusSidecar;
};

type ChannelOutcome =
  | { kind: "summarized"; cents: number }
  | { kind: "cap_hit"; attempted_cents: number; day_cents: number; cap_cents: number }
  | { kind: "skipped"; reason: string }
  | { kind: "deleted" }
  | { kind: "abort_tenant"; reason: string };

export const slackChannelSummarizeSchedulerFn = inngest.createFunction(
  { id: "slack-channel-summarize-scheduler", concurrency: 1, retries: 1 },
  { cron: "0 7 * * *" },
  async ({ step, logger }) => {
    if (isWorkerCronStopped("slack-channel-summarize")) {
      logger.info("slack-channel-summarize: skipped — not on the scheduled-work allowlist");
      return { cron_stopped: true as const };
    }
    const tenant_ids = await step.run("list-slack-tenants", async () => {
      const sb = serviceClient();
      const { data, error } = await sb
        .from("connector_metadata")
        .select("tenant_id")
        .eq("slug", "slack");
      if (error) throw new Error(`connector_metadata read: ${error.message}`);
      const rows = (data as ConnectorRow[] | null) ?? [];
      return Array.from(new Set(rows.map((r) => r.tenant_id))).filter(Boolean);
    });

    let queued = 0;
    const dispatched_at = new Date().toISOString();
    for (const tenant_id of tenant_ids) {
      try {
        await step.sendEvent("slack-channel-summarize-tenant-requested", {
          name: "slack.channel.summarize.tenant.requested",
          data: { tenant_id, dispatched_at },
        });
        queued += 1;
      } catch (err: unknown) {
        logger.warn(
          `slack-channel-summarize-scheduler: failed to enqueue tenant ${tenant_id}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
    logger.info(
      `slack-channel-summarize-scheduler: scanned=${tenant_ids.length} queued=${queued}`,
    );
    return { scanned: tenant_ids.length, queued };
  },
);

export const slackChannelSummarizeTenantFn = inngest.createFunction(
  {
    id: "slack-channel-summarize-tenant",
    concurrency: 4,
    retries: 2,
  },
  [
    { event: "slack.channel.summarize.tenant.requested" },
    { event: "slack.channel.summarize.requested" },
  ],
  async ({ event, step, logger }) => {
    const claimedTenantId = (event.data as { tenant_id?: string } | undefined)
      ?.tenant_id;
    if (!claimedTenantId || typeof claimedTenantId !== "string") {
      logger.warn(
        "slack-channel-summarize-tenant: missing tenant_id in event data",
      );
      return { status: "skip", reason: "missing_tenant_id" };
    }

    const sb = serviceClient();

    const connRes = await step.run(
      "C8-reverified-read-connector-row",
      async () => {
        const { data, error } = await sb
          .from("connector_metadata")
          .select("tenant_id")
          .eq("tenant_id", claimedTenantId)
          .eq("slug", "slack")
          .maybeSingle();
        if (error) throw new Error(`connector_metadata read: ${error.message}`);
        return (data as ConnectorRow | null) ?? null;
      },
    );
    if (!connRes) {
      logger.warn(
        `slack-channel-summarize-tenant: no slack connector_metadata for tenant ${claimedTenantId}; skipping`,
      );
      return { outcome: "no_connector_row" };
    }
    const tenant_id = connRes.tenant_id;

    const MAX_CHANNELS = parseInt(
      process.env.SLACK_SUMMARIZE_MAX_CHANNELS_PER_TENANT_PER_RUN ?? "180",
      10,
    );
    const CAP_CENTS = parseInt(
      process.env.SLACK_SUMMARY_DAILY_BUDGET_PER_TENANT_CENTS ?? "50",
      10,
    );
    const run_date = new Date().toISOString().slice(0, 10);

    const candidates = await step.run("read-channels", async () => {
      const { data, error } = await sb
        .from("slack_channels")
        .select("channel_id, team_id, name, is_archived, member_count, last_summary_cents")
        .eq("tenant_id", tenant_id)
        .order("last_summary_attempted_at", {
          ascending: true,
          nullsFirst: true,
        })
        .limit(MAX_CHANNELS);
      if (error) throw new Error(`slack_channels read: ${error.message}`);
      return (data as SlackChannelRow[] | null) ?? [];
    });

    const counters = {
      channels_attempted: 0,
      channels_summarized: 0,
      channels_skipped_cap: 0,
      channels_skipped_archived: 0,
      channels_skipped_small: 0,
      channels_skipped_other: 0,
      cap_hit_count: 0,
      messages_truncated_count: 0,
      rate_limit_hits: 0,
    };

    let abort: { reason: string } | null = null;

    for (let b = 0; b < candidates.length; b += BATCH_SIZE) {
      if (abort) break;
      const batch = candidates.slice(b, b + BATCH_SIZE);
      const batchIdx = Math.floor(b / BATCH_SIZE);
      const batchResult = await step.run(`batch-${batchIdx}`, async () => {
        const localAbort: { reason: string } | null = await processBatch(
          tenant_id,
          batch,
          CAP_CENTS,
          run_date,
          counters,
          logger,
        );
        return { abort: localAbort };
      });
      if (batchResult.abort) {
        abort = batchResult.abort;
        break;
      }
    }

    const oldest_h = await step.run("compute-oldest-age", async () => {
      const { data, error } = await sb
        .from("slack_channels")
        .select("last_summarized_at")
        .eq("tenant_id", tenant_id)
        .order("last_summarized_at", { ascending: true, nullsFirst: true })
        .limit(1);
      if (error) {
        logger.warn(
          `slack-channel-summarize-tenant: oldest_age read failed: ${error.message}`,
        );
        return null;
      }
      const rows = (data as Array<{ last_summarized_at: string | null }>) ?? [];
      const ts = rows[0]?.last_summarized_at;
      if (!ts) return null;
      return Math.round((Date.now() - new Date(ts).getTime()) / 3600000);
    });

    await step.run("audit-run", async () => {
      const idempotency_key = makeIdempotencyKey(
        tenant_id,
        "_run",
        run_date,
        "slack_summarize_run",
      );
      const meta = {
        tenant_id,
        channels_attempted: counters.channels_attempted,
        channels_summarized: counters.channels_summarized,
        channels_skipped_cap: counters.channels_skipped_cap,
        channels_skipped_archived: counters.channels_skipped_archived,
        channels_skipped_small: counters.channels_skipped_small,
        channels_skipped_other: counters.channels_skipped_other,
        cap_hit_count: counters.cap_hit_count,
        messages_truncated_count: counters.messages_truncated_count,
        rate_limit_hits: counters.rate_limit_hits,
        oldest_unsummarized_channel_age_h: oldest_h,
        aborted_reason: abort?.reason ?? null,
        idempotency_key,
      };
      const { error } = await sb.from("staff_audit_log").insert({
        actor_user_id: SYSTEM_ACTOR,
        actor_email: "system@zavi",
        action: "slack_summarize_run",
        target_table: "slack_channels",
        target_id: null,
        tenant_id,
        meta,
      });
      if (error && error.code !== "23505") {
        logger.warn(
          `slack-channel-summarize-tenant: audit-run insert failed: ${error.message}`,
        );
      }
    });

    return {
      outcome: abort ? "aborted" : "ok",
      tenant_id,
      ...counters,
      oldest_unsummarized_channel_age_h: oldest_h,
      aborted_reason: abort?.reason ?? null,
    };
  },
);

type Logger = { info: (m: string) => void; warn: (m: string) => void; error?: (m: string) => void };

async function processBatch(
  tenant_id: string,
  batch: SlackChannelRow[],
  cap_cents: number,
  run_date: string,
  counters: {
    channels_attempted: number;
    channels_summarized: number;
    channels_skipped_cap: number;
    channels_skipped_archived: number;
    channels_skipped_small: number;
    channels_skipped_other: number;
    cap_hit_count: number;
    messages_truncated_count: number;
    rate_limit_hits: number;
  },
  logger: Logger,
): Promise<{ reason: string } | null> {
  const sb = serviceClient();

  for (const row of batch) {
    counters.channels_attempted += 1;

    if (row.is_archived) {
      counters.channels_skipped_archived += 1;
      await stampAttempt(sb, tenant_id, row.team_id, row.channel_id);
      continue;
    }
    if (row.member_count < 3) {
      counters.channels_skipped_small += 1;
      await stampAttempt(sb, tenant_id, row.team_id, row.channel_id);
      continue;
    }

    const expected_cents = row.last_summary_cents ?? COLD_START_EXPECTED_CENTS;

    const { data: incData, error: incErr } = await sb.rpc(
      "slack_summary_budget_increment",
      {
        p_tenant_id: tenant_id,
        p_cents: expected_cents,
        p_cap_cents: cap_cents,
      },
    );
    if (incErr) {
      logger.warn(
        `slack-channel-summarize-tenant: budget_increment failed for ${row.channel_id}: ${incErr.message}`,
      );
      counters.channels_skipped_other += 1;
      await stampAttempt(sb, tenant_id, row.team_id, row.channel_id);
      continue;
    }
    const incRow = Array.isArray(incData) ? incData[0] : incData;
    const incOver = (incRow as { over?: boolean } | null)?.over === true;
    const incDayCents = (incRow as { new_cents?: number } | null)?.new_cents ?? 0;

    if (incOver) {
      counters.channels_skipped_cap += 1;
      counters.cap_hit_count += 1;
      await writeAudit(sb, {
        tenant_id,
        action: "slack_summarize_cap_hit",
        target_id: row.channel_id,
        meta: {
          tenant_id,
          channel_id: row.channel_id,
          attempted_cents: expected_cents,
          day_cents: incDayCents,
          cap_cents,
          idempotency_key: makeIdempotencyKey(
            tenant_id,
            row.channel_id,
            run_date,
            "slack_summarize_cap_hit",
            row.team_id,
          ),
        },
        logger,
      });
      await stampAttempt(sb, tenant_id, row.team_id, row.channel_id);
      continue;
    }

    const historyResult = await loadChannelHistory(
      tenant_id,
      row.team_id,
      row.channel_id,
      logger,
    );
    counters.rate_limit_hits += historyResult.rate_limit_hits;

    if (historyResult.kind === "slack_error") {
      const handled = await handleSlackError(
        sb,
        tenant_id,
        row.team_id,
        row.channel_id,
        historyResult.error,
        run_date,
        counters,
        logger,
      );
      if (handled.kind === "abort_tenant") {
        return { reason: handled.reason };
      }
      continue;
    }

    const normalized = normalizeMessages(historyResult.messages);

    let truncatedCount = 0;
    let toSend = normalized;
    while (toSend.length > 1) {
      if (estimateTokens(renderForTokenization(toSend)) <= MAX_INPUT_TOKENS) {
        break;
      }
      toSend = toSend.slice(0, toSend.length - 1);
      truncatedCount += 1;
    }
    if (truncatedCount > 0) counters.messages_truncated_count += truncatedCount;

    if (toSend.length === 0) {
      counters.channels_skipped_other += 1;
      await refundBudget(sb, tenant_id, expected_cents, cap_cents, logger);
      await writeAudit(sb, {
        tenant_id,
        action: "slack_summarize_skip",
        target_id: row.channel_id,
        meta: {
          tenant_id,
          channel_id: row.channel_id,
          reason: "no_messages_in_window",
          idempotency_key: makeIdempotencyKey(
            tenant_id,
            row.channel_id,
            run_date,
            "slack_summarize_skip",
            row.team_id,
          ),
        },
        logger,
      });
      await stampAttempt(sb, tenant_id, row.team_id, row.channel_id);
      continue;
    }

    let opusResult: OpusOutput | null = null;
    let opusInputTokens = 0;
    let opusOutputTokens = 0;
    let opusErrCode: string | null = null;
    for (let attempt = 0; attempt <= OPUS_5XX_MAX_RETRIES; attempt += 1) {
      try {
        const out = await callOpus(row.name, toSend);
        opusResult = out.parsed;
        opusInputTokens = out.input_tokens;
        opusOutputTokens = out.output_tokens;
        break;
      } catch (err: unknown) {
        const status = inferAnthropicStatus(err);
        if (typeof status === "number" && status >= 400 && status < 500) {
          opusErrCode = `opus_${status}`;
          break;
        }
        if (attempt === OPUS_5XX_MAX_RETRIES) {
          opusErrCode = `opus_${status ?? "5xx"}`;
          break;
        }
        const backoffSec = Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoffSec * 1000));
      }
    }

    if (!opusResult) {
      counters.channels_skipped_other += 1;
      await refundBudget(sb, tenant_id, expected_cents, cap_cents, logger);
      await writeAudit(sb, {
        tenant_id,
        action: "slack_summarize_skip",
        target_id: row.channel_id,
        meta: {
          tenant_id,
          channel_id: row.channel_id,
          reason: opusErrCode ?? "opus_unknown",
          messages_considered: toSend.length,
          messages_truncated: truncatedCount,
          idempotency_key: makeIdempotencyKey(
            tenant_id,
            row.channel_id,
            run_date,
            "slack_summarize_skip",
            row.team_id,
          ),
        },
        logger,
      });
      await stampAttempt(sb, tenant_id, row.team_id, row.channel_id);
      continue;
    }

    const actual_cents = Math.max(
      1,
      computeActualCents(opusInputTokens, opusOutputTokens),
    );

    const { data: recData, error: recErr } = await sb.rpc(
      "slack_summary_budget_reconcile",
      {
        p_tenant_id: tenant_id,
        p_estimated_cents: expected_cents,
        p_actual_cents: actual_cents,
        p_cap_cents: cap_cents,
      },
    );
    if (recErr) {
      logger.warn(
        `slack-channel-summarize-tenant: budget_reconcile failed for ${row.channel_id}: ${recErr.message}`,
      );
    }
    const recRow = Array.isArray(recData) ? recData[0] : recData;
    const recOver = (recRow as { over?: boolean } | null)?.over === true;

    const summary_md = clampLen(opusResult.summary_md, SUMMARY_MD_HARD_CAP_CHARS);
    const summary_sidecar = opusResult.sidecar;

    const now = new Date().toISOString();
    const { error: updErr } = await sb
      .from("slack_channels")
      .update({
        summary_md,
        summary_sidecar,
        last_summarized_at: now,
        last_summary_attempted_at: now,
        last_summary_cents: actual_cents,
        updated_at: now,
      })
      .eq("tenant_id", tenant_id)
      .eq("team_id", row.team_id)
      .eq("channel_id", row.channel_id);
    if (updErr) {
      logger.warn(
        `slack-channel-summarize-tenant: slack_channels update failed for ${row.channel_id}: ${updErr.message}`,
      );
      counters.channels_skipped_other += 1;
      continue;
    }

    counters.channels_summarized += 1;

    if (recOver) {
      return { reason: "reconcile_over_cap" };
    }
  }

  return null;
}

export function makeIdempotencyKey(
  tenant_id: string,
  channel_id: string,
  run_date: string,
  action: string,
  team_id?: string,
): string {
  const base = `${tenant_id}|${channel_id}|${run_date}|${action}`;
  return createHash("sha256")
    .update(team_id ? `${base}|${team_id}` : base)
    .digest("hex");
}

async function stampAttempt(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  team_id: string,
  channel_id: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sb
    .from("slack_channels")
    .update({ last_summary_attempted_at: now, updated_at: now })
    .eq("tenant_id", tenant_id)
    .eq("team_id", team_id)
    .eq("channel_id", channel_id);
}

async function writeAudit(
  sb: ReturnType<typeof serviceClient>,
  args: {
    tenant_id: string;
    action: string;
    target_id: string | null;
    meta: Record<string, unknown>;
    logger: Logger;
  },
): Promise<void> {
  const { error } = await sb.from("staff_audit_log").insert({
    actor_user_id: SYSTEM_ACTOR,
    actor_email: "system@zavi",
    action: args.action,
    target_table: "slack_channels",
    target_id: args.target_id,
    tenant_id: args.tenant_id,
    meta: args.meta,
  });
  if (error && error.code !== "23505") {
    args.logger.warn(
      `slack-channel-summarize-tenant: audit insert failed (action=${args.action}): ${error.message}`,
    );
  }
}

async function refundBudget(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  expected_cents: number,
  cap_cents: number,
  logger: Logger,
): Promise<void> {
  const { error } = await sb.rpc("slack_summary_budget_reconcile", {
    p_tenant_id: tenant_id,
    p_estimated_cents: expected_cents,
    p_actual_cents: 0,
    p_cap_cents: cap_cents,
  });
  if (error) {
    logger.warn(
      `slack-channel-summarize-tenant: refund reconcile failed: ${error.message}`,
    );
  }
}

type HistoryLoadResult =
  | { kind: "ok"; messages: SlackMessage[]; rate_limit_hits: number }
  | { kind: "slack_error"; error: string; rate_limit_hits: number };

async function loadChannelHistory(
  tenant_id: string,
  team_id: string,
  channel_id: string,
  logger: Logger,
): Promise<HistoryLoadResult> {
  const oldest = ((Date.now() - HISTORY_WINDOW_MS) / 1000).toFixed(6);
  const messages: SlackMessage[] = [];
  let cursor: string | undefined = undefined;
  let total_rate_limit_hits = 0;
  for (let page = 0; page < 10; page += 1) {
    const params: Record<string, string | number | boolean | undefined> = {
      channel: channel_id,
      oldest,
      limit: HISTORY_PAGE_SIZE,
    };
    if (cursor) params.cursor = cursor;
    const res = await slackFetchWithBackoff<HistoryResp>(
      tenant_id,
      "conversations.history",
      params,
      3,
      team_id,
    );
    total_rate_limit_hits += res.rate_limit_hits;
    if (!res.ok) {
      return {
        kind: "slack_error",
        error: res.error ?? "unknown",
        rate_limit_hits: total_rate_limit_hits,
      };
    }
    const body = res.data as HistoryResp | null;
    const page_messages = body?.messages ?? [];
    for (const m of page_messages) messages.push(m);
    if (messages.length >= MAX_HISTORY_MESSAGES_PER_CHANNEL) break;
    const next = body?.response_metadata?.next_cursor;
    if (!next) break;
    cursor = next;
  }
  if (messages.length > MAX_HISTORY_MESSAGES_PER_CHANNEL) {
    logger.info(
      `slack-channel-summarize-tenant: capping ${channel_id} history at ${MAX_HISTORY_MESSAGES_PER_CHANNEL} messages`,
    );
    messages.length = MAX_HISTORY_MESSAGES_PER_CHANNEL;
  }
  return { kind: "ok", messages, rate_limit_hits: total_rate_limit_hits };
}

async function handleSlackError(
  sb: ReturnType<typeof serviceClient>,
  tenant_id: string,
  team_id: string,
  channel_id: string,
  slack_error: string,
  run_date: string,
  counters: {
    channels_skipped_archived: number;
    channels_skipped_other: number;
  },
  logger: Logger,
): Promise<ChannelOutcome> {
  const now = new Date().toISOString();
  switch (slack_error) {
    case "not_in_channel": {
      await sb
        .from("slack_channels")
        .update({
          join_policy_status: "failed",
          skip_reason: "not_in_channel",
          last_summary_attempted_at: now,
          updated_at: now,
        })
        .eq("tenant_id", tenant_id)
        .eq("team_id", team_id)
        .eq("channel_id", channel_id);
      counters.channels_skipped_other += 1;
      await writeAudit(sb, {
        tenant_id,
        action: "slack_summarize_skip",
        target_id: channel_id,
        meta: {
          tenant_id,
          channel_id,
          reason: "not_in_channel",
          idempotency_key: makeIdempotencyKey(
            tenant_id,
            channel_id,
            run_date,
            "slack_summarize_skip",
            team_id,
          ),
        },
        logger,
      });
      return { kind: "skipped", reason: "not_in_channel" };
    }
    case "channel_not_found": {
      await sb
        .from("slack_channels")
        .delete()
        .eq("tenant_id", tenant_id)
        .eq("team_id", team_id)
        .eq("channel_id", channel_id);
      counters.channels_skipped_other += 1;
      await writeAudit(sb, {
        tenant_id,
        action: "slack_summarize_skip",
        target_id: channel_id,
        meta: {
          tenant_id,
          channel_id,
          reason: "channel_not_found_deleted",
          idempotency_key: makeIdempotencyKey(
            tenant_id,
            channel_id,
            run_date,
            "slack_summarize_skip",
            team_id,
          ),
        },
        logger,
      });
      return { kind: "deleted" };
    }
    case "is_archived": {
      await sb
        .from("slack_channels")
        .update({
          is_archived: true,
          last_summary_attempted_at: now,
          updated_at: now,
        })
        .eq("tenant_id", tenant_id)
        .eq("team_id", team_id)
        .eq("channel_id", channel_id);
      counters.channels_skipped_archived += 1;
      return { kind: "skipped", reason: "is_archived" };
    }
    case "missing_scope": {
      await writeAudit(sb, {
        tenant_id,
        action: "slack_summarize_missing_scope",
        target_id: null,
        meta: {
          tenant_id,
          channel_id,
          reason: "missing_scope",
          idempotency_key: makeIdempotencyKey(
            tenant_id,
            "_run",
            run_date,
            "slack_summarize_missing_scope",
          ),
        },
        logger,
      });
      counters.channels_skipped_other += 1;
      return { kind: "abort_tenant", reason: "missing_scope" };
    }
    case "invalid_auth": {
      await writeAudit(sb, {
        tenant_id,
        action: "slack_summarize_missing_scope",
        target_id: null,
        meta: {
          tenant_id,
          channel_id,
          reason: "invalid_auth",
          idempotency_key: makeIdempotencyKey(
            tenant_id,
            "_run",
            run_date,
            "slack_summarize_invalid_auth",
          ),
        },
        logger,
      });
      counters.channels_skipped_other += 1;
      return { kind: "abort_tenant", reason: "invalid_auth" };
    }
    default: {
      counters.channels_skipped_other += 1;
      await stampAttempt(sb, tenant_id, team_id, channel_id);
      await writeAudit(sb, {
        tenant_id,
        action: "slack_summarize_skip",
        target_id: channel_id,
        meta: {
          tenant_id,
          channel_id,
          reason: `slack_${slack_error}`,
          idempotency_key: makeIdempotencyKey(
            tenant_id,
            channel_id,
            run_date,
            "slack_summarize_skip",
            team_id,
          ),
        },
        logger,
      });
      return { kind: "skipped", reason: slack_error };
    }
  }
}

export function normalizeMessages(raw: SlackMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    if (m.subtype && /channel_(join|leave|topic|purpose|name)/.test(m.subtype)) {
      continue;
    }
    const ts = String(m.ts ?? "");
    const user_label = redactString(
      "display_name",
      profileDisplayName(m) ?? m.username ?? m.user ?? "",
    );
    const text = redactString("text", m.text ?? "");
    const quoted_text = redactString(
      "text",
      collectAttachmentAndBlockText(m),
    );
    const file_names = (m.files ?? [])
      .map((f) => redactString("file_name", f?.name ?? f?.title ?? ""))
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    const reactions_count = Array.isArray(m.reactions)
      ? m.reactions.reduce((s, r) => s + (typeof r?.count === "number" ? r.count : 0), 0)
      : 0;
    out.push({
      ts,
      user_label,
      text,
      quoted_text,
      file_names,
      reactions_count,
      thread_ts: m.thread_ts,
    });
  }
  return out;
}

function collectAttachmentAndBlockText(m: SlackMessage): string {
  const parts: string[] = [];
  for (const a of m.attachments ?? []) {
    if (a?.text) parts.push(a.text);
    else if (a?.fallback) parts.push(a.fallback);
  }
  for (const b of m.blocks ?? []) {
    const t = b?.text?.text;
    if (typeof t === "string") parts.push(t);
    for (const el of b?.elements ?? []) {
      if (typeof el?.text === "string") parts.push(el.text);
      for (const inner of el?.elements ?? []) {
        if (typeof inner?.text === "string") parts.push(inner.text);
      }
    }
  }
  return parts.join(" · ");
}

function redactString(column: string, raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const out = redactValue(column, raw);
  return typeof out === "string" ? out : String(out ?? "");
}

function renderForTokenization(msgs: NormalizedMessage[]): string {
  return JSON.stringify(msgs);
}

async function callOpus(
  channel_name: string,
  msgs: NormalizedMessage[],
): Promise<{ parsed: OpusOutput; input_tokens: number; output_tokens: number }> {
  const system_prompt = `You summarize a Slack channel's last 7 days of conversation for a company operator.
Output STRICT JSON only matching this schema:
{
  "summary_md": "<= 1500 char markdown summary",
  "sidecar": {
    "topics": ["..."],
    "active_users": ["..."],
    "message_count": <int>,
    "distinct_user_count": <int>
  }
}
Do not invent users. Use only labels present in the input. Never echo redaction markers like (redacted:email) into summary_md.`;

  const user_prompt = `Channel: #${channel_name}
Last 7 days of messages (newest first, JSON-encoded, PII pre-redacted):
${JSON.stringify(msgs)}`;

  const resp = await getAnthropic().messages.create({
    model: SUMMARY_MODEL,
    max_tokens: MAX_OPUS_OUTPUT_TOKENS,
    system: system_prompt,
    messages: [{ role: "user", content: user_prompt }],
  });

  const text = resp.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const parsed = safeParseOpus(text);
  const usage = resp.usage as { input_tokens: number; output_tokens: number };
  return {
    parsed,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
  };
}

export function safeParseOpus(text: string): OpusOutput {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(stripped);
  } catch {
    raw = {};
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const summary_md = typeof obj.summary_md === "string" ? obj.summary_md : "";
  const sidecarObj = (obj.sidecar ?? {}) as Record<string, unknown>;
  const topics = Array.isArray(sidecarObj.topics)
    ? sidecarObj.topics.filter((t): t is string => typeof t === "string")
    : [];
  const active_users = Array.isArray(sidecarObj.active_users)
    ? sidecarObj.active_users.filter((u): u is string => typeof u === "string")
    : [];
  const message_count =
    typeof sidecarObj.message_count === "number" ? sidecarObj.message_count : 0;
  const distinct_user_count =
    typeof sidecarObj.distinct_user_count === "number"
      ? sidecarObj.distinct_user_count
      : 0;
  return {
    summary_md,
    sidecar: { topics, active_users, message_count, distinct_user_count },
  };
}

export function clampLen(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export function computeActualCents(input_tokens: number, output_tokens: number): number {
  const p = PRICING[SUMMARY_MODEL];
  const usdPerMTokIn = p?.input ?? 5.0;
  const usdPerMTokOut = p?.output ?? 25.0;
  const usd =
    (input_tokens / 1_000_000) * usdPerMTokIn +
    (output_tokens / 1_000_000) * usdPerMTokOut;
  return Math.ceil(usd * 100);
}

function inferAnthropicStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return status;
  return undefined;
}

function profileDisplayName(m: SlackMessage): string | undefined {
  const profile = m.profile;
  return profile?.display_name ?? profile?.real_name;
}
