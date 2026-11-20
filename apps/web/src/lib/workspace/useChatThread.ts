"use client";

import { parseConnectorOffline, parseDbNotConnected, type ConnectorOfflineInfo } from "@/components/workspace/actions/dbChatCards";
import { parseBuildConfirm, type BuildConfirm } from "./buildConfirm";
import { parseRuleSuggestion, type RuleSuggestion } from "./ruleSuggestion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";
import { parseOfferedTeamNote, pickStripNote, type OfferedTeamNote } from "./teamNote";
import { useRealtimeChannel } from "./useRealtimeChannel";
import { detailedActivityByRun, mergeActivityRows } from "./mergeActivityRows";
import { readScrubbedOverflow } from "./chatOverflow";
import {
  readSummonedSurface,
  type SummonedSurfaceRef,
} from "./summonedSurface";
import {
  TERMINAL_AGENT_RUN_STATUSES,
  PAUSED_AWAITING_APPROVAL_STATUS,
  PAUSED_AWAITING_CHILD_STATUS,
} from "./useInlineStatus";
import type { Citation } from "@/lib/citations";
import { parseFigureReceipts, type FigureReceiptMeta } from "@/components/workspace/receipts/receiptData";
import { parseConnectorRequest, type ConnectorRequest } from "@zavi/shared";
import { parseCustomAgentCard, type CustomAgentCardData } from "./customAgentCard";
import { shareStableRowMap, shareStableRows } from "./stableRows";
import { registerSessionScopedCache } from "./sessionScopedCache";
import { notifyWorkspaceFilesChanged } from "./useWorkspaceFiles";

function sameAgentSlug(stored: string, requested: string): boolean {
  if (stored === requested) return true;
  return (
    (stored === "content-seo" && requested === "content-design") ||
    (stored === "content-design" && requested === "content-seo")
  );
}

export type ActiveRunTimes = {
  started_at: string | null;
  enqueued_at: string | null;
};

export function pickRunStartedAt(args: {
  rsCreatedAt?: string | null;
  userMsgCreatedAt?: string | null;
  runTimes?: ActiveRunTimes | null;
}): string | null {
  return (
    args.rsCreatedAt ??
    args.userMsgCreatedAt ??
    args.runTimes?.started_at ??
    args.runTimes?.enqueued_at ??
    null
  );
}

export function pickTurnStartedAt(args: {
  userMsgCreatedAt?: string | null;
  runTimes?: ActiveRunTimes | null;
}): string | null {
  return (
    args.userMsgCreatedAt ??
    args.runTimes?.started_at ??
    args.runTimes?.enqueued_at ??
    null
  );
}

export type ChatRowKind =
  | "chat_user"
  | "chat_assistant"
  | "decision"
  | "chat_system"
  | "chat_activity";

export type ChatRow = {
  id: string;
  kind: ChatRowKind;
  agent_run_id: string | null;
  body: unknown;
  citations: Citation[];
  created_at: string;
  trigger?: string;
  tools?: string[];
  brainProvenance?: { crossThreadHits: string[] } | null;
  figureReceipts?: FigureReceiptMeta[];
  unverifiedFigures?: string[];
  suggestions?: string[];
  attachments?: { path: string; kind?: "image" | "doc" }[] | null;
  artifacts?: ArtifactRow[];
  standingOrder?: boolean;
  fromAgentSlug?: string;
  viaEmail?: boolean;
  childRunIds?: string[];
  summonedSurface?: SummonedSurfaceRef;
  connectorRequest?: ConnectorRequest;
  customAgentCard?: CustomAgentCardData;
  buildConfirm?: BuildConfirm;
  ruleSuggestion?: RuleSuggestion;
  connectorOffline?: ConnectorOfflineInfo;
  dbNotConnected?: true;
  pickedDepth?: "light" | "deep";
  staffModelKey?: string;
  modelUsed?: string;
  teamNoteFlag?: OfferedTeamNote;
};

export function cardsUnderReply(rows: ChatRow[]): ChatRow[] {
  const lastReply = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.kind === "chat_assistant" && r.agent_run_id) lastReply.set(r.agent_run_id, i);
  });
  const moved = new Map<number, ChatRow[]>();
  const out: ChatRow[] = [];
  rows.forEach((r, i) => {
    const at = r.kind === "decision" && r.agent_run_id ? lastReply.get(r.agent_run_id) : undefined;
    if (at !== undefined && at > i) moved.set(at, [...(moved.get(at) ?? []), r]);
    else out.push(r);
    if (moved.has(i)) out.push(...moved.get(i)!);
  });
  return out;
}

export function dedupeLegacyRepoAccessPrompts(rows: ChatRow[]): ChatRow[] {
  const out: ChatRow[] = [];
  for (const row of rows) {
    const prev = out.at(-1);
    if (
      prev?.kind === "chat_user" &&
      row.kind === "chat_user" &&
      (
        (prev.body as { text?: unknown })?.text as string | undefined
      )?.trim() ===
        (
          (row.body as { text?: unknown })?.text as string | undefined
        )?.trim() &&
      Boolean(prev.agent_run_id) !== Boolean(row.agent_run_id) &&
      Math.abs(
        new Date(row.created_at).getTime() -
          new Date(prev.created_at).getTime(),
      ) <= 10_000
    ) {
      if (row.agent_run_id) out[out.length - 1] = row;
      continue;
    }
    out.push(row);
  }
  return out;
}

export type ActiveRunEta = {
  p50_ms: number;
  p95_ms: number;
  basis: string;
};

export type ArtifactRow = {
  id: string;
  filename: string;
  title?: string | null;
  mime: string;
  bytes: number;
};

const PAGE_LIMIT = 200;

type UseChatThread = {
  rows: ChatRow[];
  activityRows: ChatRow[];
  activityByRun: Map<string, ChatRow[]>;
  loading: boolean;
  hasMore: boolean;
  errorMsg: string | null;
  notFound: boolean;
  activeRunId: string | null;
  activeTrigger: string | null;
  activeRunStartedAt: string | null;
  activeRunTurnStartedAt: string | null;
  activeRunEta: ActiveRunEta | null;
  offeredTeamNote: OfferedTeamNote | null;
  teamNoteTurnKey: string | null;
  refetch: () => Promise<void>;
  appendOptimisticUser: (
    text: string,
    attachments?: { path: string; kind?: "image" | "doc" }[],
    opts?: { persists?: boolean; settleLater?: boolean },
  ) => string | undefined;
  settleOptimisticUser: (
    id: string,
    accepted: { userMessageId: string | null } | null,
  ) => void;
  removeOptimisticUser: (id: string) => void;
  appendOptimisticSystem: (text: string, opts?: { persists?: boolean }) => void;
  markRunStopped: (runId: string) => void;
  unmarkRunStopped: (runId: string) => void;
  hideRows: (ids: string[]) => void;
  unhideRows: (ids: string[]) => void;
};

export type LoadedThreadMeta = {
  id: string;
  title: string | null;
  last_message_at: string;
  created_at: string;
};

export type ThreadEventRow = {
  id: number;
  agent_run_id: string | null;
  thread_id?: string | null;
  kind: string;
  body: Record<string, unknown>;
  citations: Citation[];
  created_at: string;
};

type AgentMsgRow = {
  id: string;
  tenant_id?: string | null;
  body: string;
  sender_role: "user" | "assistant" | "system";
  agent_run_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  attachments: { path: string }[] | null;
};

type OptimisticUserRow = {
  id: string;
  text: string;
  created_at: string;
  priorDbCount: number;
  attachments?: { path: string; kind?: "image" | "doc" }[];
  userMessageId?: string;
};

type OptimisticSystemRow = {
  id: string;
  text: string;
  created_at: string;
};

function countUserTexts(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

export type ThreadSnapshot = {
  rows: ChatRow[];
  activityRows: ChatRow[];
  activityByRun: Map<string, ChatRow[]>;
  hasMore: boolean;
  activeRunId: string | null;
  activeTrigger: string | null;
  activeRunStartedAt: string | null;
  activeRunTurnStartedAt: string | null;
  activeRunEta: ActiveRunEta | null;
  offeredTeamNote: OfferedTeamNote | null;
};

type ThreadLoadResult =
  | { kind: "stale" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | {
      kind: "loaded";
      snapshot: ThreadSnapshot;
      thread: LoadedThreadMeta | null;
      dbUserTexts: string[];
    };

type BrowserSupabase = ReturnType<typeof createBrowserSupabase>;

const NO_STOPPED_RUNS: ReadonlySet<string> = new Set();

const FILE_KIND_LABEL: Record<string, string> = {
  file_read: "Read",
  file_edit: "Edit",
  file_create: "Write",
};

async function fetchThreadMessages(
  sb: BrowserSupabase,
  threadId: string,
): Promise<{ rows: AgentMsgRow[]; error: string | null }> {
  const { data: msgs, error } = await sb
    .from("agent_thread_messages")
    .select("id, tenant_id, body, sender_role, agent_run_id, meta, created_at, attachments")
    .eq("thread_id", threadId)
    .filter("meta->>superseded_by", "is", null)
    .order("created_at", { ascending: false })
    .limit(PAGE_LIMIT);
  return {
    rows: (msgs ?? []) as AgentMsgRow[],
    error: error ? error.message : null,
  };
}

async function fetchThreadEvents(
  sb: BrowserSupabase,
  agentSlug: string,
  threadId: string | null,
): Promise<ThreadEventRow[] | null> {
  let { data: eventData, error: eventErr } = await sb.rpc("get_agent_thread", {
    p_agent_slug: agentSlug,
    p_limit: PAGE_LIMIT,
    p_thread_id: threadId,
  });
  if (
    eventErr &&
    (eventErr.code === "PGRST202" ||
      /get_agent_thread.*schema cache|find the function .*get_agent_thread/i.test(
        eventErr.message,
      ))
  ) {
    ({ data: eventData, error: eventErr } = await sb.rpc("get_agent_thread", {
      p_agent_slug: agentSlug,
      p_limit: PAGE_LIMIT,
    }));
  }
  if (eventErr) {
    console.warn(
      `[useChatThread] broadcast layer (get_agent_thread) degraded — rendering thread-scoped messages only: ${eventErr.message}`,
    );
  }
  return (eventData ?? null) as ThreadEventRow[] | null;
}

async function loadThreadSnapshot(
  sb: BrowserSupabase,
  agentSlug: string,
  threadId: string | undefined,
  stoppedRunIds: ReadonlySet<string>,
  isStale: () => boolean,
): Promise<ThreadLoadResult> {
  let resolvedThreadId: string | null = null;
  let resolvedThread: LoadedThreadMeta | null = null;
  let userChatMsgs: AgentMsgRow[] = [];
  let eventData: ThreadEventRow[] | null = null;
  let noteTenantId: string | null = null;

  if (threadId === undefined) {
    const tid = await getActiveTenantId(sb);
    if (isStale()) return { kind: "stale" };
    noteTenantId = tid;
    let latestQuery = sb
      .from("agent_threads")
      .select("id, title, last_message_at, created_at")
      .eq("agent_slug", agentSlug);
    if (tid) latestQuery = latestQuery.eq("tenant_id", tid);
    const { data, error: latestError } = await latestQuery
      .is("deleted_at", null)
      .is("email_thread_id", null)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (isStale()) return { kind: "stale" };
    if (latestError) return { kind: "error", message: latestError.message };
    if (data) {
      resolvedThreadId = data.id;
      resolvedThread = data as LoadedThreadMeta;
    }
    const [msgs, events] = await Promise.all([
      resolvedThreadId
        ? fetchThreadMessages(sb, resolvedThreadId)
        : Promise.resolve({ rows: [] as AgentMsgRow[], error: null }),
      fetchThreadEvents(sb, agentSlug, resolvedThreadId),
    ]);
    if (msgs.error) return { kind: "error", message: msgs.error };
    userChatMsgs = msgs.rows;
    eventData = events;
  } else {
    const [meta, msgs, events, activeTid] = await Promise.all([
      sb
        .from("agent_threads")
        .select("id, agent_slug, title, last_message_at, created_at")
        .eq("id", threadId)
        .maybeSingle(),
      fetchThreadMessages(sb, threadId),
      fetchThreadEvents(sb, agentSlug, threadId),
      getActiveTenantId(sb).catch(() => null),
    ]);
    noteTenantId = activeTid;
    const { data, error } = meta;
    if (isStale()) return { kind: "stale" };
    if (error) return { kind: "error", message: error.message };
    if (!data || !sameAgentSlug(data.agent_slug, agentSlug)) {
      return { kind: "not_found" };
    }
    if (msgs.error) return { kind: "error", message: msgs.error };
    resolvedThreadId = data.id;
    resolvedThread = data as LoadedThreadMeta;
    userChatMsgs = msgs.rows;
    eventData = events;
  }
  if (isStale()) return { kind: "stale" };

  const userChatRunIds = new Set<string>();
  for (const m of userChatMsgs) {
    if (m.agent_run_id) userChatRunIds.add(m.agent_run_id);
  }
  const teRows = (eventData ?? []).slice().reverse();

  const toolsByRun = new Map<string, string[]>();
  for (const r of teRows) {
    if (!r.agent_run_id) continue;
    let name: string | null = null;
    if (r.kind === "tool_call") {
      const tn = (r.body as Record<string, unknown>)?.tool_name;
      name = typeof tn === "string" && tn.trim() ? tn : "tool";
    } else if (r.kind in FILE_KIND_LABEL) {
      name = FILE_KIND_LABEL[r.kind];
    }
    if (!name) continue;
    const list = toolsByRun.get(r.agent_run_id) ?? [];
    if (!list.includes(name)) list.push(name);
    toolsByRun.set(r.agent_run_id, list);
  }

  let trailingPendingRun: string | undefined;
  if (resolvedThreadId) {
    const userMsgRuns = userChatMsgs
      .filter((m) => m.sender_role === "user" && m.agent_run_id)
      .map((m) => m.agent_run_id as string);
    const assistantRuns = new Set(
      userChatMsgs
        .filter((m) => m.sender_role === "assistant" && m.agent_run_id)
        .map((m) => m.agent_run_id as string),
    );
    trailingPendingRun = userMsgRuns.find(
      (id) => !assistantRuns.has(id) && !stoppedRunIds.has(id),
    );
  }

  const out: ChatRow[] = [];

  const userTextByRun = new Map<string, string>();
  for (const m of userChatMsgs) {
    if (m.sender_role === "user" && m.agent_run_id && typeof m.body === "string") userTextByRun.set(m.agent_run_id, m.body);
  }

  const teamNotes: OfferedTeamNote[] = [];
  const teamNoteRows = new Map<string, ChatRow>();

  for (const m of userChatMsgs) {
    if (m.sender_role === "user") {
      out.push({
        id: `m:${m.id}`,
        kind: "chat_user",
        agent_run_id: m.agent_run_id,
        body: { text: m.body },
        citations: [],
        created_at: m.created_at,
        attachments: m.attachments ?? null,
        ...(isViaEmail(m.meta) ? { viaEmail: true } : {}),
      });
    } else if (m.sender_role === "assistant") {
      const trig =
        m.meta && typeof m.meta === "object"
          ? ((m.meta as Record<string, unknown>).trigger as string | undefined)
          : undefined;
      const envelope =
        m.meta && typeof m.meta === "object"
          ? (m.meta as Record<string, unknown>).envelope
          : undefined;
      const fullReplyMarkdown = readScrubbedOverflow(m.meta);
      const brainProvenance: { crossThreadHits: string[] } | null = (() => {
        if (!m.meta || typeof m.meta !== "object") return null;
        const bp = (m.meta as Record<string, unknown>).brain_provenance;
        if (!bp || typeof bp !== "object") return null;
        const arr = (bp as Record<string, unknown>).cross_thread_hits;
        if (!Array.isArray(arr)) return null;
        const crossThreadHits = arr.filter(
          (t): t is string => typeof t === "string" && t.length > 0,
        );
        if (crossThreadHits.length === 0) return null;
        return { crossThreadHits };
      })();
      const childRunIds: string[] | undefined = (() => {
        if (!m.meta || typeof m.meta !== "object") return undefined;
        const arr = (m.meta as Record<string, unknown>).child_run_ids;
        if (!Array.isArray(arr)) return undefined;
        const ids = arr.filter(
          (t): t is string => typeof t === "string" && t.length > 0,
        );
        return ids.length > 0 ? ids : undefined;
      })();
      const suggestions: string[] | undefined = (() => {
        if (!m.meta || typeof m.meta !== "object") return undefined;
        const arr = (m.meta as Record<string, unknown>).suggestions;
        if (!Array.isArray(arr)) return undefined;
        const s = arr.filter(
          (t): t is string => typeof t === "string" && t.trim().length > 0,
        );
        return s.length > 0 ? s : undefined;
      })();
      const summonedSurface = readSummonedSurface(m.meta) ?? undefined;
      const connectorRequest =
        m.meta && typeof m.meta === "object"
          ? (parseConnectorRequest(
              (m.meta as Record<string, unknown>).connector_request,
            ) ?? undefined)
          : undefined;
      const metaObj =
        m.meta && typeof m.meta === "object"
          ? (m.meta as Record<string, unknown>)
          : null;
      const customAgentCard = parseCustomAgentCard(metaObj?.custom_agent_draft) ?? undefined;
      const figureReceipts = parseFigureReceipts(metaObj?.figure_receipts);
      const answerSources = metaObj?.answer_sources as { unverified?: unknown } | undefined;
      const unverifiedFigures = Array.isArray(answerSources?.unverified)
        ? (answerSources.unverified as unknown[]).filter((f): f is string => typeof f === "string" && f.length > 0).slice(0, 40)
        : [];
      const buildConfirm = parseBuildConfirm(metaObj?.build_confirm);
      const ruleSuggestion = parseRuleSuggestion(metaObj?.rule_suggestion);
      const connectorOffline = parseConnectorOffline(metaObj, m.agent_run_id ? (userTextByRun.get(m.agent_run_id) ?? null) : null);
      const dbNotConnected = parseDbNotConnected(metaObj);
      const standingOrder = metaObj?.standing_order === true ? true : undefined;
      const fromAgentSlug =
        typeof metaObj?.from_agent_slug === "string" &&
        metaObj.from_agent_slug.length > 0
          ? (metaObj.from_agent_slug as string)
          : undefined;
      const teamNote = noteTenantId && m.tenant_id === noteTenantId
        ? parseOfferedTeamNote({ id: m.id, meta: m.meta })
        : null;
      const assistantRow: ChatRow = {
        id: `m:${m.id}`,
        kind: "chat_assistant",
        agent_run_id: m.agent_run_id,
        childRunIds,
        standingOrder,
        fromAgentSlug,
        ...(isViaEmail(m.meta) ? { viaEmail: true } : {}),
        body: { text: m.body, envelope, fullReplyMarkdown },
        citations: [],
        created_at: m.created_at,
        trigger: trig ?? "chat",
        tools: m.agent_run_id ? (toolsByRun.get(m.agent_run_id) ?? []) : [],
        brainProvenance,
        suggestions,
        summonedSurface,
        connectorRequest,
        buildConfirm,
        ruleSuggestion,
        customAgentCard,
        ...(figureReceipts.length > 0 ? { figureReceipts } : {}),
        ...(unverifiedFigures.length > 0 ? { unverifiedFigures } : {}),
        ...(connectorOffline ? { connectorOffline } : {}),
        ...(dbNotConnected ? { dbNotConnected } : {}),
      };
      out.push(assistantRow);
      if (teamNote) {
        teamNotes.push(teamNote);
        teamNoteRows.set(teamNote.messageId, assistantRow);
      }
    }
  }

  const offeredTeamNote = pickStripNote(teamNotes, userChatMsgs);
  for (const n of teamNotes) {
    if (n.messageId === offeredTeamNote?.messageId) continue;
    const row = teamNoteRows.get(n.messageId);
    if (row) row.teamNoteFlag = n;
  }

  for (const r of teRows) {
    if (r.kind === "decision") {
      if (!r.agent_run_id || !userChatRunIds.has(r.agent_run_id)) continue;
      out.push({
        id: `te:${r.id}`,
        kind: "decision",
        agent_run_id: r.agent_run_id,
        body: { ...(r.body as Record<string, unknown>), shown_at: r.created_at },
        citations: r.citations ?? [],
        created_at: r.created_at,
      });
    }
  }

  out.sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );
  out.splice(0, out.length, ...cardsUnderReply(dedupeLegacyRepoAccessPrompts(out)));

  const artifactRunIds = Array.from(
    new Set(
      out
        .filter((r) => r.kind === "chat_assistant")
        .flatMap((r) => [
          ...(r.agent_run_id ? [r.agent_run_id] : []),
          ...(r.childRunIds ?? []),
        ]),
    ),
  );
  const depthRunIds = Array.from(
    new Set(
      out
        .filter((r) => r.kind === "chat_assistant" && r.agent_run_id)
        .map((r) => r.agent_run_id as string),
    ),
  );

  const [runRes, artRes, depthRes] = await Promise.all([
    trailingPendingRun
      ? sb
          .from("agent_runs")
          .select("status, started_at, enqueued_at")
          .eq("id", trailingPendingRun)
          .maybeSingle()
      : Promise.resolve(null),
    artifactRunIds.length > 0
      ? sb
          .from("run_artifacts")
          .select("id, run_id, filename, title, mime, bytes")
          .in("run_id", artifactRunIds)
      : Promise.resolve(null),
    depthRunIds.length > 0
      ? sb
          .from("agent_runs")
          .select("id, routing_decision, model_used, staff_model:payload->staff_model->>key")
          .in("id", depthRunIds)
      : Promise.resolve(null),
  ]);
  if (isStale()) return { kind: "stale" };

  let activeRunIdLocal: string | null = null;
  let activeRunTimes: ActiveRunTimes | null = null;
  if (trailingPendingRun) {
    const runRow = runRes?.data ?? null;
    const runStatus = (runRow as { status?: string } | null)?.status;
    const isSettled =
      typeof runStatus === "string" &&
      (TERMINAL_AGENT_RUN_STATUSES.has(runStatus) ||
        runStatus === PAUSED_AWAITING_APPROVAL_STATUS ||
        runStatus === PAUSED_AWAITING_CHILD_STATUS);
    if (!isSettled) {
      activeRunIdLocal = trailingPendingRun;
      activeRunTimes = runRow
        ? {
            started_at:
              (runRow as { started_at?: string | null }).started_at ?? null,
            enqueued_at:
              (runRow as { enqueued_at?: string | null }).enqueued_at ?? null,
          }
        : null;
    }
  }

  let activeRunStartedAt: string | null = null;
  let activeRunTurnStartedAt: string | null = null;
  let activeRunEta: ActiveRunEta | null = null;
  if (activeRunIdLocal) {
    const rs = teRows.find(
      (r) => r.kind === "run_start" && r.agent_run_id === activeRunIdLocal,
    );
    const userMsg = userChatMsgs.find(
      (m) => m.sender_role === "user" && m.agent_run_id === activeRunIdLocal,
    );
    activeRunStartedAt = pickRunStartedAt({
      rsCreatedAt: rs?.created_at,
      userMsgCreatedAt: userMsg?.created_at,
      runTimes: activeRunTimes,
    });
    activeRunTurnStartedAt = pickTurnStartedAt({
      userMsgCreatedAt: userMsg?.created_at,
      runTimes: activeRunTimes,
    });
    if (rs && rs.body && typeof rs.body === "object") {
      const b = rs.body as Record<string, unknown>;
      const p50 = typeof b.eta_p50_ms === "number" ? b.eta_p50_ms : null;
      const p95 = typeof b.eta_p95_ms === "number" ? b.eta_p95_ms : null;
      activeRunEta =
        p50 != null && p95 != null
          ? {
              p50_ms: p50,
              p95_ms: p95,
              basis: typeof b.eta_basis === "string" ? b.eta_basis : "",
            }
          : null;
    }
  }

  if (artRes?.error) {
    console.warn(
      `[useChatThread] run_artifacts read degraded — chips hidden: ${artRes.error.message}`,
    );
  } else if (artRes?.data && artRes.data.length > 0) {
    const byRun = new Map<string, ArtifactRow[]>();
    for (const a of artRes.data as Array<ArtifactRow & { run_id: string }>) {
      if (isBrowserTaskScreenshot(a.filename)) continue;
      const list = byRun.get(a.run_id) ?? [];
      list.push({ id: a.id, filename: a.filename, title: a.title ?? null, mime: a.mime, bytes: a.bytes });
      byRun.set(a.run_id, list);
    }
    for (const r of out) {
      if (r.kind !== "chat_assistant") continue;
      const runIds = [
        ...(r.agent_run_id ? [r.agent_run_id] : []),
        ...(r.childRunIds ?? []),
      ];
      const collected: ArtifactRow[] = [];
      const seen = new Set<string>();
      for (const rid of runIds) {
        for (const a of byRun.get(rid) ?? []) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          collected.push(a);
        }
      }
      if (collected.length > 0) r.artifacts = collected;
    }
  }

  if (depthRes?.error) {
    console.warn(
      `[useChatThread] routing_decision read degraded — Go-deeper hidden: ${depthRes.error.message}`,
    );
  } else if (depthRes?.data && depthRes.data.length > 0) {
    const depthByRun = new Map<string, "light" | "deep">();
    const staffModelByRun = new Map<string, { key: string; modelUsed?: string }>();
    for (const row of depthRes.data as Array<{
      id: string;
      routing_decision: { picked_depth?: unknown } | null;
      model_used?: unknown;
      staff_model?: unknown;
    }>) {
      const pd = row.routing_decision?.picked_depth;
      if (pd === "light" || pd === "deep") depthByRun.set(row.id, pd);
      if (typeof row.staff_model === "string" && row.staff_model) {
        staffModelByRun.set(row.id, {
          key: row.staff_model,
          ...(typeof row.model_used === "string" && row.model_used ? { modelUsed: row.model_used } : {}),
        });
      }
    }
    for (const r of out) {
      if (r.kind !== "chat_assistant" || !r.agent_run_id) continue;
      const pd = depthByRun.get(r.agent_run_id);
      if (pd) r.pickedDepth = pd;
      const sm = staffModelByRun.get(r.agent_run_id);
      if (sm) {
        r.staffModelKey = sm.key;
        if (sm.modelUsed) r.modelUsed = sm.modelUsed;
      }
    }
  }

  const finishedRunIds = new Set(
    out
      .filter((r) => r.kind === "chat_assistant" && r.agent_run_id)
      .map((r) => r.agent_run_id as string),
  );
  return {
    kind: "loaded",
    thread: resolvedThread,
    dbUserTexts: userChatMsgs
      .filter((m) => m.sender_role === "user")
      .map((m) => m.body.trim()),
    snapshot: {
      rows: out,
      activityRows: mergeActivityRows(
        agentSlug,
        teRows,
        activeRunIdLocal,
        finishedRunIds,
      ),
      activityByRun: detailedActivityByRun(teRows, finishedRunIds),
      hasMore: (eventData?.length ?? 0) >= PAGE_LIMIT,
      activeRunId: activeRunIdLocal,
      activeTrigger: activeRunIdLocal ? "chat" : null,
      activeRunStartedAt,
      activeRunTurnStartedAt,
      activeRunEta,
      offeredTeamNote,
    },
  };
}

const THREAD_CACHE_MAX = 24;
const PREFETCH_FRESH_MS = 15_000;
const REVALIDATE_SKIP_MS = 1_000;

type ThreadCacheEntry = { snapshot: ThreadSnapshot; startedAt: number };
const threadCache = new Map<string, ThreadCacheEntry>();
const prefetchInflight = new Map<string, Promise<ThreadLoadResult>>();

function threadCacheKey(agentSlug: string, threadId: string): string {
  return `${agentSlug}:${threadId}`;
}

function clearThreadCache(): void {
  threadCache.clear();
  prefetchInflight.clear();
}

function readThreadCache(key: string): ThreadCacheEntry | null {
  const hit = threadCache.get(key);
  if (!hit) return null;
  threadCache.delete(key);
  threadCache.set(key, hit);
  return hit;
}

function writeThreadCache(
  key: string,
  snapshot: ThreadSnapshot,
  startedAt: number,
): void {
  const prev = threadCache.get(key);
  if (prev && prev.startedAt > startedAt) return;
  registerSessionScopedCache(clearThreadCache);
  threadCache.delete(key);
  threadCache.set(key, { snapshot, startedAt });
  while (threadCache.size > THREAD_CACHE_MAX) {
    const oldest = threadCache.keys().next().value;
    if (oldest === undefined) break;
    threadCache.delete(oldest);
  }
}

export function prefetchChatThread(agentSlug: string, threadId: string): void {
  if (typeof window === "undefined") return;
  const key = threadCacheKey(agentSlug, threadId);
  const hit = threadCache.get(key);
  if (hit && Date.now() - hit.startedAt < PREFETCH_FRESH_MS) return;
  if (prefetchInflight.has(key)) return;
  let sb: BrowserSupabase;
  try {
    sb = createBrowserSupabase();
  } catch {
    return;
  }
  registerSessionScopedCache(clearThreadCache);
  const startedAt = Date.now();
  const load = loadThreadSnapshot(
    sb,
    agentSlug,
    threadId,
    NO_STOPPED_RUNS,
    () => false,
  )
    .then((result) => {
      if (result.kind === "loaded" && result.thread) {
        writeThreadCache(key, result.snapshot, startedAt);
      }
      return result;
    })
    .finally(() => {
      if (prefetchInflight.get(key) === load) prefetchInflight.delete(key);
    });
  load.catch(() => {});
  prefetchInflight.set(key, load);
}

function sameEta(a: ActiveRunEta | null, b: ActiveRunEta | null): boolean {
  if (a === b) return true;
  return (
    !!a &&
    !!b &&
    a.p50_ms === b.p50_ms &&
    a.p95_ms === b.p95_ms &&
    a.basis === b.basis
  );
}

function sameTeamNote(a: OfferedTeamNote | null, b: OfferedTeamNote | null): boolean {
  if (a === b) return true;
  return (
    !!a &&
    !!b &&
    a.messageId === b.messageId &&
    a.offerId === b.offerId &&
    a.note === b.note &&
    a.offerStop === b.offerStop &&
    a.state === b.state &&
    a.surface === b.surface &&
    a.anchorMessageId === b.anchorMessageId
  );
}

export function useChatThread(
  agentSlug: string,
  threadId: string | null | undefined,
  onThreadLoaded?: (thread: LoadedThreadMeta) => void,
): UseChatThread {
  const [rows, setRows] = useState<ChatRow[]>([]);
  const rowsRef = useRef<ChatRow[]>([]);
  rowsRef.current = rows;
  const [activityRows, setActivityRows] = useState<ChatRow[]>([]);
  const [activityByRun, setActivityByRun] = useState<Map<string, ChatRow[]>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(threadId !== null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const fetchSeqRef = useRef(0);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeTrigger, setActiveTrigger] = useState<string | null>(null);
  const [activeRunTurnStartedAt, setActiveRunTurnStartedAt] = useState<
    string | null
  >(null);
  const [activeRunStartedAt, setActiveRunStartedAt] = useState<string | null>(null);
  const [activeRunEta, setActiveRunEta] = useState<ActiveRunEta | null>(null);
  const [offeredTeamNote, setOfferedTeamNote] = useState<OfferedTeamNote | null>(null);
  const [optimisticUsers, setOptimisticUsers] = useState<OptimisticUserRow[]>(
    [],
  );
  const optimisticUsersRef = useRef<OptimisticUserRow[]>([]);
  optimisticUsersRef.current = optimisticUsers;
  const [optimisticSystems, setOptimisticSystems] = useState<
    OptimisticSystemRow[]
  >([]);
  const gcTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const stoppedRunIdsRef = useRef<Set<string>>(new Set());
  const markRunStopped = useCallback((runId: string) => {
    if (!runId) return;
    stoppedRunIdsRef.current.add(runId);
    setActiveRunId((cur) => {
      if (cur !== runId) return cur;
      setActiveTrigger(null);
      setActivityRows([]);
      return null;
    });
  }, []);
  const unmarkRunStopped = useCallback((runId: string) => {
    if (!runId) return;
    stoppedRunIdsRef.current.delete(runId);
  }, []);

  const boundThreadIdRef = useRef<string | null>(
    typeof threadId === "string" ? threadId : null,
  );

  const [hiddenRowIds, setHiddenRowIds] = useState<ReadonlySet<string>>(() => new Set());
  const hiddenRowIdsRef = useRef<ReadonlySet<string>>(hiddenRowIds);
  const hideRows = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    hiddenRowIdsRef.current = new Set([...hiddenRowIdsRef.current, ...ids]);
    setHiddenRowIds(hiddenRowIdsRef.current);
  }, []);
  const unhideRows = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const next = new Set(hiddenRowIdsRef.current);
    for (const id of ids) next.delete(id);
    hiddenRowIdsRef.current = next;
    setHiddenRowIds(next);
  }, []);

  const armOptimisticUserGc = useCallback((id: string) => {
    const prior = gcTimersRef.current.get(id);
    if (prior) clearTimeout(prior);
    const tid = setTimeout(() => {
      setOptimisticUsers((prev) => prev.filter((r) => r.id !== id));
      gcTimersRef.current.delete(id);
    }, 30_000);
    gcTimersRef.current.set(id, tid);
  }, []);

  const appendOptimisticUser = useCallback(
    (
      text: string,
      attachments?: { path: string; kind?: "image" | "doc" }[],
      {
        persists = true,
        settleLater = false,
      }: { persists?: boolean; settleLater?: boolean } = {},
    ): string | undefined => {
      const trimmed = text.trim();
      if (!trimmed && !attachments?.length) return undefined;
      const id = `optimistic:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const created_at = new Date().toISOString();
      setOptimisticUsers((prev) => {
        const dbCount = rowsRef.current.filter((r) => {
          if (r.kind !== "chat_user" || hiddenRowIdsRef.current.has(r.id)) return false;
          const b = r.body as { text?: string };
          return (b?.text ?? "").trim() === trimmed;
        }).length;
        const pendingCount = prev.filter((o) => o.text === trimmed).length;
        return [
          ...prev,
          {
            id,
            text: trimmed,
            created_at,
            priorDbCount: dbCount + pendingCount,
            ...(attachments?.length ? { attachments } : {}),
          },
        ];
      });
      if (persists && !settleLater) armOptimisticUserGc(id);
      return id;
    },
    [armOptimisticUserGc],
  );

  const settleOptimisticUser = useCallback(
    (id: string, accepted: { userMessageId: string | null } | null) => {
      if (!id) return;
      if (!accepted) {
        armOptimisticUserGc(id);
        return;
      }
      const tid = gcTimersRef.current.get(id);
      if (tid) {
        clearTimeout(tid);
        gcTimersRef.current.delete(id);
      }
      const userMessageId = accepted.userMessageId;
      if (!userMessageId) {
        armOptimisticUserGc(id);
        return;
      }
      setOptimisticUsers((prev) =>
        prev.map((o) => (o.id === id ? { ...o, userMessageId } : o)),
      );
    },
    [armOptimisticUserGc],
  );

  const removeOptimisticUser = useCallback((id: string) => {
    if (!id) return;
    const tid = gcTimersRef.current.get(id);
    if (tid) {
      clearTimeout(tid);
      gcTimersRef.current.delete(id);
    }
    setOptimisticUsers((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const appendOptimisticSystem = useCallback((
    text: string,
    { persists = true }: { persists?: boolean } = {},
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = `optimistic-system:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const created_at = new Date().toISOString();
    setOptimisticSystems((prev) => [
      ...prev,
      { id, text: trimmed, created_at },
    ]);
    if (persists) {
      const tid = setTimeout(() => {
        setOptimisticSystems((prev) => prev.filter((r) => r.id !== id));
        gcTimersRef.current.delete(id);
      }, 30_000);
      gcTimersRef.current.set(id, tid);
    }
  }, []);

  const prevThreadIdRef = useRef(threadId);
  useEffect(() => {
    const prev = prevThreadIdRef.current;
    prevThreadIdRef.current = threadId;
    setOptimisticSystems([]);
    if (
      typeof prev === "string" &&
      typeof threadId === "string" &&
      prev !== threadId
    ) {
      setOptimisticUsers((current) => {
        if (current.length === 0) return current;
        for (const r of current) {
          const tid = gcTimersRef.current.get(r.id);
          if (tid) {
            clearTimeout(tid);
            gcTimersRef.current.delete(r.id);
          }
        }
        return [];
      });
    }
  }, [threadId]);

  useEffect(() => {
    return () => {
      for (const tid of gcTimersRef.current.values()) clearTimeout(tid);
      gcTimersRef.current.clear();
    };
  }, []);

  const onThreadLoadedRef = useRef(onThreadLoaded);
  onThreadLoadedRef.current = onThreadLoaded;

  const shownKeyRef = useRef<string | null>(null);

  const resetRunState = useCallback(() => {
    setActivityRows((prev) => (prev.length === 0 ? prev : []));
    setActivityByRun((prev) => (prev.size === 0 ? prev : new Map()));
    setActiveRunId(null);
    setActiveTrigger(null);
    setActiveRunStartedAt(null);
    setActiveRunTurnStartedAt(null);
    setActiveRunEta(null);
    setOfferedTeamNote(null);
  }, []);

  const imageArtifactsRef = useRef<{ key: string | null; ids: Set<string> }>({
    key: null,
    ids: new Set(),
  });

  const applySnapshot = useCallback((snap: ThreadSnapshot) => {
    const stopped =
      !!snap.activeRunId && stoppedRunIdsRef.current.has(snap.activeRunId);
    const imageIds = new Set(
      snap.rows.flatMap((r) =>
        (r.artifacts ?? []).filter((a) => a.mime.startsWith("image/")).map((a) => a.id),
      ),
    );
    const seen = imageArtifactsRef.current;
    if (
      seen.key !== null &&
      seen.key === shownKeyRef.current &&
      [...imageIds].some((id) => !seen.ids.has(id))
    ) {
      notifyWorkspaceFilesChanged();
    }
    imageArtifactsRef.current = { key: shownKeyRef.current, ids: imageIds };
    setRows((prev) => shareStableRows(prev, snap.rows));
    setActivityRows((prev) =>
      shareStableRows(prev, stopped ? [] : snap.activityRows),
    );
    setActivityByRun((prev) => shareStableRowMap(prev, snap.activityByRun));
    setHasMore(snap.hasMore);
    setActiveRunId(stopped ? null : snap.activeRunId);
    setActiveTrigger(stopped ? null : snap.activeTrigger);
    setActiveRunStartedAt(stopped ? null : snap.activeRunStartedAt);
    setActiveRunTurnStartedAt(stopped ? null : snap.activeRunTurnStartedAt);
    const eta = stopped ? null : snap.activeRunEta;
    setActiveRunEta((prev) => (sameEta(prev, eta) ? prev : eta));
    setOfferedTeamNote((prev) => (sameTeamNote(prev, snap.offeredTeamNote) ? prev : snap.offeredTeamNote));
  }, []);

  const load = useCallback(
    async (joinPrefetch: boolean) => {
      const gen = ++fetchSeqRef.current;
      setErrorMsg(null);

      if (threadId === null) {
        boundThreadIdRef.current = null;
        shownKeyRef.current = null;
        setNotFound(false);
        setRows([]);
        setHasMore(false);
        resetRunState();
        setLoading(false);
        return;
      }

      const isStale = () => gen !== fetchSeqRef.current;
      const startedAt = Date.now();
      const key =
        typeof threadId === "string" ? threadCacheKey(agentSlug, threadId) : null;
      if (key !== null && shownKeyRef.current !== key) setLoading(true);

      let result: ThreadLoadResult | null = null;
      const pending =
        joinPrefetch && key ? prefetchInflight.get(key) : undefined;
      if (pending) {
        result = await pending.catch(() => null);
        if (isStale()) return;
      }
      if (!result) {
        result = await loadThreadSnapshot(
          createBrowserSupabase(),
          agentSlug,
          threadId,
          stoppedRunIdsRef.current,
          isStale,
        );
      }
      if (isStale() || result.kind === "stale") return;

      if (result.kind === "not_found") {
        if (key) threadCache.delete(key);
        shownKeyRef.current = null;
        setNotFound(true);
        setRows([]);
        setHasMore(false);
        resetRunState();
        setLoading(false);
        return;
      }

      if (result.kind === "error") {
        setLoading(false);
        const currentKey =
          key ??
          (boundThreadIdRef.current
            ? threadCacheKey(agentSlug, boundThreadIdRef.current)
            : null);
        const showingThisThread =
          currentKey !== null && shownKeyRef.current === currentKey;
        const keepOnScreen =
          showingThisThread ||
          optimisticUsersRef.current.length > 0 ||
          (threadId === undefined &&
            currentKey === null &&
            rowsRef.current.length > 0);
        if (keepOnScreen) {
          console.warn(
            `[useChatThread] load failed, keeping what is on screen: ${result.message}`,
          );
          return;
        }
        shownKeyRef.current = null;
        setRows([]);
        resetRunState();
        setErrorMsg(result.message);
        return;
      }
      setNotFound(false);

      if (result.thread) {
        boundThreadIdRef.current = result.thread.id;
        writeThreadCache(
          threadCacheKey(agentSlug, result.thread.id),
          result.snapshot,
          startedAt,
        );
        onThreadLoadedRef.current?.(result.thread);
      }
      shownKeyRef.current = result.thread
        ? threadCacheKey(agentSlug, result.thread.id)
        : null;
      applySnapshot(result.snapshot);
      setLoading(false);

      const dbUserCounts = countUserTexts(result.dbUserTexts);
      const loadedRowIds = new Set(result.snapshot.rows.map((r) => r.id));
      if (dbUserCounts.size > 0) {
        setOptimisticUsers((prev) => {
          const next = prev.filter(
            (o) =>
              (dbUserCounts.get(o.text) ?? 0) <= o.priorDbCount &&
              !(o.userMessageId && loadedRowIds.has(`m:${o.userMessageId}`)),
          );
          for (const r of prev) {
            if (!next.includes(r)) {
              const tid = gcTimersRef.current.get(r.id);
              if (tid) {
                clearTimeout(tid);
                gcTimersRef.current.delete(r.id);
              }
            }
          }
          return next;
        });
      }
    },
    [agentSlug, threadId, applySnapshot, resetRunState],
  );

  const loadRef = useRef(load);
  loadRef.current = load;
  const refetch = useCallback(() => loadRef.current(false), []);

  const loadedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setNotFound(false);
    const loadKey = `${agentSlug}:${threadId ?? String(threadId)}`;
    const targetChanged = loadedKeyRef.current !== loadKey;
    loadedKeyRef.current = loadKey;
    if (typeof threadId === "string") boundThreadIdRef.current = threadId;
    let justLoaded = false;
    if (threadId !== null && targetChanged) {
      const cached =
        typeof threadId === "string"
          ? readThreadCache(threadCacheKey(agentSlug, threadId))
          : null;
      if (cached) {
        shownKeyRef.current = threadCacheKey(agentSlug, threadId as string);
        applySnapshot(cached.snapshot);
        setLoading(false);
        justLoaded = Date.now() - cached.startedAt < REVALIDATE_SKIP_MS;
      } else {
        shownKeyRef.current = null;
        setLoading(true);
        setRows([]);
        resetRunState();
      }
    }
    if (justLoaded) return;
    (async () => {
      try {
        await load(true);
        if (cancelled) return;
      } catch (e) {
        if (!cancelled) {
          setErrorMsg((e as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const debouncedRefetchRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const debouncedRefetch = useCallback(() => {
    if (debouncedRefetchRef.current) clearTimeout(debouncedRefetchRef.current);
    debouncedRefetchRef.current = setTimeout(() => {
      debouncedRefetchRef.current = null;
      void refetch();
    }, 700);
  }, [refetch]);

  useEffect(() => {
    return () => {
      if (debouncedRefetchRef.current) {
        clearTimeout(debouncedRefetchRef.current);
        debouncedRefetchRef.current = null;
      }
    };
  }, [threadId]);

  const catchUpOnJoin = useCallback(() => {
    debouncedRefetch();
  }, [debouncedRefetch]);
  useRealtimeChannel<ThreadEventRow>({
    table: "thread_event",
    scopeKey: `agent_slug:${agentSlug}`,
    filter: `agent_slug=eq.${agentSlug}`,
    onSubscribed: catchUpOnJoin,
    onInsert: useCallback(
      (row: ThreadEventRow) => {
        const eventThreadId = row?.thread_id;
        const bound = boundThreadIdRef.current;
        if (typeof eventThreadId === "string" && bound && eventThreadId !== bound) {
          return;
        }
        debouncedRefetch();
      },
      [debouncedRefetch],
    ),
  });

  const hasBoundThread = typeof threadId === "string";
  useRealtimeChannel<{ id: string }>({
    table: "agent_thread_messages",
    scopeKey: `agent_thread_messages:${threadId ?? "none"}`,
    filter: hasBoundThread ? `thread_id=eq.${threadId}` : undefined,
    enabled: hasBoundThread,
    onSubscribed: catchUpOnJoin,
    onInsert: useCallback(() => {
      void refetch();
    }, [refetch]),
  });

  useRealtimeChannel<{ id: string }>({
    table: "agent_thread_messages",
    scopeKey: `agent_thread_messages:${threadId ?? "none"}`,
    filter: hasBoundThread ? `thread_id=eq.${threadId}` : undefined,
    enabled: hasBoundThread,
    event: "UPDATE",
    onInsert: useCallback(() => {
      debouncedRefetch();
    }, [debouncedRefetch]),
  });

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refetch]);

  useEffect(() => {
    if (!activeRunId) return;
    const runId = activeRunId;
    const sb = createBrowserSupabase();
    let cancelled = false;
    const id = window.setInterval(async () => {
      if (cancelled) return;
      const { data, error } = await sb
        .from("agent_runs")
        .select("status")
        .eq("id", runId)
        .maybeSingle();
      if (cancelled || error || !data) return;
      const status = (data as { status?: string }).status;
      if (
        typeof status === "string" &&
        TERMINAL_AGENT_RUN_STATUSES.has(status)
      ) {
        if (status === "failed" || status === "dispatch_error") {
          const { data: ended } = await sb
            .from("thread_event")
            .select("id")
            .eq("agent_run_id", runId)
            .eq("kind", "run_end")
            .limit(1)
            .maybeSingle();
          if (cancelled || !ended) return;
        }
        setActiveRunId((cur) => {
          if (cur !== runId) return cur;
          setActiveTrigger(null);
          setActivityRows([]);
          return null;
        });
        void refetch();
      }
    }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeRunId, refetch]);

  const mergedRows = useMemo(() => {
    const visibleRows =
      hiddenRowIds.size > 0 ? rows.filter((r) => !hiddenRowIds.has(r.id)) : rows;
    if (optimisticUsers.length === 0 && optimisticSystems.length === 0) {
      return visibleRows;
    }
    const dbUserCounts = countUserTexts(
      visibleRows
        .filter((r) => r.kind === "chat_user")
        .map((r) => {
          const b = r.body as { text?: string };
          return (b?.text ?? "").trim();
        }),
    );
    const dbAttachmentPaths = new Set(
      visibleRows
        .filter((r) => r.kind === "chat_user")
        .flatMap((r) => (r.attachments ?? []).map((a) => a.path)),
    );
    const visibleRowIds = new Set(visibleRows.map((r) => r.id));
    const optUserRows: ChatRow[] = optimisticUsers
      .filter(
        (o) => !(o.userMessageId && visibleRowIds.has(`m:${o.userMessageId}`)),
      )
      .filter((o) =>
        o.attachments?.length
          ? !o.attachments.some((a) => dbAttachmentPaths.has(a.path))
          : true,
      )
      .filter((o) => (dbUserCounts.get(o.text) ?? 0) <= o.priorDbCount)
      .map((o) => ({
        id: o.id,
        kind: "chat_user" as const,
        agent_run_id: null,
        body: { text: o.text },
        citations: [],
        created_at: o.created_at,
        attachments: o.attachments ?? null,
      }));
    const optSystemRows: ChatRow[] = optimisticSystems.map((o) => ({
      id: o.id,
      kind: "chat_system" as const,
      agent_run_id: null,
      body: { text: o.text },
      citations: [],
      created_at: o.created_at,
    }));
    if (optUserRows.length === 0 && optSystemRows.length === 0) return visibleRows;
    return [...visibleRows, ...optUserRows, ...optSystemRows].sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
    );
  }, [rows, optimisticUsers, optimisticSystems, hiddenRowIds]);

  const founderPending = useMemo(
    () => mergedRows.some((r) => r.kind === "chat_user" && r.id.startsWith("optimistic:")),
    [mergedRows],
  );
  const liveStripNote = founderPending ? null : offeredTeamNote;
  const rowsOut = useMemo(() => {
    if (!founderPending || !offeredTeamNote) return mergedRows;
    const id = `m:${offeredTeamNote.messageId}`;
    return mergedRows.map((r) => (r.id === id ? { ...r, teamNoteFlag: offeredTeamNote } : r));
  }, [mergedRows, founderPending, offeredTeamNote]);

  const teamNoteTurnKey = useMemo(() => {
    for (let i = mergedRows.length - 1; i >= 0; i--) {
      if (mergedRows[i].kind === "chat_user") return mergedRows[i].id;
    }
    return null;
  }, [mergedRows]);

  return {
    rows: rowsOut,
    activityRows,
    activityByRun,
    loading,
    hasMore,
    errorMsg,
    notFound,
    activeRunId,
    activeTrigger,
    activeRunStartedAt,
    activeRunTurnStartedAt,
    activeRunEta,
    offeredTeamNote: liveStripNote,
    teamNoteTurnKey,
    refetch,
    appendOptimisticUser,
    settleOptimisticUser,
    removeOptimisticUser,
    appendOptimisticSystem,
    markRunStopped,
    unmarkRunStopped,
    hideRows,
    unhideRows,
  };
}

export function isBrowserTaskScreenshot(filename: string): boolean {
  return /^browser-task-.*\.png$/i.test(filename) || /^tab-task-.*\.jpg$/i.test(filename);
}

function isViaEmail(meta: unknown): boolean {
  return !!meta && typeof meta === "object" && (meta as Record<string, unknown>).via === "email";
}
