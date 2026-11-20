import { asTenantId, clearTenantMarker, consumeTenantRateLimit, tenantClient } from "@/services/tenant-client";
import { BUILD_SESSION_PAYLOAD_KEY, buildSessionOfPayload } from "@/services/agents/build-session-binding";
import { BUILD_CHAT_AGENT } from "@/services/build/build-chat-thread";
import { deployCompleted, isRefineGraph, liveUrlFromResources } from "@/services/build/build-live-email";
import { siteIdFromGraph } from "@/services/sites/site-run";
import type { SiteStore } from "@/services/sites/contract";

export const BUILD_READY_IN_PREVIEW =
  "Your site is ready. Have a look in the preview, and press Publish to put it on its address when you're happy with it.";

export function buildReadyLiveMessage(url: string): string {
  return `Your site is ready and live at ${url}. Have a look, and tell me anything you'd like changed.`;
}

const READY_MESSAGE_ONCE_S = 10 * 365 * 24 * 60 * 60;
const BOUND_RUN_SCAN = 50;

type Db = ReturnType<typeof tenantClient>;

export type BuildReadyMessageDeps = {
  db?: Db;
  claim?: (tenant_id: string, session_id: string) => Promise<boolean>;
  release?: (tenant_id: string, session_id: string) => Promise<void>;
  store?: SiteStore;
};

export type BuildReadyMessageResult =
  | { posted: true; thread_id: string }
  | { posted: false; reason: string };

function readyMarker(session_id: string): string {
  return `build_ready_message:${session_id}`;
}

async function defaultClaim(tenant_id: string, session_id: string): Promise<boolean> {
  return consumeTenantRateLimit(asTenantId(tenant_id), readyMarker(session_id), 1, READY_MESSAGE_ONCE_S);
}

async function defaultRelease(tenant_id: string, session_id: string): Promise<void> {
  await clearTenantMarker(asTenantId(tenant_id), readyMarker(session_id));
}

async function defaultStore(): Promise<SiteStore> {
  const { siteStore } = await import("@/services/sites/store");
  return siteStore();
}

async function boundThread(db: Db, session_id: string): Promise<string | null> {
  const { data: runs, error } = await db
    .from("agent_runs")
    .select("payload")
    .eq("agent_slug", BUILD_CHAT_AGENT)
    .eq(`payload->>${BUILD_SESSION_PAYLOAD_KEY}`, session_id)
    .order("enqueued_at", { ascending: false })
    .limit(BOUND_RUN_SCAN);
  if (error) throw new Error(error.message);
  const ids: string[] = [];
  for (const row of (runs ?? []) as Array<{ payload: unknown }>) {
    const threadId = (row.payload as { thread_id?: unknown } | null)?.thread_id;
    if (typeof threadId !== "string" || ids.includes(threadId)) continue;
    if (buildSessionOfPayload(row.payload) !== session_id) continue;
    ids.push(threadId);
  }
  if (ids.length === 0) return null;
  const { data: threads, error: threadErr } = await db
    .from("agent_threads")
    .select("id")
    .eq("agent_slug", BUILD_CHAT_AGENT)
    .in("id", ids)
    .is("deleted_at", null)
    .order("last_message_at", { ascending: false })
    .limit(1);
  if (threadErr) throw new Error(threadErr.message);
  return ((threads ?? []) as Array<{ id: string }>)[0]?.id ?? null;
}

async function liveUrlOf(tenant_id: string, goalGraph: unknown, deps: BuildReadyMessageDeps): Promise<string | null> {
  const siteId = siteIdFromGraph(goalGraph);
  if (siteId) {
    const store = deps.store ?? (await defaultStore());
    const site = await store.get(tenant_id, siteId);
    if (!site?.live_deploy_id) return null;
    if (typeof site.live_url === "string" && /^https:\/\//.test(site.live_url)) return site.live_url;
    return site.hostname ? `https://${site.hostname}` : null;
  }
  if (!deployCompleted(goalGraph)) return null;
  const { readLegacyAppResources } = await import("@/services/sites/legacy-app");
  return liveUrlFromResources(await readLegacyAppResources(tenant_id));
}

async function alreadyPosted(db: Db, thread_id: string, session_id: string): Promise<boolean> {
  const { data, error } = await db
    .from("agent_thread_messages")
    .select("id")
    .eq("thread_id", thread_id)
    .eq("meta->>build_ready_session_id", session_id)
    .limit(1);
  if (error) {
    console.warn(`[build-ready-message] duplicate check failed for ${session_id}, keeping the claim: ${error.message}`);
    return true;
  }
  return ((data ?? []) as unknown[]).length > 0;
}

export async function postBuildChatNote(
  params: { tenant_id: string; conductor_run_id: string; body: string },
  deps: { db?: Db } = {},
): Promise<boolean> {
  const db = deps.db ?? tenantClient(asTenantId(params.tenant_id));
  const session = params.conductor_run_id.trim().toLowerCase();
  const threadId = await boundThread(db, session);
  if (!threadId) return false;
  const { error } = await db.from("agent_thread_messages").insert({
    thread_id: threadId,
    sender_role: "assistant",
    body: params.body,
    agent_run_id: null,
    meta: { queued_change: true, build_session_id: session },
  });
  if (error) throw new Error(error.message);
  return true;
}

export async function postBuildReadyMessage(
  params: { tenant_id: string; conductor_run_id: string },
  deps: BuildReadyMessageDeps = {},
): Promise<BuildReadyMessageResult> {
  if (process.env.BUILD_READY_CHAT_MESSAGE_ENABLED === "0") return { posted: false, reason: "disabled" };
  try {
    const db = deps.db ?? tenantClient(asTenantId(params.tenant_id));
    const { data: run, error: runErr } = await db
      .from("conductor_runs")
      .select("id, kind, status, goal_graph")
      .eq("id", params.conductor_run_id)
      .maybeSingle();
    if (runErr) throw new Error(runErr.message);
    const r = run as { id?: string; kind?: string; status?: string; goal_graph?: unknown } | null;
    if (!r || r.kind !== "build_app" || r.status !== "done") return { posted: false, reason: "not_ready" };
    if (isRefineGraph(r.goal_graph)) return { posted: false, reason: "refine" };
    const session = params.conductor_run_id.trim().toLowerCase();

    const threadId = await boundThread(db, session);
    if (!threadId) return { posted: false, reason: "no_thread" };

    const liveUrl = await liveUrlOf(params.tenant_id, r.goal_graph, deps).catch(() => null);
    const body = liveUrl ? buildReadyLiveMessage(liveUrl) : BUILD_READY_IN_PREVIEW;

    if (!(await (deps.claim ?? defaultClaim)(params.tenant_id, session))) {
      return { posted: false, reason: "already_posted" };
    }

    const { error: insErr } = await db.from("agent_thread_messages").insert({
      thread_id: threadId,
      sender_role: "assistant",
      body,
      agent_run_id: null,
      meta: { build_ready: true, build_ready_session_id: session },
    });
    if (insErr) {
      if (!(await alreadyPosted(db, threadId, session))) {
        await (deps.release ?? defaultRelease)(params.tenant_id, session).catch(() => {});
      }
      console.warn(`[build-ready-message] insert failed for ${session}: ${insErr.message}`);
      return { posted: false, reason: "insert_failed" };
    }
    await db.from("agent_threads").update({ last_message_at: new Date().toISOString() }).eq("id", threadId);
    return { posted: true, thread_id: threadId };
  } catch (e) {
    console.warn(`[build-ready-message] skipped for ${params.conductor_run_id}: ${(e as Error).message}`);
    return { posted: false, reason: "error" };
  }
}
