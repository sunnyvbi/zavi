
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting, getBoolSettingStrict } from "@/services/settings";
import { slackFetch } from "@/services/tools/slack/_client";
import {
  recordApprovalCardRef,
  resolveApprovalPostTarget,
} from "@/services/slack/approval-post-target";
import {
  buildApprovalBlocks,
  buildApprovalFallbackText,
  buildBatchControlBlocks,
  buildDigestBlocks,
  buildDigestFallbackText,
  type DigestItem,
} from "@/services/approvals/slack-approval-blocks";
import { GROWTH_PAGE_ONLY_NOT_IN } from "@/services/approvals/growth-page-only";
import { budgetChoiceNote } from "@/services/approvals/budget-choice";

const PM_NEEDS_ACTION_CLASS = "pm.needs_action";

export type PendingApprovalRow = {
  id: string;
  tenant_id: string;
  decision_class: string | null;
  agent_run_id: string | null;
  body: unknown;
  home_channel?: string | null;
  emitted_at?: string | null;
};

export const CHAT_CARD_GRACE_MS = 15 * 60 * 1000;

export type ChatCardEvent = { tenant_id: string; thread_id: string | null; decision_id: string;  full: boolean };

const CARD_LOOKUP_CHUNK = 100;
const CARD_LOOKUP_PAGE = 1000;

export async function loadChatCardEvents(ids: string[]): Promise<ChatCardEvent[] | null> {
  const out: ChatCardEvent[] = [];
  const unique = [...new Set(ids)];
  try {
    for (let i = 0; i < unique.length; i += CARD_LOOKUP_CHUNK) {
      const chunk = unique.slice(i, i + CARD_LOOKUP_CHUNK);
      for (let from = 0; ; from += CARD_LOOKUP_PAGE) {
        const { data, error } = await serviceClient()
          .from("thread_event")
          .select("id, tenant_id, thread_id, decision_id:body->>decision_id, full_card:body->>full_card")
          .eq("kind", "decision")
          .in("body->>decision_id", chunk)
          .order("id", { ascending: true })
          .range(from, from + CARD_LOOKUP_PAGE - 1);
        if (error) throw new Error(error.message);
        const page = (data ?? []) as Array<{ tenant_id?: unknown; thread_id?: unknown; decision_id?: unknown; full_card?: unknown }>;
        for (const r of page) {
          if (typeof r.tenant_id === "string" && typeof r.decision_id === "string") {
            out.push({ tenant_id: r.tenant_id, thread_id: typeof r.thread_id === "string" ? r.thread_id : null, decision_id: r.decision_id, full: r.full_card === "true" });
          }
        }
        if (page.length < CARD_LOOKUP_PAGE) break;
      }
    }
    return out;
  } catch (e) {
    console.warn(`[approval-slack-notify] chat-card lookup failed (chat-origin rows wait this cycle): ${(e as Error).message}`);
    return null;
  }
}

export async function loadIdsWithChatCard(rows: Array<{ id: string; tenant_id: string }>): Promise<Set<string> | null> {
  if (rows.length === 0) return new Set();
  const events = await loadChatCardEvents(rows.map((r) => r.id));
  if (events === null) return null;
  const tenantOf = new Map(rows.map((r) => [r.id, r.tenant_id]));
  return new Set(events.filter((e) => tenantOf.get(e.decision_id) === e.tenant_id).map((e) => e.decision_id));
}

export async function loadAllowlistableSet(): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const { data: clsRows } = await serviceClient()
      .from("decision_classes")
      .select("slug")
      .eq("click_allowlistable", true);
    for (const c of (clsRows ?? []) as Array<{ slug: string }>) {
      set.add(c.slug);
    }
  } catch (e) {
    console.warn(
      `[approval-slack-notify] click_allowlistable lookup failed (always-allow button hidden this cycle): ${(e as Error).message}`,
    );
  }
  return set;
}

const SLACK_SUPPRESSED_TRIGGERS = new Set(["chat", "channel_recipe"]);

const SLACK_SUPPRESSED_CLASSES = new Set(["channel.recipe_step"]);

export function isSlackSuppressedClass(row: { decision_class: string | null }): boolean {
  return !!row.decision_class && SLACK_SUPPRESSED_CLASSES.has(row.decision_class);
}

export async function loadChatOriginRunIds(runIds: string[]): Promise<Set<string>> {
  const set = new Set<string>();
  for (const [id, trigger] of await loadRunTriggers(runIds)) if (SLACK_SUPPRESSED_TRIGGERS.has(trigger)) set.add(id);
  return set;
}

export async function loadRunTriggers(runIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (runIds.length === 0) return map;
  try {
    const { data } = await serviceClient()
      .from("agent_runs")
      .select("id, trigger")
      .in("id", runIds);
    for (const r of (data ?? []) as Array<{ id: string; trigger: string | null }>) {
      if (r.trigger) map.set(r.id, r.trigger);
    }
  } catch (e) {
    console.warn(
      `[approval-slack-notify] run-trigger lookup failed (web-chat suppression skipped this cycle): ${(e as Error).message}`,
    );
  }
  return map;
}

export async function loadDecisionHandlers(): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  try {
    const { data: clsRows } = await serviceClient()
      .from("decision_classes")
      .select("slug, dispatch_handler");
    for (const c of (clsRows ?? []) as Array<{ slug: string; dispatch_handler: string | null }>) {
      map.set(c.slug, c.dispatch_handler);
    }
  } catch (e) {
    console.warn(
      `[approval-slack-notify] dispatch_handler lookup failed (generic consequence copy this cycle): ${(e as Error).message}`,
    );
  }
  return map;
}

export function buildBubble(
  row: PendingApprovalRow,
  allowlistableSet: Set<string>,
  handlerByClass?: Map<string, string | null>,
  web_only_note?: string | null,
) {
  const decision = {
    id: row.id,
    decision_class: row.decision_class,
    body: row.body,
    click_allowlistable: row.decision_class
      ? allowlistableSet.has(row.decision_class)
      : false,
    dispatch_handler: row.decision_class ? handlerByClass?.get(row.decision_class) ?? null : null,
    home_channel: row.home_channel ?? null,
    tenant_id: row.tenant_id,
    web_only_note: web_only_note ?? null,
  };
  return {
    blocks: buildApprovalBlocks(decision),
    fallback: buildApprovalFallbackText(decision),
  };
}

export async function postPendingApprovalBubblesForRun(args: {
  tenant_id: string;
  run_id: string;
  channel_id: string;
  thread_ts: string;
  team_id?: string;
  decision_ids?: string[];
}): Promise<{ posted: number; failed: number }> {
  const { tenant_id, run_id, channel_id, thread_ts, team_id } = args;
  if (!channel_id || !thread_ts) return { posted: 0, failed: 0 };

  let posted = 0;
  let failed = 0;

  const svc = serviceClient();
  const base = svc
    .from("decisions")
    .select("id, tenant_id, decision_class, agent_run_id, body, home_channel, emitted_at")
    .eq("tenant_id", tenant_id);
  const scoped = args.decision_ids && args.decision_ids.length > 0 ? base.in("id", args.decision_ids.slice(0, 50)) : base.eq("agent_run_id", run_id);
  const { data, error } = await scoped
    .eq("status", "proposed")
    .eq("autonomy_at_emit", "approval")
    .is("slack_approval_posted_at", null)
    .not("decision_class", "in", GROWTH_PAGE_ONLY_NOT_IN)
    .limit(50);

  if (error) {
    console.warn(
      `[approval-slack-notify] in-thread scan failed for run ${run_id}: ${error.message}`,
    );
    return { posted: 0, failed: 0 };
  }

  const rows = (data ?? []) as PendingApprovalRow[];
  if (rows.length === 0) return { posted: 0, failed: 0 };

  const allowlistableSet = await loadAllowlistableSet();
  const handlerByClass = await loadDecisionHandlers();

  for (const row of rows) {
    if (isSlackSuppressedClass(row)) continue;
    try {
      const { data: claimed } = await svc
        .from("decisions")
        .update({ slack_approval_posted_at: new Date().toISOString() })
        .eq("id", row.id)
        .is("slack_approval_posted_at", null)
        .select("id");
      if (!claimed || claimed.length === 0) continue;

      const { blocks, fallback } = buildBubble(row, allowlistableSet, handlerByClass, await budgetChoiceNote(row.tenant_id, row));
      const res = (await slackFetch(
        tenant_id,
        "chat.postMessage",
        { channel: channel_id, text: fallback, blocks: JSON.stringify(blocks), thread_ts },
        team_id,
      )) as { ts?: string };
      await recordApprovalCardRef({
        decision_id: row.id,
        tenant_id,
        channel_id,
        ts: res?.ts ?? "",
        team_id,
        card_text: fallback,
      });
      posted++;
    } catch (e) {
      failed++;
      try {
        await svc
          .from("decisions")
          .update({ slack_approval_posted_at: null })
          .eq("id", row.id);
      } catch {
      }
      console.warn(
        `[approval-slack-notify] in-thread post failed for run ${run_id} decision ${row.id} (claim released for retry): ${(e as Error).message}`,
      );
    }
  }

  if (posted > 1) {
    try {
      const cutoffMs = Date.now();
      const batchBlocks = buildBatchControlBlocks(run_id, posted, cutoffMs);
      await slackFetch(
        tenant_id,
        "chat.postMessage",
        {
          channel: channel_id,
          text: `${posted} approvals queued — approve or reject all`,
          blocks: JSON.stringify(batchBlocks),
          thread_ts,
        },
        team_id,
      );
    } catch (e) {
      console.warn(
        `[approval-slack-notify] in-thread batch card post failed for run ${run_id}: ${(e as Error).message}`,
      );
    }
  }

  return { posted, failed };
}

export { resolveApprovalPostTarget };

function toDigestItem(row: PendingApprovalRow): DigestItem {
  const body = (row.body ?? {}) as Record<string, unknown>;
  const theme =
    typeof body.theme === "string" && body.theme.trim() ? body.theme.trim() : "(untitled)";
  const exception_kind =
    typeof body.exception_kind === "string" && body.exception_kind.trim()
      ? body.exception_kind.trim()
      : "exception";
  return { id: row.id, theme, exception_kind };
}

export const MEETING_CONTENT_CLASS = "notetaker.write_atoms";

export async function meetingContentGate(rows: PendingApprovalRow[]): Promise<{ withheld: Set<string>; stamped: number }> {
  const withheld = new Set<string>();
  const meetingRows = rows.filter((r) => r.decision_class === MEETING_CONTENT_CLASS);
  if (meetingRows.length === 0) return { withheld, stamped: 0 };
  const svc = serviceClient();
  const tenants = [...new Set(meetingRows.map((r) => r.tenant_id))];
  let destination: Map<string, string | null> | null = null;
  try {
    const { data, error } = await svc.from("tenant_meeting_settings").select("tenant_id, recap_destination").in("tenant_id", tenants);
    if (error) throw new Error(error.message);
    destination = new Map(((data ?? []) as Array<{ tenant_id: string; recap_destination: string | null }>).map((d) => [d.tenant_id, d.recap_destination]));
  } catch (e) {
    console.warn(`[approval-slack-notify] meeting destination read failed (meeting cards withheld this cycle): ${(e as Error).message}`);
  }
  let stamped = 0;
  for (const row of meetingRows) {
    if (destination === null) {
      withheld.add(row.id);
      continue;
    }
    if (destination.get(row.tenant_id) === "slack") continue;
    withheld.add(row.id);
    const { error } = await svc
      .from("decisions")
      .update({ slack_push_suppressed_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("slack_push_suppressed_at", null);
    if (error) {
      console.warn(`[approval-slack-notify] meeting-card stamp failed for decision ${row.id} (withheld, retried next cycle): ${error.message}`);
      continue;
    }
    stamped++;
  }
  return { withheld, stamped };
}

export async function postApprovalBubblesBatch(
  allRows: PendingApprovalRow[],
  deps: { isDigestEnabled?: (tenant_id: string) => Promise<boolean> } = {},
): Promise<{
  posted: number;
  skipped_no_channel: number;
  skipped_web_chat: number;
  skipped_opted_out: number;
  failed: number;
  dm_fallback: number;
}> {
  let rows = allRows;
  let posted = 0;
  let skipped_no_channel = 0;
  let skipped_web_chat = 0;
  let skipped_opted_out = 0;
  let failed = 0;
  let dm_fallback = 0;

  const isDigestEnabled =
    deps.isDigestEnabled ?? ((t: string) => getBoolSetting("pm_needs_action_digest", t));

  const allowlistableSet = await loadAllowlistableSet();
  const handlerByClass = await loadDecisionHandlers();

  const runTriggers = await loadRunTriggers(
    rows.map((r) => r.agent_run_id).filter((id): id is string => !!id),
  );
  const triggerOf = (row: PendingApprovalRow): string | undefined => (row.agent_run_id ? runTriggers.get(row.agent_run_id) : undefined);
  const isChatOrigin = (row: PendingApprovalRow): boolean => triggerOf(row) === "chat";
  const chatCardIds = await loadIdsWithChatCard(rows.filter(isChatOrigin));
  const nowMs = Date.now();
  const chatCardMayLand = (row: PendingApprovalRow): boolean => {
    if (!isChatOrigin(row) || isSlackSuppressedClass(row)) return false;
    if (chatCardIds === null) return true;
    if (chatCardIds.has(row.id)) return false;
    const at = row.emitted_at ? Date.parse(row.emitted_at) : NaN;
    return Number.isFinite(at) && nowMs - at < CHAT_CARD_GRACE_MS;
  };
  rows = rows.filter((r) => !chatCardMayLand(r));
  const meetingGate = await meetingContentGate(rows);
  rows = rows.filter((r) => !meetingGate.withheld.has(r.id));
  skipped_opted_out += meetingGate.stamped;
  type PushPref = "on" | "off" | "unknown";
  const pushPref = new Map<string, PushPref>();
  for (const tid of new Set(rows.map((r) => r.tenant_id))) {
    try {
      pushPref.set(
        tid,
        (await getBoolSettingStrict("slack_approval_push_enabled", tid)) ? "on" : "off",
      );
    } catch (e) {
      pushPref.set(tid, "unknown");
      console.warn(
        `[approval-slack-notify] pref read FAILED for tenant ${tid} — not posting and NOT stamping; retried next cycle: ${(e as Error).message}`,
      );
    }
  }
  const isPushOptedOut = (row: PendingApprovalRow): boolean =>
    pushPref.get(row.tenant_id) !== "on";

  const isWebChat = (row: PendingApprovalRow): boolean => {
    if (isSlackSuppressedClass(row)) return true;
    const t = triggerOf(row);
    if (!t || !SLACK_SUPPRESSED_TRIGGERS.has(t)) return false;
    return t !== "chat" || !!chatCardIds?.has(row.id);
  };

  const digestRowIds = new Set<string>();
  const digestGroups: Array<{ tenant_id: string; agent_run_id: string; rows: PendingApprovalRow[] }> = [];
  {
    const byGroup = new Map<string, PendingApprovalRow[]>();
    for (const row of rows) {
      if (row.decision_class !== PM_NEEDS_ACTION_CLASS || !row.agent_run_id) continue;
      if (isPushOptedOut(row)) continue;
      if (isWebChat(row)) continue;
      const body = (row.body ?? {}) as Record<string, unknown>;
      if (body.coalesced === true || body.stuck_rollup === true) continue;
      const key = `${row.tenant_id}::${row.agent_run_id}`;
      const arr = byGroup.get(key) ?? [];
      arr.push(row);
      byGroup.set(key, arr);
    }
    const flagByTenant = new Map<string, boolean>();
    for (const groupRows of byGroup.values()) {
      if (groupRows.length < 2) continue;
      const tenant_id = groupRows[0].tenant_id;
      let enabled = flagByTenant.get(tenant_id);
      if (enabled === undefined) {
        try {
          enabled = await isDigestEnabled(tenant_id);
        } catch {
          enabled = false;
        }
        flagByTenant.set(tenant_id, enabled);
      }
      if (!enabled) continue;
      digestGroups.push({ tenant_id, agent_run_id: groupRows[0].agent_run_id as string, rows: groupRows });
      for (const r of groupRows) digestRowIds.add(r.id);
    }
  }

  const svc = serviceClient();

  const prefSuppressedIds = new Set<string>();
  for (const row of rows) {
    if (!isPushOptedOut(row)) continue;

    if (pushPref.get(row.tenant_id) !== "off") {
      prefSuppressedIds.add(row.id);
      continue;
    }

    const { error: stampErr } = await svc
      .from("decisions")
      .update({ slack_push_suppressed_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("slack_push_suppressed_at", null);

    prefSuppressedIds.add(row.id);
    if (stampErr) {
      console.warn(
        `[approval-slack-notify] opt-out stamp FAILED for decision ${row.id} (will retry next cycle): ${stampErr.message}`,
      );
      continue;
    }
    skipped_opted_out++;
  }

  const webChatSuppressedIds = new Set<string>();
  for (const row of rows) {
    if (prefSuppressedIds.has(row.id)) continue;
    if (!isWebChat(row)) continue;
    try {
      const { error: claimErr } = await svc
        .from("decisions")
        .update({ slack_approval_posted_at: new Date().toISOString() })
        .eq("id", row.id)
        .is("slack_approval_posted_at", null);
      if (claimErr) {
        console.warn(
          `[approval-slack-notify] web-chat suppression claim failed for decision ${row.id} (will post as before): ${claimErr.message}`,
        );
        continue;
      }
      webChatSuppressedIds.add(row.id);
      skipped_web_chat++;
    } catch (e) {
      console.warn(
        `[approval-slack-notify] web-chat suppression claim failed for decision ${row.id} (will post as before): ${(e as Error).message}`,
      );
    }
  }

  for (const group of digestGroups) {
    try {
      const target = await resolveApprovalPostTarget(group.tenant_id, group.agent_run_id);
      if (!target) {
        skipped_no_channel += group.rows.length;
        console.warn(
          `[approval-slack-notify] no post target for tenant ${group.tenant_id} pm-digest run ${group.agent_run_id} (${group.rows.length} decisions) — will retry`,
        );
        continue;
      }
      if (target.team_id) dm_fallback += 1;

      const claimed: PendingApprovalRow[] = [];
      for (const row of group.rows) {
        const { data: got } = await svc
          .from("decisions")
          .update({ slack_approval_posted_at: new Date().toISOString() })
          .eq("id", row.id)
          .is("slack_approval_posted_at", null)
          .select("id");
        if (got && (got as unknown[]).length > 0) claimed.push(row);
      }
      if (claimed.length === 0) continue;

      try {
        const items = claimed.map(toDigestItem);
        const blocks = buildDigestBlocks({ runId: group.agent_run_id, items, cutoffMs: Date.now() });
        await slackFetch(
          group.tenant_id,
          "chat.postMessage",
          {
            channel: target.channel,
            text: buildDigestFallbackText(claimed.length),
            blocks: JSON.stringify(blocks),
          },
          target.team_id,
        );
        posted += claimed.length;
      } catch (e) {
        for (const row of claimed) {
          try {
            await svc.from("decisions").update({ slack_approval_posted_at: null }).eq("id", row.id);
          } catch {
          }
        }
        failed += claimed.length;
        console.warn(
          `[approval-slack-notify] pm-digest post failed for tenant ${group.tenant_id} run ${group.agent_run_id}: ${(e as Error).message}`,
        );
      }
    } catch (e) {
      failed += group.rows.length;
      console.warn(
        `[approval-slack-notify] pm-digest group failed for tenant ${group.tenant_id} run ${group.agent_run_id}: ${(e as Error).message}`,
      );
    }
  }

  for (const row of rows) {
    if (digestRowIds.has(row.id)) continue;
    if (prefSuppressedIds.has(row.id)) continue;
    if (webChatSuppressedIds.has(row.id)) continue;
    try {
      const target = await resolveApprovalPostTarget(row.tenant_id, row.agent_run_id ?? "");
      if (!target) {
        skipped_no_channel++;
        console.warn(
          `[approval-slack-notify] no post target for tenant ${row.tenant_id} (no #zavi channel AND owner has no Slack DM) — decision ${row.id} not surfaced; will retry`,
        );
        continue;
      }
      if (target.team_id) dm_fallback++;

      const { blocks, fallback } = buildBubble(row, allowlistableSet, handlerByClass, await budgetChoiceNote(row.tenant_id, row));

      const postRes = (await slackFetch(
        row.tenant_id,
        "chat.postMessage",
        { channel: target.channel, text: fallback, blocks: JSON.stringify(blocks) },
        target.team_id,
      )) as { ts?: string };

      await recordApprovalCardRef({
        decision_id: row.id,
        tenant_id: row.tenant_id,
        channel_id: target.channel,
        ts: postRes?.ts ?? "",
        team_id: target.team_id,
        card_text: fallback,
      });

      await serviceClient()
        .from("decisions")
        .update({ slack_approval_posted_at: new Date().toISOString() })
        .eq("id", row.id)
        .is("slack_approval_posted_at", null);

      posted++;
    } catch (e) {
      failed++;
      console.warn(
        `[approval-slack-notify] post failed for tenant ${row.tenant_id} decision ${row.id}: ${(e as Error).message}`,
      );
    }
  }

  return { posted, skipped_no_channel, skipped_web_chat, skipped_opted_out, failed, dm_fallback };
}

export const approvalSlackNotifyFn = inngest.createFunction(
  { id: "approval-slack-notify", name: "Approval bubble — Slack auto-post" },
  { cron: "*/5 * * * *" },
  async ({ logger }) => {
    const { data, error } = await serviceClient()
      .from("decisions")
      .select("id, tenant_id, decision_class, agent_run_id, body, home_channel, emitted_at")
      .eq("status", "proposed")
      .eq("autonomy_at_emit", "approval")
      .is("slack_approval_posted_at", null)
      .not("decision_class", "in", GROWTH_PAGE_ONLY_NOT_IN)
      .is("slack_push_suppressed_at", null)
      .order("emitted_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(50);

    if (error) {
      logger?.warn?.(`approval-slack-notify scan failed: ${error.message}`);
      return { posted: 0, scanned: 0, error: error.message };
    }

    const rows = (data ?? []) as PendingApprovalRow[];
    if (rows.length === 0) return { posted: 0, scanned: 0 };

    const res = await postApprovalBubblesBatch(rows);
    logger?.info?.(
      `approval-slack-notify: posted ${res.posted}/${rows.length} ` +
        `(web-chat-suppressed ${res.skipped_web_chat}, no-channel ${res.skipped_no_channel}, failed ${res.failed})`,
    );
    return { scanned: rows.length, ...res };
  },
);
