
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ownChatImagePaths } from "@/services/workspace-files/site-photos";

export const OWNER_PHOTO_BUCKET = "agent-chat-images";

const THREAD_ROW_WINDOW = 40;

export type OwnerPhotoResolution =
  | { ok: true; path: string; reference: string; index: number; available: number }
  | { ok: false; code: "no_attached_photo" | "photo_index_out_of_range" | "photo_lookup_failed"; available: number };

type ThreadRow = { attachments?: unknown; created_at?: string };

export const MAX_OWNER_PHOTOS = 20;

function imagePathsOfRow(tenantId: string, attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return [];
  const raw = attachments
    .filter((a): a is { path: string; kind?: string } =>
      !!a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string",
    )
    .filter((a) => a.kind === undefined || a.kind === "image")
    .map((a) => a.path);
  return ownChatImagePaths(tenantId, newestFirst(raw));
}

function newestFirst<T>(paths: T[]): T[] {
  return [...paths].reverse();
}

type Payload = Record<string, unknown>;
type RunRow = { trigger: string | null; enqueued_by: string | null; payload: Payload };
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

const MAX_RESUME_HOPS = 5;

const RESUME_TRIGGERS: ReadonlySet<string> = new Set(["chat", "handoff"]);

const hasAnchor = (r: RunRow) =>
  !!str(r.payload.user_message_id) || (Array.isArray(r.payload.attachment_paths) && r.payload.attachment_paths.length > 0);

type Collected = { candidates: string[]; isOwners: (path: string) => Promise<boolean> };
const NONE: Collected = { candidates: [], isOwners: async () => false };

const MAX_CANDIDATES = 2 * 20;

async function collectOwnerPhotos(tenantId: string, runId: string): Promise<Collected> {
  const db = tenantClient(asTenantId(tenantId));
  const readRun = async (id: string): Promise<RunRow | null> => {
    const { data, error } = await db
      .from("agent_runs")
      .select("trigger, enqueued_by, payload")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`owner photo: run read failed: ${error.message}`);
    if (!data) return null;
    const r = data as { trigger?: unknown; enqueued_by?: unknown; payload?: unknown };
    return {
      trigger: str(r.trigger),
      enqueued_by: str(r.enqueued_by),
      payload: r.payload && typeof r.payload === "object" ? (r.payload as Payload) : {},
    };
  };

  const first = await readRun(runId);
  if (!first) throw new Error("owner photo: run not found for this tenant");

  let run = first;
  for (let hop = 0; !hasAnchor(run); hop++) {
    if (hop >= MAX_RESUME_HOPS || run.enqueued_by !== null || !RESUME_TRIGGERS.has(run.trigger ?? "")) return NONE;
    const prev = str(run.payload.resume_of_run_id);
    if (!prev) return NONE;
    const origin = await readRun(prev);
    if (!origin || (str(origin.payload.thread_id) ?? null) !== (str(run.payload.thread_id) ?? null)) return NONE;
    run = origin;
  }

  const candidates: string[] = [];
  const add = (paths: string[]) => {
    for (const p of paths) {
      if (candidates.length >= MAX_CANDIDATES) return;
      if (!candidates.includes(p)) candidates.push(p);
    }
  };

  const threadOwnedBy = async (threadId: string, userId: string): Promise<boolean> => {
    const { data: thread, error } = await db
      .from("agent_threads")
      .select("user_id")
      .eq("id", threadId)
      .maybeSingle();
    if (error) throw new Error(`owner photo: thread owner read failed: ${error.message}`);
    return !!thread && (thread as { user_id?: unknown }).user_id === userId;
  };
  const ownerRows = async (threadId: string, upTo: string | null): Promise<ThreadRow[]> => {
    let q = db
      .from("agent_thread_messages")
      .select("attachments, created_at")
      .eq("thread_id", threadId)
      .eq("sender_role", "user")
      .filter("meta->>superseded_by", "is", null);
    if (upTo) q = q.lte("created_at", upTo);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(THREAD_ROW_WINDOW);
    if (error) throw new Error(`owner photo: thread read failed: ${error.message}`);
    return (data ?? []) as ThreadRow[];
  };

  const ownerCache = new Map<string, boolean>();
  const pathCache = new Map<string, boolean>();
  const firstAttachedBy = async (path: string, userId: string): Promise<boolean> => {
    const hit = pathCache.get(path);
    if (hit !== undefined) return hit;
    const { data, error } = await db
      .from("agent_thread_messages")
      .select("thread_id, created_at")
      .eq("sender_role", "user")
      .contains("attachments", JSON.stringify([{ path }]))
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throw new Error(`owner photo: provenance read failed: ${error.message}`);
    const first = ((data ?? []) as Array<{ thread_id?: string }>)[0];
    let ok = false;
    if (first?.thread_id) {
      const key = `${first.thread_id}|${userId}`;
      if (!ownerCache.has(key)) ownerCache.set(key, await threadOwnedBy(first.thread_id, userId));
      ok = ownerCache.get(key)!;
    }
    pathCache.set(path, ok);
    return ok;
  };

  if (run.trigger === "handoff" && !str(run.payload.user_message_id)) {
    const forwarded = imagePathsOfRow(tenantId, run.payload.attachment_paths);
    const childUser = str(run.payload.user_id);
    const opThread = str(run.payload.operator_thread_id);
    if (run.enqueued_by !== null || !forwarded.length || !childUser || !opThread) return NONE;
    if (!(await threadOwnedBy(opThread, childUser))) return NONE;
    const onThread = new Set<string>();
    for (const r of await ownerRows(opThread, null)) for (const p of imagePathsOfRow(tenantId, r.attachments)) onThread.add(p);
    add(forwarded.filter((p) => onThread.has(p)));
    return { candidates, isOwners: (p) => firstAttachedBy(p, childUser) };
  }

  const threadId = str(run.payload.thread_id);
  const messageId = str(run.payload.user_message_id);
  const asker = run.enqueued_by;
  if (!threadId || !messageId || !asker) return NONE;
  if (!(await threadOwnedBy(threadId, asker))) return NONE;

  const { data: msg, error: msgErr } = await db
    .from("agent_thread_messages")
    .select("created_at, thread_id, sender_role")
    .eq("id", messageId)
    .maybeSingle();
  if (msgErr) throw new Error(`owner photo: turn read failed: ${msgErr.message}`);
  const m = msg as { created_at?: string; thread_id?: string; sender_role?: string } | null;
  if (!m || m.thread_id !== threadId || m.sender_role !== "user" || typeof m.created_at !== "string") return NONE;

  for (const r of await ownerRows(threadId, m.created_at)) add(imagePathsOfRow(tenantId, r.attachments));
  return { candidates, isOwners: (p) => firstAttachedBy(p, asker) };
}

export async function listOwnerPhotos(tenantId: string, runId: string): Promise<string[]> {
  const { candidates, isOwners } = await collectOwnerPhotos(tenantId, runId);
  const out: string[] = [];
  for (const p of candidates) {
    if (out.length >= MAX_OWNER_PHOTOS) break;
    if (await isOwners(p)) out.push(p);
  }
  return out;
}

export async function resolveOwnerPhoto(
  tenantId: string,
  runId: string,
  pick: number,
): Promise<OwnerPhotoResolution> {
  try {
    if (!Number.isInteger(pick) || pick < 1) pick = 0;
    const { candidates, isOwners } = await collectOwnerPhotos(tenantId, runId);
    let seen = 0;
    let path: string | null = null;
    for (const p of candidates) {
      if (seen >= MAX_OWNER_PHOTOS) break;
      if (!(await isOwners(p))) continue;
      seen += 1;
      if (seen === pick) {
        path = p;
        break;
      }
    }
    if (seen === 0) return { ok: false, code: "no_attached_photo", available: 0 };
    if (!path) return { ok: false, code: "photo_index_out_of_range", available: seen };
    return { ok: true, path, reference: `${OWNER_PHOTO_BUCKET}/${path}`, index: pick, available: Math.min(candidates.length, MAX_OWNER_PHOTOS) };
  } catch {
    return { ok: false, code: "photo_lookup_failed", available: 0 };
  }
}

