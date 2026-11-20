import { asTenantId, tenantClient } from "@/services/tenant-client";
import {
  STUDIO_AGENT_SLUG,
  STUDIO_RUN_AGENT_SLUG,
  type GalleryArtifactRow,
  type GalleryRunRow,
  type SendClaimRow,
  type SendClaims,
  type StudioMessageRow,
  type StudioStore,
  type StudioThreadRow,
  type VideoArtifactRow,
  type VideoKind,
} from "./studio";
import { DRAFT_INTENTS } from "./draft";

const MESSAGE_COLUMNS = "id, sender_role, body, meta, attachments, agent_run_id, created_at";
export const SEND_CLAIM_TABLE = "request_idempotency";
export const SEND_CLAIM_ROUTE = "video-studio:send";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asVideoKind(v: unknown): VideoKind | null {
  return typeof v === "string" && (DRAFT_INTENTS as readonly string[]).includes(v) ? (v as VideoKind) : null;
}

async function readDraftIntents(db: ReturnType<typeof tenantClient>, ids: string[]): Promise<Map<string, VideoKind>> {
  const out = new Map<string, VideoKind>();
  if (ids.length === 0) return out;
  const { data, error } = await db.from("agent_thread_messages").select("id, intent:meta->video_draft->>intent").in("id", ids);
  if (error) return out;
  for (const row of (data ?? []) as Array<{ id: string; intent: unknown }>) {
    const kind = asVideoKind(row.intent);
    if (kind) out.set(row.id, kind);
  }
  return out;
}

async function readCardIntents(db: ReturnType<typeof tenantClient>, run_ids: string[]): Promise<Map<string, VideoKind | null>> {
  const out = new Map<string, VideoKind | null>();
  if (run_ids.length === 0) return out;
  const { data, error } = await db.from("channel_actions").select("run_id, intent:exec_payload->intake->>intent").in("run_id", run_ids);
  if (error) return out;
  for (const row of (data ?? []) as Array<{ run_id: string; intent: unknown }>) {
    const kind = asVideoKind(row.intent);
    if (!kind) continue;
    const seen = out.get(row.run_id);
    if (seen === undefined) out.set(row.run_id, kind);
    else if (seen !== kind) out.set(row.run_id, null);
  }
  return out;
}

function supabaseSendClaims(db: ReturnType<typeof tenantClient>): SendClaims {
  return {
    async claim(user_id, key) {
      const token = new Date().toISOString();
      const { error } = await db.from(SEND_CLAIM_TABLE).insert({
        user_id,
        route: SEND_CLAIM_ROUTE,
        idem_key: key,
        request_hash: key,
        status: "in_progress",
        created_at: token,
      });
      if (!error) return token;
      if ((error as { code?: string }).code === "23505") return null;
      throw new Error(`video-studio: send claim failed: ${error.message}`);
    },

    async read(user_id, key) {
      const { data, error } = await db
        .from(SEND_CLAIM_TABLE)
        .select("status, response_body, created_at, completed_at")
        .eq("user_id", user_id)
        .eq("route", SEND_CLAIM_ROUTE)
        .eq("idem_key", key)
        .maybeSingle();
      if (error) throw new Error(`video-studio: send claim read failed: ${error.message}`);
      const row = data as { status: SendClaimRow["status"]; response_body: unknown; created_at: string; completed_at: string | null } | null;
      return row ? { token: row.created_at, claimed_at: row.created_at, status: row.status, result: row.response_body, completed_at: row.completed_at } : null;
    },

    async settle(user_id, key, token, result) {
      const { error } = await db
        .from(SEND_CLAIM_TABLE)
        .update({ status: "done", response_status: 200, response_body: result, completed_at: new Date().toISOString() })
        .eq("user_id", user_id)
        .eq("route", SEND_CLAIM_ROUTE)
        .eq("idem_key", key)
        .eq("created_at", token);
      if (error) throw new Error(`video-studio: send settle failed: ${error.message}`);
    },

    async release(user_id, key, token) {
      const { error } = await db
        .from(SEND_CLAIM_TABLE)
        .delete()
        .eq("user_id", user_id)
        .eq("route", SEND_CLAIM_ROUTE)
        .eq("idem_key", key)
        .eq("created_at", token);
      if (error) throw new Error(`video-studio: send release failed: ${error.message}`);
    },

    async takeOver(user_id, key, seen_token) {
      const token = new Date().toISOString();
      const { data, error } = await db
        .from(SEND_CLAIM_TABLE)
        .update({ status: "in_progress", response_status: null, response_body: null, completed_at: null, created_at: token })
        .eq("user_id", user_id)
        .eq("route", SEND_CLAIM_ROUTE)
        .eq("idem_key", key)
        .eq("created_at", seen_token)
        .select("idem_key");
      if (error) throw new Error(`video-studio: send takeover failed: ${error.message}`);
      return Array.isArray(data) && data.length === 1 ? token : null;
    },
  };
}

export function supabaseStudioStore(tenant_id: string): StudioStore {
  const db = tenantClient(asTenantId(tenant_id));

  const readMeta = async (thread_id: string, message_id: string): Promise<Record<string, unknown> | null> => {
    const { data, error } = await db
      .from("agent_thread_messages")
      .select("meta")
      .eq("thread_id", thread_id)
      .eq("id", message_id)
      .maybeSingle();
    if (error) throw new Error(`video-studio: message read failed: ${error.message}`);
    return ((data as { meta?: Record<string, unknown> } | null)?.meta ?? null) as Record<string, unknown> | null;
  };

  return {
    sendClaims: supabaseSendClaims(db),

    async findThread(user_id) {
      const { data, error } = await db
        .from("agent_threads")
        .select("id")
        .eq("agent_slug", STUDIO_AGENT_SLUG)
        .eq("user_id", user_id)
        .is("deleted_at", null)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`video-studio: thread read failed: ${error.message}`);
      return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
    },

    async getOwnThread(user_id, thread_id) {
      const { data, error } = await db
        .from("agent_threads")
        .select("id")
        .eq("id", thread_id)
        .eq("agent_slug", STUDIO_AGENT_SLUG)
        .eq("user_id", user_id)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new Error(`video-studio: thread read failed: ${error.message}`);
      return ((data as { id: string } | null) ?? null)?.id ?? null;
    },

    async listThreads(user_id, limit) {
      const { data, error } = await db
        .from("agent_threads")
        .select("id, title, created_at, last_message_at")
        .eq("agent_slug", STUDIO_AGENT_SLUG)
        .eq("user_id", user_id)
        .is("deleted_at", null)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`video-studio: threads read failed: ${error.message}`);
      return (data ?? []) as StudioThreadRow[];
    },

    async setThreadTitle(thread_id, title) {
      const { error } = await db.from("agent_threads").update({ title, title_source: "system" }).eq("id", thread_id);
      if (error) throw new Error(`video-studio: thread title failed: ${error.message}`);
    },

    async listVideoRuns(limit) {
      const { data, error } = await db
        .from("agent_runs")
        .select("id, enqueued_at, enqueued_by, payload")
        .eq("agent_slug", STUDIO_RUN_AGENT_SLUG)
        .order("enqueued_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`video-studio: runs read failed: ${error.message}`);
      const rows = (data ?? []) as Array<{ id: string; enqueued_at: string; enqueued_by: string | null; payload: Record<string, unknown> | null }>;
      const draftOf = (r: (typeof rows)[number]): string | null => (typeof r.payload?.draft_message_id === "string" ? r.payload.draft_message_id : null);
      const draftIds = [...new Set(rows.map(draftOf).filter((id): id is string => id !== null))];
      const cardRunIds = rows.filter((r) => draftOf(r) === null).map((r) => r.id);
      const [draftIntents, cardIntents] = await Promise.all([readDraftIntents(db, draftIds), readCardIntents(db, cardRunIds)]);
      return rows.map((r): GalleryRunRow => {
        const draft = draftOf(r);
        return {
          id: r.id,
          created_at: r.enqueued_at,
          enqueued_by: r.enqueued_by,
          studio_thread_id: typeof r.payload?.studio_thread_id === "string" ? r.payload.studio_thread_id : null,
          intent: (draft !== null ? draftIntents.get(draft) : cardIntents.get(r.id)) ?? null,
        };
      });
    },

    async listGalleryArtifacts(run_ids) {
      const { data, error } = await db
        .from("run_artifacts")
        .select("id, run_id, filename, created_at")
        .in("run_id", run_ids)
        .like("mime", "video/%")
        .order("created_at", { ascending: false });
      if (error) throw new Error(`video-studio: gallery read failed: ${error.message}`);
      return (data ?? []) as GalleryArtifactRow[];
    },

    async createThread(user_id) {
      const { data, error } = await db
        .from("agent_threads")
        .insert({ agent_slug: STUDIO_AGENT_SLUG, user_id, title: "AI UGC video chat", title_source: "system" })
        .select("id")
        .single();
      if (error || !data) throw new Error(`video-studio: thread create failed: ${error?.message ?? "no row"}`);
      return (data as { id: string }).id;
    },

    async listMessages(thread_id, limit) {
      const { data, error } = await db
        .from("agent_thread_messages")
        .select(MESSAGE_COLUMNS)
        .eq("thread_id", thread_id)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`video-studio: messages read failed: ${error.message}`);
      return (data ?? []) as StudioMessageRow[];
    },

    async listRunMessages(thread_id, run_id) {
      if (!UUID_RE.test(run_id)) return [];
      const { data, error } = await db
        .from("agent_thread_messages")
        .select(MESSAGE_COLUMNS)
        .eq("thread_id", thread_id)
        .or(`agent_run_id.eq.${run_id},meta->>source_run_id.eq.${run_id}`);
      if (error) throw new Error(`video-studio: run messages read failed: ${error.message}`);
      return (data ?? []) as StudioMessageRow[];
    },

    async listStartedRuns(run_ids) {
      const { data, error } = await db.from("generative_video_jobs").select("run_id, created_at").in("run_id", run_ids);
      if (error) throw new Error(`video-studio: job rows read failed: ${error.message}`);
      return (data ?? []) as Array<{ run_id: string; created_at: string }>;
    },

    async getMessage(thread_id, message_id) {
      const { data, error } = await db
        .from("agent_thread_messages")
        .select(MESSAGE_COLUMNS)
        .eq("thread_id", thread_id)
        .eq("id", message_id)
        .maybeSingle();
      if (error) throw new Error(`video-studio: message read failed: ${error.message}`);
      return (data ?? null) as StudioMessageRow | null;
    },

    async insertMessage(m) {
      const { data, error } = await db
        .from("agent_thread_messages")
        .insert({
          thread_id: m.thread_id,
          sender_role: m.sender_role,
          body: m.body,
          meta: m.meta ?? {},
          ...(m.attachments?.length ? { attachments: m.attachments } : {}),
          agent_run_id: m.agent_run_id ?? null,
        })
        .select(MESSAGE_COLUMNS)
        .single();
      if (error || !data) throw new Error(`video-studio: message insert failed: ${error?.message ?? "no row"}`);
      await db.from("agent_threads").update({ last_message_at: new Date().toISOString() }).eq("id", m.thread_id);
      return data as StudioMessageRow;
    },

    async claimRender(thread_id, message_id, run_id, previous_run_id) {
      const meta = await readMeta(thread_id, message_id);
      if (!meta) return false;
      const current = typeof meta.render_run_id === "string" ? meta.render_run_id : null;
      if (current !== previous_run_id) return false;
      const base = db
        .from("agent_thread_messages")
        .update({ meta: { ...meta, render_run_id: run_id } })
        .eq("thread_id", thread_id)
        .eq("id", message_id);
      const guarded = previous_run_id === null ? base.is("meta->>render_run_id", null) : base.eq("meta->>render_run_id", previous_run_id);
      const { data, error } = await guarded.select("id");
      if (error) throw new Error(`video-studio: render claim failed: ${error.message}`);
      return ((data ?? []) as unknown[]).length > 0;
    },

    async createRenderRun({ id, user_id, thread_id, message_id, retry_of }) {
      const at = new Date().toISOString();
      const { data, error } = await db
        .from("agent_runs")
        .insert({
          id,
          agent_slug: STUDIO_RUN_AGENT_SLUG,
          agent_definition_hash: "video-studio-render",
          trigger: "chat",
          status: "success",
          enqueued_by: user_id,
          enqueued_at: at,
          started_at: at,
          finished_at: at,
          parse_ok: true,
          cost_tokens: 0,
          cost_usd: 0,
          tool_calls: [],
          output_text: "Video render requested from the AI UGC video chat (no model run).",
          payload: { stage: "video-studio-render", studio_thread_id: thread_id, draft_message_id: message_id, ...(retry_of ? { retry_of } : {}) },
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`video-studio: run create failed: ${error?.message ?? "no row"}`);
      return (data as { id: string }).id;
    },

    async listVideoArtifacts(run_ids) {
      const { data, error } = await db
        .from("run_artifacts")
        .select("id, run_id, filename")
        .in("run_id", run_ids)
        .like("mime", "video/%");
      if (error) throw new Error(`video-studio: artifacts read failed: ${error.message}`);
      return (data ?? []) as VideoArtifactRow[];
    },
  };
}
