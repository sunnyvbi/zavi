
import { readPairedLinkedInDecisions } from "@/services/approvals/linkedin-paired-decisions";
import { listingChannelOfRun, sitePrClassOfRun } from "@/services/channels/site-pr-run";
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import {
  SOCIAL_PUBLISH_CLASS,
  channelFieldsFromBody,
  channelSlugForDecision,
} from "./decision-channel";
import {
  channelActionCounts,
  mergeCounts,
  readOpenChannelActions,
  readOpenChannelActionSlugs,
  type ChannelActionApprovalRow,
} from "./channel-action-rows";
import {
  DECLINED_DECISIONS_VIEW,
  DEFERRED_DECISIONS_VIEW,
  mergeNotDoneCounts,
  readDeferredChannelActionCounts,
  readNotDoneDecisionCounts,
} from "./not-done-counts";
import { serverClientFromBearer } from "@/services/supabase";
import { lockedPreviewCounts } from "@/services/channels/channel-actions";
import { socialDraftVersion } from "@/services/approvals/social-draft-version";
import { approvalsListHome } from "@/services/approvals/list-home";
import { decisionFailureFix } from "@/services/channels/exec-failure";

const KNOWN_STATUSES = new Set([
  "proposed",
  "approved",
  "rejected",
  "dispatching",
  "acted",
  "failed",
  "dispatch_failed",
]);

export const PENDING_COUNT_SCAN_CAP = 2000;

export function pendingSource(statusFilter: string): string {
  return statusFilter === "proposed" ? "customer_visible_pending_decisions" : "decisions";
}

export function runGroupOf(d: {
  agent_run_id: string | null;
  body: unknown;
}): { run_id: string; position: number; of: number } | null {
  const b = (d.body ?? {}) as {
    position?: unknown;
    of?: unknown;
    origin_run_id?: unknown;
  };
  const runId =
    typeof b.origin_run_id === "string" && b.origin_run_id
      ? b.origin_run_id
      : d.agent_run_id;
  if (!runId || typeof b.position !== "number" || typeof b.of !== "number") {
    return null;
  }
  return { run_id: runId, position: b.position, of: b.of };
}

export function channelPendingCounts(
  rows: ReadonlyArray<{
    agent_run_id: string | null;
    decision_class?: string;
    brief_kind?: string | null;
    social_channel?: string | null;
  }>,
  channelOfRun: (runId: string) => string | null | undefined,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const slug = channelSlugForDecision(r, channelOfRun);
    if (!slug) continue;
    counts[slug] = (counts[slug] ?? 0) + 1;
  }
  return counts;
}

export async function approvalsList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const statusFilter =
    typeof req.query.status === "string" && KNOWN_STATUSES.has(req.query.status)
      ? req.query.status
      : "proposed";

  const includeRunMeta =
    req.query.include === undefined || req.query.include === "run_meta";

  const channelFilter =
    typeof req.query.channel === "string" && req.query.channel.length > 0
      ? req.query.channel
      : null;

  const supabase = serverClientFromBearer(auth.access_token);
  const pendingView = statusFilter === "proposed";
  if (channelFilter && !pendingView) {
    res.status(400).json({ error: { code: "invalid_query", message: "channel can only be combined with the pending view" } });
    return;
  }
  const pendingQuery = (columns: string) => {
    let q = supabase
      .from(pendingSource(statusFilter))
      .select(columns)
      .eq("tenant_id", auth.tenant_id);
    if (!pendingView) q = q.eq("status", statusFilter);
    return q;
  };
  const LIST_COLUMNS =
    "id, agent_run_id, decision_class, body, status, autonomy_at_emit, handler, emitted_at, approved_at, dispatched_at, dispatch_error";
  type DecisionRow = {
    id: string;
    agent_run_id: string | null;
    decision_class: string;
    body: unknown;
    emitted_at: string;
  } & Record<string, unknown>;

  if (req.query.home !== undefined) {
    await approvalsListHome({
      req,
      res,
      supabase,
      tenant_id: auth.tenant_id,
      source: pendingSource(statusFilter),
      statusFilter: pendingView ? null : statusFilter,
      listColumns: LIST_COLUMNS,
      runGroupOf,
    });
    return;
  }

  let decisions: DecisionRow[];
  if (!channelFilter) {
    const { data, error } = await pendingQuery(LIST_COLUMNS)
      .order("emitted_at", { ascending: false })
      .limit(100);
    if (error) {
      res.status(500).json({ error: { code: "list_failed", message: error.message } });
      return;
    }
    decisions = (data ?? []) as unknown as DecisionRow[];
  } else {
    const { data, error } = await pendingQuery(LIST_COLUMNS)
      .eq("home", "channel")
      .eq("home_channel", channelFilter)
      .order("emitted_at", { ascending: false })
      .limit(100);
    if (error) {
      res.status(500).json({ error: { code: "list_failed", message: error.message } });
      return;
    }
    decisions = (data ?? []) as unknown as DecisionRow[];
  }

  const channelActionRows: ChannelActionApprovalRow[] =
    pendingView && channelFilter
      ? await readOpenChannelActions(supabase, auth.tenant_id, channelFilter, 100)
      : [];

  const allowlistableSet = new Set<string>();
  {
    const { data: clsRows } = await supabase
      .from("decision_classes")
      .select("slug")
      .eq("click_allowlistable", true);
    for (const c of (clsRows ?? []) as Array<{ slug: string }>) {
      allowlistableSet.add(c.slug);
    }
  }
  const withAllowlistable = (d: { decision_class: string }) =>
    allowlistableSet.has(d.decision_class);

  if (!includeRunMeta) {
    res.json({
      decisions: [
        ...decisions.map((d) => ({
          ...d,
          ...(d.decision_class === SOCIAL_PUBLISH_CLASS ? { post_revision: socialDraftVersion(d.body) } : {}),
          run_group: runGroupOf(d),
          click_allowlistable: withAllowlistable(d),
          failure_fix: decisionFailureFix(d)?.text ?? null,
          action_source: "decision" as const,
        })),
        ...channelActionRows,
      ],
    });
    return;
  }

  const { data: allPendingRows } = await pendingQuery(
    "id, agent_run_id, decision_class, brief_kind:body->>brief_kind, social_channel:body->>channel",
  ).limit(PENDING_COUNT_SCAN_CAP);
  const allPending = (allPendingRows ?? []) as unknown as Array<{
    id: string;
    agent_run_id: string | null;
    decision_class: string;
    brief_kind: string | null;
    social_channel: string | null;
  }>;

  const runIds = [
    ...new Set(
      [...decisions, ...allPending, ...channelActionRows]
        .map((d) => d.agent_run_id)
        .filter((x): x is string => !!x),
    ),
  ];
  const runMeta = new Map<
    string,
    { agent_slug: string | null; thread_id: string | null; channel_slug: string | null; run_stopped: boolean }
  >();
  if (runIds.length > 0) {
    const { data: runs } = await supabase
      .from("agent_runs")
      .select("id, agent_slug, payload, channel_slug, enqueued_by, stop_requested")
      .eq("tenant_id", auth.tenant_id)
      .in("id", runIds);
    for (const r of runs ?? []) {
      const payload = (r.payload ?? {}) as {
        thread_id?: unknown;
        operator_thread_id?: unknown;
      };
      const threadId =
        typeof payload.thread_id === "string"
          ? payload.thread_id
          : typeof payload.operator_thread_id === "string"
            ? payload.operator_thread_id
            : null;
      runMeta.set(r.id as string, {
        agent_slug: (r.agent_slug as string | null) ?? null,
        thread_id: threadId,
        channel_slug: listingChannelOfRun({
          channel_slug: (r.channel_slug as string | null) ?? null,
          enqueued_by: (r as { enqueued_by?: string | null }).enqueued_by ?? null,
          site_pr_class: sitePrClassOfRun({ enqueued_by: (r as { enqueued_by?: string | null }).enqueued_by ?? null, payload: r.payload }),
        }),
        run_stopped: (r as { stop_requested?: unknown }).stop_requested === true,
      });
    }
  }

  const channelOfRun = (id: string) => runMeta.get(id)?.channel_slug;
  const pairedLinkedIn = pendingView ? await readPairedLinkedInDecisions(supabase, auth.tenant_id, allPending) : new Set<string>();
  const unpairedPending = allPending.filter(d => !pairedLinkedIn.has(d.id));
  const counts = pendingView
    ? mergeCounts(
        mergeCounts(
          channelPendingCounts(unpairedPending, channelOfRun),
          channelActionCounts(
            await readOpenChannelActionSlugs(supabase, auth.tenant_id, PENDING_COUNT_SCAN_CAP),
          ),
        ),
        await lockedPreviewCounts(auth.tenant_id),
      )
    : channelPendingCounts(allPending, channelOfRun);

  const runIdOf = (row: { agent_run_id: string | null; origin_run_id: string | null }) =>
    row.origin_run_id || row.agent_run_id;
  const notDoneByRun = pendingView
    ? mergeNotDoneCounts(
        mergeNotDoneCounts(
          await readNotDoneDecisionCounts(
            supabase,
            DEFERRED_DECISIONS_VIEW,
            auth.tenant_id,
            runIdOf,
            PENDING_COUNT_SCAN_CAP,
          ),
          await readNotDoneDecisionCounts(
            supabase,
            DECLINED_DECISIONS_VIEW,
            auth.tenant_id,
            runIdOf,
            PENDING_COUNT_SCAN_CAP,
          ),
        ),
        await readDeferredChannelActionCounts(supabase, auth.tenant_id, PENDING_COUNT_SCAN_CAP),
      )
    : {};

  const enriched = decisions.map((d) => {
    const meta = d.agent_run_id ? runMeta.get(d.agent_run_id) : undefined;
    return {
      ...d,
      ...(d.decision_class === SOCIAL_PUBLISH_CLASS ? { post_revision: socialDraftVersion(d.body) } : {}),
      agent_slug: meta?.agent_slug ?? null,
      thread_id: meta?.thread_id ?? null,
      run_stopped: meta?.run_stopped ?? false,
      channel_slug: channelSlugForDecision(
        {
          agent_run_id: d.agent_run_id,
          decision_class: d.decision_class,
          ...channelFieldsFromBody(d.body),
        },
        channelOfRun,
      ),
      run_group: runGroupOf(d),
      click_allowlistable: withAllowlistable(d),
      failure_fix: decisionFailureFix(d)?.text ?? null,
      action_source: "decision" as const,
    };
  });

  const channelActionsEnriched = channelActionRows.map((a) => {
    const meta = a.agent_run_id ? runMeta.get(a.agent_run_id) : undefined;
    return {
      ...a,
      agent_slug: meta?.agent_slug ?? null,
      thread_id: meta?.thread_id ?? null,
      run_stopped: meta?.run_stopped ?? false,
    };
  });

  res.json({
    decisions: [...enriched, ...channelActionsEnriched],
    channel_pending_counts: counts,
    run_not_done_counts: notDoneByRun,
  });
}
