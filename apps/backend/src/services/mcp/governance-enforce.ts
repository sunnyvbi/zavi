
import { ensureAdAccounts } from "@/services/connectors/tiktok-ads/ad-accounts";
import type { McpCallResult } from "./types";
import { getStringSetting } from "@/services/settings";
import { serviceClient } from "@/services/supabase";
import { INTERNAL_SERVERS, isSideEffectingTool } from "./tool-effect-classifier";
import { advertisedReadToolNames, advertisedComposioWriteTool } from "./streamable-client";
import { decodeRemoteToolName } from "./streamable-guards";
import { scrubSecretsFromArgs } from "./egress-secret-scrub";
import { approvalCardFor } from "./approval-cards";
import { moneyCardFingerprint } from "@/services/approvals/money-card";
import { emailSelfReplyReason } from "@/services/tools/email/send";
import { logEvent } from "@/services/logging/logEvent";
import { composioRailSlugs } from "@/services/connectors/composio/native-map";
import { toolkitForTool, classifyComposioWrite, actionWords, COMPOSIO_SHOPIFY_WRITE_CLASS } from "@/services/connectors/composio/write-classify";
import { composioWriteFingerprint } from "@/services/connectors/composio/fingerprint";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { toolkitDisplayName } from "@/services/connectors/composio/display-name";
import { isRawEmailSendAction, RAW_EMAIL_SEND_MESSAGE } from "@/services/connectors/email-campaign/providers";
import { isTiktokSpendWrite, TIKTOK_RAW_WRITE_MESSAGE } from "@/services/connectors/tiktok-ads/held-schema";
import { isRawPinterestWrite, PINTEREST_RAW_WRITE_MESSAGE } from "@/services/connectors/pinterest-composio/raw-write";
import { checkShopifyWrite, isShopifyGraphqlTool } from "@/services/connectors/shopify/writes";
import { shopifyGraphqlCallIsReadOnly } from "@/services/connectors/composio/write-classify";
import { resolveGovernanceVerdict, CLASS_DEFAULT_AUTONOMY, TOOL_DECISION_CLASS, type Autonomy } from "./governance-verdict";
import { isCustomAgentSlug as isCustomAgentSlugShape } from "@/services/billing/tiers";
import { isRunStopRequested } from "@/services/agents/run-stop";
import { isAgentKilled } from "@/services/agents/kill-switch";
import { assertProvisionedRepoTarget } from "@/services/provisioning/provisioned-repo-gate";
import {
  CUSTOM_AGENT_CHECK_FAILED_MESSAGE,
  CUSTOM_AGENT_PAUSED_MESSAGE,
  CUSTOM_AGENT_UNVERIFIED_MESSAGE,
  insertWriteReceipt,
  resolveCustomWriteRun,
  type CustomWriteIntent,
} from "@/services/agents/custom-agent-writes";
import { isAllowedWriteTool } from "./write-allowlist";
import { emailPlanModeOf } from "@/services/email-plan/mode";

export type GovernanceGate =
  | { block: false; customWrite?: CustomWriteIntent }
  | { block: true; result: McpCallResult };

type ChokepointCtx = {
  tenant_id: string;
  run_id?: string;
  agent_slug?: string;
  emit_decision?: (decision_class: string, body: unknown) => Promise<string>;
  trigger?: string;
  chat_thread_id?: string;
  governed_dispatch?: { decision_id: string; server_id: string; tool_name: string };
};

const GOVERNED_DISPATCH_ALLOWLIST: ReadonlySet<string> = new Set([
  "github__open_pr",
  "github__update_pr_branch",
  "github__squash_merge",
]);

function isAlreadyGovernedDispatch(
  ctx: ChokepointCtx,
  server_id: string,
  tool_name: string,
): boolean {
  const m = ctx.governed_dispatch;
  if (!m || m.server_id !== server_id || m.tool_name !== tool_name) return false;
  return GOVERNED_DISPATCH_ALLOWLIST.has(`${server_id}__${tool_name}`);
}

async function isRunStoppedNow(ctx: ChokepointCtx): Promise<boolean> {
  try {
    if (ctx.run_id && (await isRunStopRequested(ctx.run_id))) return true;
    if (ctx.agent_slug && (await isAgentKilled(ctx.tenant_id, ctx.agent_slug))) return true;
    return false;
  } catch {
    return false;
  }
}

const isInternalServer = (server_id: string): boolean =>
  INTERNAL_SERVERS.has(server_id);

const makeRemoteReadCheck =
  (tenant_id: string) =>
  (server_id: string, tool_name: string): boolean => {
    try {
      return advertisedReadToolNames(tenant_id, server_id)?.has(tool_name) ?? false;
    } catch {
      return false;
    }
  };

async function resolveAutonomy(
  tenant_id: string,
  decision_class: string,
): Promise<Autonomy> {
  const fallback: Autonomy = CLASS_DEFAULT_AUTONOMY[decision_class] ?? "approval";
  try {
    const { data, error } = await serviceClient().rpc("effective_autonomy", {
      p_tenant_id: tenant_id,
      p_decision_class: decision_class,
    });
    if (error || typeof data !== "string") return fallback;
    if (data === "auto" || data === "approval" || data === "forbidden") return data;
    return fallback;
  } catch {
    return fallback;
  }
}

const PROVISIONED_AUTO_GITHUB_TOOLS: ReadonlySet<string> = new Set([
  "open_pr",
  "push_to_main",
  "push_branch",
  "open_pr_from_branch",
  "add_label",
]);

async function isProvisionedRepoGithubAuto(
  tenant_id: string,
  server_id: string,
  tool_name: string,
  args: unknown,
): Promise<boolean> {
  if (server_id !== "github" || !PROVISIONED_AUTO_GITHUB_TOOLS.has(tool_name)) {
    return false;
  }
  const a = (args ?? {}) as { owner?: unknown; repo?: unknown };
  const owner = typeof a.owner === "string" ? a.owner.trim() : "";
  const repo = typeof a.repo === "string" ? a.repo.trim() : "";
  if (!owner || !repo) return false;
  try {
    const gate = await assertProvisionedRepoTarget(tenant_id, `${owner}/${repo}`);
    return gate.ok === true;
  } catch {
    return false;
  }
}

const INTERACTIVE_TRIGGERS: ReadonlySet<string> = new Set([
  "chat",
  "slack",
  "teams",
  "telegram",
]);

async function isInteractiveAuthorizedGithubOpenPrAuto(
  ctx: ChokepointCtx,
  server_id: string,
  tool_name: string,
): Promise<boolean> {
  if (server_id !== "github" || tool_name !== "open_pr") return false;
  if (!ctx.run_id) return false;
  try {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("trigger")
      .eq("id", ctx.run_id)
      .maybeSingle();
    if (error || !data) return false;
    const trigger = (data as { trigger?: string | null }).trigger;
    return typeof trigger === "string" && INTERACTIVE_TRIGGERS.has(trigger);
  } catch {
    return false;
  }
}

async function isWeeklyPlanRunPlanSendAuto(
  ctx: ChokepointCtx,
  server_id: string,
  tool_name: string,
): Promise<boolean> {
  if (server_id !== "email" || tool_name !== "plan_send" || !ctx.run_id) return false;
  try {
    const { data, error } = await serviceClient()
      .from("agent_runs")
      .select("agent_slug, trigger, payload")
      .eq("id", ctx.run_id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (error || !data) return false;
    const run = data as { agent_slug?: string | null; trigger?: string | null; payload?: unknown };
    return (
      run.agent_slug === "email_marketing" &&
      run.trigger === "channel_recipe" &&
      emailPlanModeOf(run.payload)?.mode === "weekly_plan"
    );
  } catch {
    return false;
  }
}

function blocked(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): GovernanceGate {
  return {
    block: true,
    result: {
      ok: false,
      is_error: true,
      content: JSON.stringify({ error: code, message, ...(extra ?? {}) }),
      ms: 0,
    },
  };
}

const PRAXIS_ACTION_VERBS: ReadonlySet<string> = new Set([
  "file-jira-issue",
  "file-linear-issue",
  "post-slack-message",
]);

function isCustomGateRead(server_id: string, tool_name: string): boolean {
  if (server_id === "memory") return tool_name === "read";
  if (server_id === "operator_db") return true;
  return false;
}

function customWriteClass(
  ctx: ChokepointCtx,
  server_id: string,
  tool_name: string,
  args: unknown,
): { write: boolean; decision_class: string | null } {
  const key = `${server_id}__${tool_name}`;
  if (server_id === "praxis") {
    if (tool_name !== "action") return { write: false, decision_class: null };
    const verb = (args as { verb?: unknown } | null | undefined)?.verb;
    return {
      write: true,
      decision_class:
        typeof verb === "string" && PRAXIS_ACTION_VERBS.has(verb) ? `operator.${verb}` : null,
    };
  }
  if (isCustomGateRead(server_id, tool_name)) return { write: false, decision_class: null };
  if (isAllowedWriteTool(server_id, tool_name) || isSideEffectingTool(server_id, tool_name)) {
    return { write: true, decision_class: TOOL_DECISION_CLASS[key] ?? null };
  }
  try {
    const v = resolveGovernanceVerdict(
      server_id,
      tool_name,
      isInternalServer,
      makeRemoteReadCheck(ctx.tenant_id),
    );
    return { write: v.governed, decision_class: v.decision_class };
  } catch {
    return { write: true, decision_class: null };
  }
}

async function customAgentWriteGate(
  ctx: ChokepointCtx,
  server_id: string,
  tool_name: string,
  args: unknown,
): Promise<GovernanceGate | null> {
  if (!ctx.agent_slug || !isCustomAgentSlugShape(ctx.agent_slug)) return null;
  const { write, decision_class } = customWriteClass(ctx, server_id, tool_name, args);
  if (!write) return null;
  const tag = `${server_id}__${tool_name}`;
  const run = await resolveCustomWriteRun(ctx.tenant_id, ctx.run_id, ctx.agent_slug);
  switch (run.state) {
    case "not_custom":
      return null;
    case "error":
      return blocked("custom_agent_check_failed", CUSTOM_AGENT_CHECK_FAILED_MESSAGE);
    case "unverified":
      return blocked("custom_agent_unverified", CUSTOM_AGENT_UNVERIFIED_MESSAGE);
    case "blocked": {
      const { state: _s, status, ...facts } = run;
      await insertWriteReceipt(facts, tag, decision_class, "blocked_paused", status);
      return blocked("custom_agent_paused", CUSTOM_AGENT_PAUSED_MESSAGE, { status });
    }
    case "admitted": {
      if (await isRunStoppedNow(ctx)) {
        return blocked(
          "run_cancelled",
          `This action (${tag}) was not sent — the run was stopped before it could fire.`,
        );
      }
      const { state: _s, ...facts } = run;
      return { block: false, customWrite: { run: facts, tool_name: tag, decision_class } };
    }
  }
}

export async function governActionOrBlock(
  ctx: ChokepointCtx,
  server_id: string,
  tool_name: string,
  args?: unknown,
): Promise<GovernanceGate> {
  const custom = await customAgentWriteGate(ctx, server_id, tool_name, args);
  if (custom?.block) return custom;

  if (server_id === "composio") {
    const emailSend = decodeRemoteToolName(tool_name);
    if (isRawEmailSendAction(emailSend)) return rawEmailSendRefusal(emailSend);
    if (isTiktokSpendWrite(emailSend)) return rawTiktokSpendRefusal(emailSend);
    if (isRawPinterestWrite(emailSend)) return rawPinterestWriteRefusal(emailSend);
    if (isShopifyGraphqlTool(emailSend) && !shopifyGraphqlCallIsReadOnly(emailSend, args)) {
      return governComposioWrite(ctx, tool_name, args, { destructive: false });
    }
    const w = advertisedComposioWriteTool(ctx.tenant_id, tool_name);
    if (w) return governComposioWrite(ctx, tool_name, args, w);
  }

  if (custom) return custom;

  let mode: string;
  try {
    mode = await getStringSetting("governed_chokepoint", ctx.tenant_id);
  } catch {
    mode = "enforce";
  }
  if (mode === "off") return { block: false };

  let verdict;
  try {
    verdict = resolveGovernanceVerdict(
      server_id,
      tool_name,
      isInternalServer,
      makeRemoteReadCheck(ctx.tenant_id),
    );
  } catch (e) {
    if (mode === "enforce") {
      return blocked(
        "governance_resolver_error",
        "Action governance could not be resolved; blocked (fail-closed).",
      );
    }
    return { block: false };
  }

  if (!verdict.governed) {
    if (verdict.self_governed && (await isRunStoppedNow(ctx))) {
      return blocked(
        "run_cancelled",
        `This action (${server_id}__${tool_name}) was not run — the run was stopped before it could fire.`,
      );
    }
    return { block: false };
  }

  if (await isRunStoppedNow(ctx)) {
    return blocked(
      "run_cancelled",
      `This action (${server_id}__${tool_name}) was not sent — the run was stopped before it could fire.`,
    );
  }

  const autonomy: Autonomy =
    isAlreadyGovernedDispatch(ctx, server_id, tool_name)
      ? "auto"
      : (await isProvisionedRepoGithubAuto(ctx.tenant_id, server_id, tool_name, args))
    ? "auto"
    :
      (await isInteractiveAuthorizedGithubOpenPrAuto(ctx, server_id, tool_name))
      ? "auto"
      : (await isWeeklyPlanRunPlanSendAuto(ctx, server_id, tool_name))
        ? "auto"
        : verdict.mapped && verdict.decision_class
          ? await resolveAutonomy(ctx.tenant_id, verdict.decision_class)
          : "approval";

  const tag = `${server_id}__${tool_name}`;

  if (mode === "shadow") {
    console.warn(
      `[governed-chokepoint:shadow] tool=${tag} class=${verdict.decision_class ?? "UNMAPPED"} ` +
        `mapped=${verdict.mapped} autonomy=${autonomy} run=${ctx.run_id ?? "?"}`,
    );
    return { block: false };
  }

  if (autonomy === "auto") {
    return { block: false };
  }

  if (autonomy === "forbidden") {
    return blocked(
      "action_forbidden",
      `This action (${tag}) is forbidden by your workspace's autonomy policy.`,
    );
  }

  if (ctx.emit_decision && verdict.decision_class) {
    const card = approvalCardFor(server_id, tool_name);
    if (!card || card.kind === "refuse") {
      return blocked(
        "typed_card_required",
        card?.reason ??
          `This action (${tag}) has no approval card that shows the founder the exact action, so it cannot be queued. Tell the founder what you wanted to do.`,
        { decision_class: verdict.decision_class },
      );
    }
    const { scrubbed } = scrubSecretsFromArgs(args ?? {});
    let built: Awaited<ReturnType<typeof card.build>>;
    try {
      built = await card.build(JSON.parse(JSON.stringify(scrubbed ?? {})), { tenant_id: ctx.tenant_id });
    } catch {
      built = { ok: false, reason: "The card could not be built. Try again." };
    }
    if (built.ok && tag === "email__send" && ctx.run_id) {
      const selfReply = await emailSelfReplyReason(ctx.tenant_id, ctx.run_id, String(built.body.to ?? ""));
      if (selfReply) return blocked("reply_is_automatic", selfReply, { decision_class: verdict.decision_class });
    }
    if (!built.ok) {
      return blocked("invalid_action", `This action (${tag}) could not be queued for approval. ${built.reason}`, {
        decision_class: verdict.decision_class,
      });
    }
    const decision_class = built.decision_class ?? verdict.decision_class;
    const fingerprint = moneyCardFingerprint(decision_class, built.body);
    try {
      const decision_id = await ctx.emit_decision(decision_class, {
        ...built.body,
        server_id,
        tool_name,
        governed_by: "chokepoint",
        ...(fingerprint ? { fingerprint } : {}),
      });
      return blocked(
        "pending_approval",
        `This action (${tag}) is waiting for the founder's approval. It has NOT run.`,
        { decision_id, decision_class },
      );
    } catch (e) {
      return blocked(
        "governance_emit_failed",
        `This action (${tag}) requires approval but the approval could not be queued; blocked (fail-closed).`,
      );
    }
  }

  return blocked(
    "approval_channel_unavailable",
    `This action (${tag}) requires approval but no approval channel is available on this run; blocked (fail-closed).`,
    { decision_class: verdict.decision_class },
  );
}

async function tiktokAdAccountLabel(tenantId: string, advertiserId: unknown): Promise<{ advertiser_id: string; name: string } | null> {
  if (typeof advertiserId !== "string" || !advertiserId) return null;
  try {
    const found = (await ensureAdAccounts(tenantId)).accounts.find((a) => a.advertiser_id === advertiserId);
    return { advertiser_id: advertiserId, name: found?.name ?? advertiserId };
  } catch {
    return { advertiser_id: advertiserId, name: advertiserId };
  }
}

function rawTiktokSpendRefusal(tool_slug: string): GovernanceGate {
  return blocked("use_tiktok_ads_propose_tool", `This action (${tool_slug}) was not run and nothing was proposed. ${TIKTOK_RAW_WRITE_MESSAGE}`);
}

function rawPinterestWriteRefusal(tool_slug: string): GovernanceGate {
  return blocked("use_social_propose_post", `This action (${tool_slug}) was not run and nothing was proposed. ${PINTEREST_RAW_WRITE_MESSAGE}`);
}

function rawEmailSendRefusal(tool_slug: string): GovernanceGate {
  return blocked("use_email_campaign_tool", `This action (${tool_slug}) was not run and nothing was proposed. ${RAW_EMAIL_SEND_MESSAGE}`);
}

async function governComposioWrite(
  ctx: ChokepointCtx,
  tool_name: string,
  args: unknown,
  w: { destructive: boolean },
): Promise<GovernanceGate> {
  const tool_slug = decodeRemoteToolName(tool_name);
  if (await isRunStoppedNow(ctx)) {
    return blocked("run_cancelled", `This action (${tool_slug}) was not sent. The run was stopped.`);
  }
  if (ctx.trigger !== "chat" || !ctx.chat_thread_id) {
    void logEvent({
      level: "warn",
      source: "composio.govern",
      code: "composio_write_needs_chat",
      tenant_id: ctx.tenant_id,
    }).catch(() => {});
    return blocked(
      "composio_write_needs_chat",
      "Actions in connected apps can only be proposed in a chat with the founder.",
    );
  }
  let toolkit: string | null;
  try {
    const { data, error } = await serviceClient()
      .from("connector_metadata")
      .select("slug")
      .eq("tenant_id", ctx.tenant_id)
      .like("slug", "composio.%");
    if (error) throw new Error(error.message);
    const connected = composioRailSlugs(((data ?? []) as { slug: string }[]).map((r) => r.slug));
    toolkit = await toolkitForTool(tool_slug, connected);
  } catch {
    void logEvent({
      level: "error",
      source: "composio.govern",
      code: "composio_connection_check_failed",
      tenant_id: ctx.tenant_id,
      meta: { tool_name: tool_slug },
    }).catch(() => {});
    return blocked(
      "composio_connection_check_failed",
      `This action (${tool_slug}) was not sent: we could not check your connected apps. Try again.`,
    );
  }
  if (!toolkit) {
    return blocked("composio_app_not_connected", `This action (${tool_slug}) needs its app connected in Settings first.`);
  }
  if (isRawEmailSendAction(tool_slug, toolkit)) return rawEmailSendRefusal(tool_slug);
  if (isTiktokSpendWrite(tool_slug, toolkit)) return rawTiktokSpendRefusal(tool_slug);
  if (isRawPinterestWrite(tool_slug, toolkit)) return rawPinterestWriteRefusal(tool_slug);
  const shopify = toolkit === "shopify" ? checkShopifyWrite(tool_slug, args) : null;
  if (shopify && !shopify.ok) {
    return blocked("shopify_write_not_allowed", `This action (${tool_slug}) was not run and nothing was proposed. ${shopify.message}`);
  }
  let account: Awaited<ReturnType<typeof resolveOwnedComposioAccount>>;
  try {
    account = await resolveOwnedComposioAccount(ctx.tenant_id, toolkit);
  } catch {
    void logEvent({
      level: "error",
      source: "composio.govern",
      code: "composio_connection_check_failed",
      tenant_id: ctx.tenant_id,
      meta: { tool_name: tool_slug },
    }).catch(() => {});
    return blocked(
      "composio_connection_check_failed",
      `This action (${tool_slug}) was not sent: we could not check your connected apps. Try again.`,
    );
  }
  if (!account) {
    return blocked("composio_app_not_connected", `This action (${tool_slug}) needs its app connected in Settings first.`);
  }
  const classification = { destructive: w.destructive };
  const { labels, decision_class } = classifyComposioWrite({ toolkit, tool_slug, ...classification });
  const autonomy = decision_class === COMPOSIO_SHOPIFY_WRITE_CLASS ? "approval" : await resolveAutonomy(ctx.tenant_id, decision_class);
  if (autonomy === "forbidden") {
    return blocked("action_forbidden", `This action (${tool_slug}) is forbidden by your workspace's autonomy policy.`);
  }
  if (!ctx.emit_decision) {
    return blocked(
      "approval_channel_unavailable",
      `This action (${tool_slug}) requires approval but no approval channel is available on this run; blocked (fail-closed).`,
      { decision_class },
    );
  }
  const { scrubbed } = scrubSecretsFromArgs(args ?? {});
  const frozenArgs = JSON.parse(JSON.stringify(scrubbed ?? {})) as Record<string, unknown>;
  const adAccount = toolkit === "tiktok_ads" ? await tiktokAdAccountLabel(ctx.tenant_id, frozenArgs.advertiser_id) : null;
  try {
    const body = {
      kind: "composio_write",
      server_id: "composio",
      tool_slug,
      toolkit,
      app_name: toolkitDisplayName(toolkit),
      action: shopify?.ok ? shopify.action : actionWords(tool_slug, toolkit),
      arguments: frozenArgs,
      classification,
      labels,
      governed_by: "chokepoint",
      connected_account_id: account.connected_account_id,
      auth_config_id: account.auth_config_id,
      ...(adAccount ? { ad_account: adAccount } : {}),
    };
    const fingerprint = composioWriteFingerprint({ ...body, decision_class });
    const { data: open } = !ctx.run_id ? { data: null } : await serviceClient()
      .from("decisions")
      .select("id")
      .eq("tenant_id", ctx.tenant_id)
      .eq("agent_run_id", ctx.run_id)
      .eq("status", "proposed")
      .is("superseded_at", null)
      .eq("body->>fingerprint", fingerprint)
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (open) {
      return blocked(
        "pending_approval",
        `This exact action (${tool_slug}) is already waiting for the founder's approval on an earlier card. It has NOT run. Do not propose it again.`,
        { decision_id: open.id, decision_class },
      );
    }
    const decision_id = await ctx.emit_decision(decision_class, { ...body, fingerprint });
    return blocked(
      "pending_approval",
      `This action (${tool_slug}) is waiting for the founder's approval. It has NOT run.`,
      { decision_id, decision_class },
    );
  } catch {
    return blocked(
      "governance_emit_failed",
      `This action (${tool_slug}) requires approval but the approval could not be queued; blocked (fail-closed).`,
    );
  }
}
