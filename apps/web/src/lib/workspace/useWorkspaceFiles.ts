"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { createBrowserSupabase } from "@/lib/supabase";
import { decodeActiveTenantClaim } from "@/lib/tenant-claim";
import { TENANT_SWITCH_EVENT } from "@/lib/workspace/tenantSwitch";

export type FileRow = {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  created_at: string;
  collection_ids: string[];
};

export type CollectionRow = {
  id: string;
  name: string;
  created_at: string;
  file_count: number;
};

export type PendingUpload = {
  id: string;
  name: string;
  size: number;
  collectionId: string | null;
  status: "uploading" | "failed";
  error: string | null;
};

export type FilesStatus = "loading" | "ready" | "error" | "unavailable";

export type ActionResult<T = null> =
  | { ok: true; value: T }
  | { ok: false; code: string | null; message: string };

export type SkippedUpload = { name: string; reason: string };

export type UploadOutcome = {
  uploaded: FileRow[];
  skipped: SkippedUpload[];
  failed: number;
};

export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;
export const IMAGE_ACCEPT = ACCEPTED_IMAGE_TYPES.join(",");
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 20;
export const COLLECTION_NAME_MAX = 60;

export const WORKSPACE_FILES_CHANGED_EVENT = "zavi:workspace-files-changed";

export function notifyWorkspaceFilesChanged(): void {
  window.dispatchEvent(new Event(WORKSPACE_FILES_CHANGED_EVENT));
}

const FILES_PATH = "/api/workspace/files";
export const COLLECTIONS_PATH = "/api/workspace/file-collections";

const OFFLINE = "Couldn't reach Zavi. Check your connection and try again.";
const SWITCHED = "Stopped because a workspace switch started. Upload it again to keep it.";
const GONE_CODES = new Set(["file_not_found", "collection_not_found"]);

const isGone = (out: Sent) => !out.ok && out.code !== null && GONE_CODES.has(out.code);

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

function imageTypeOf(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[ext] ?? "";
}

export function screenUploads(files: File[]): { accepted: File[]; skipped: SkippedUpload[] } {
  const accepted: File[] = [];
  const skipped: SkippedUpload[] = [];
  for (const file of files) {
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(imageTypeOf(file))) {
      skipped.push({ name: file.name, reason: "Not a PNG, JPEG, WebP, GIF or AVIF image" });
    } else if (file.size > MAX_UPLOAD_BYTES) {
      skipped.push({ name: file.name, reason: "Larger than 10 MB" });
    } else if (file.size === 0) {
      skipped.push({ name: file.name, reason: "The file is empty" });
    } else {
      accepted.push(file);
    }
  }
  return { accepted, skipped };
}

export function validateCollectionName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the collection a name.";
  if (trimmed.length > COLLECTION_NAME_MAX) {
    return `Keep the name to ${COLLECTION_NAME_MAX} characters or fewer.`;
  }
  return null;
}

async function readError(
  res: Response,
  fallback: string,
): Promise<{ code: string | null; message: string }> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof err?.code === "string" ? err.code : null;
  if (typeof err?.message === "string" && err.message.trim()) return { code, message: err.message };
  if (res.status === 413) return { code, message: "That file is larger than 10 MB." };
  if (res.status === 415) {
    return { code, message: "That file type isn't supported. Use PNG, JPEG, WebP, GIF or AVIF." };
  }
  return { code, message: fallback };
}

type Sent = { ok: true; res: Response } | { ok: false; code: string | null; message: string };

async function send(
  path: string,
  init: Parameters<typeof apiFetch>[1],
  fallback: string,
): Promise<Sent> {
  let res: Response;
  try {
    res = await apiFetch(path, init);
  } catch {
    return { ok: false, code: null, message: OFFLINE };
  }
  if (res.ok) return { ok: true, res };
  const err = await readError(res, fallback);
  return { ok: false, ...err };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toFile(value: unknown): FileRow | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.url !== "string") return null;
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : "Untitled",
    mime: typeof value.mime === "string" ? value.mime : "",
    size: typeof value.size === "number" ? value.size : 0,
    url: value.url,
    created_at: typeof value.created_at === "string" ? value.created_at : "",
    collection_ids: Array.isArray(value.collection_ids)
      ? value.collection_ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function toCollection(value: unknown): CollectionRow | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  return {
    id: value.id,
    name: value.name,
    created_at: typeof value.created_at === "string" ? value.created_at : "",
    file_count: typeof value.file_count === "number" ? value.file_count : 0,
  };
}

function toFiles(value: unknown): FileRow[] {
  return Array.isArray(value) ? value.map(toFile).filter((f): f is FileRow => f !== null) : [];
}

function toCollections(value: unknown): CollectionRow[] {
  return Array.isArray(value)
    ? value.map(toCollection).filter((c): c is CollectionRow => c !== null)
    : [];
}

function insertNewestFirst(list: FileRow[], file: FileRow): FileRow[] {
  if (list.some((f) => f.id === file.id)) return list;
  const at = list.findIndex((f) => f.created_at < file.created_at);
  if (at === -1) return [...list, file];
  return [...list.slice(0, at), file, ...list.slice(at)];
}

function bumpCounts(
  list: CollectionRow[],
  deltas: Map<string, number>,
): CollectionRow[] {
  if (deltas.size === 0) return list;
  return list.map((c) => {
    const delta = deltas.get(c.id);
    return delta ? { ...c, file_count: Math.max(0, c.file_count + delta) } : c;
  });
}

export async function runBounded<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await task(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function useWorkspaceFiles() {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [status, setStatus] = useState<FilesStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);

  const filesRef = useRef(files);
  filesRef.current = files;
  const collectionsRef = useRef(collections);
  collectionsRef.current = collections;

  const mounted = useRef(true);
  const loadSeq = useRef(0);
  const loadCtl = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const pendingSeq = useRef(0);
  const reload = useRef<() => Promise<void>>(async () => {});
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const uploadsRunning = useRef(0);
  const [uploadJobs, setUploadJobs] = useState(0);
  const mutations = useRef(0);
  const reloadWhenSettled = useRef(false);
  const tenant = useRef<{ id: string | null; generation: number }>({ id: null, generation: 0 });

  useEffect(() => {
    const onSwitch = () => {
      tenant.current.generation += 1;
    };
    window.addEventListener(TENANT_SWITCH_EVENT, onSwitch);
    return () => window.removeEventListener(TENANT_SWITCH_EVENT, onSwitch);
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    try {
      const { data } = createBrowserSupabase().auth.onAuthStateChange((event, session) => {
        const token = session?.access_token;
        const id = token ? decodeActiveTenantClaim(token) : null;
        const known = tenant.current;
        if (event === "SIGNED_OUT" || (known.id !== null && id !== known.id)) known.generation += 1;
        known.id = id;
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {
      unsubscribe = null;
    }
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (uploadJobs === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploadJobs]);

  const mutate = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    mutations.current += 1;
    try {
      return await work();
    } finally {
      mutations.current -= 1;
      if (mutations.current === 0 && reloadWhenSettled.current && mounted.current) {
        reloadWhenSettled.current = false;
        void reload.current();
      }
    }
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const startedAt = epoch.current;
    loadCtl.current?.abort();
    const ctl = new AbortController();
    loadCtl.current = ctl;
    setStatus((s) => (s === "ready" ? s : "loading"));
    setError(null);
    const stale = () => ctl.signal.aborted || !mounted.current || seq !== loadSeq.current;
    const out = await send(FILES_PATH, { signal: ctl.signal }, "Couldn't load your files.");
    if (stale()) return;
    if (!out.ok) {
      setStatus(out.code === "files_not_ready" ? "unavailable" : "error");
      setError(out.message);
      return;
    }
    const body = await readJson(out.res);
    if (stale()) return;
    if (mutations.current > 0) {
      reloadWhenSettled.current = true;
      return;
    }
    if (epoch.current !== startedAt) {
      void reload.current();
      return;
    }
    const record = isRecord(body) ? body : {};
    setFiles(toFiles(record.files));
    setCollections(toCollections(record.collections));
    setStatus("ready");
  }, []);
  reload.current = load;

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      loadCtl.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const onChanged = () => void reload.current();
    window.addEventListener(WORKSPACE_FILES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(WORKSPACE_FILES_CHANGED_EVENT, onChanged);
  }, []);

  const sendBatch = useCallback(
    async (batch: File[], collectionId: string | null): Promise<{ uploaded: FileRow[]; failed: number }> => {
      const ids = batch.map(() => `pending-${++pendingSeq.current}`);
      setPending((prev) => [
        ...batch.map((file, i) => ({
          id: ids[i]!,
          name: file.name,
          size: file.size,
          collectionId,
          status: "uploading" as const,
          error: null,
        })),
        ...prev,
      ]);
      const form = new FormData();
      for (const file of batch) form.append("files", file, file.name);
      if (collectionId) form.append("collection_id", collectionId);
      const out = await send(
        FILES_PATH,
        { method: "POST", body: form, retryOnNetworkError: false },
        "Upload failed. Try again.",
      );
      if (!mounted.current) return { uploaded: [], failed: out.ok ? 0 : batch.length };
      if (!out.ok) {
        setPending((prev) =>
          prev.map((p) => (ids.includes(p.id) ? { ...p, status: "failed", error: out.message } : p)),
        );
        return { uploaded: [], failed: batch.length };
      }
      const body = await readJson(out.res);
      const rows = toFiles(isRecord(body) ? body.files : null).map((row) =>
        collectionId && !row.collection_ids.includes(collectionId)
          ? { ...row, collection_ids: [...row.collection_ids, collectionId] }
          : row,
      );
      if (!mounted.current) return { uploaded: rows, failed: 0 };
      epoch.current += 1;
      const known = new Set(filesRef.current.map((f) => f.id));
      const fresh = rows.filter((row) => !known.has(row.id));
      const deltas = new Map<string, number>();
      for (const row of fresh) {
        for (const id of row.collection_ids) deltas.set(id, (deltas.get(id) ?? 0) + 1);
      }
      setPending((prev) => prev.filter((p) => !ids.includes(p.id)));
      setFiles((prev) => {
        const have = new Set(prev.map((f) => f.id));
        return [...rows.filter((row) => !have.has(row.id)), ...prev];
      });
      setCollections((prev) => bumpCounts(prev, deltas));
      return { uploaded: rows, failed: 0 };
    },
    [],
  );

  const upload = useCallback(
    async (input: File[], collectionId?: string | null): Promise<UploadOutcome> => {
      const { accepted, skipped } = screenUploads(input);
      if (accepted.length === 0) return { uploaded: [], skipped, failed: 0 };
      const generation = tenant.current.generation;
      const job = async () => {
        const out: Awaited<ReturnType<typeof sendBatch>>[] = [];
        const batches = chunk(accepted, MAX_FILES_PER_REQUEST);
        for (let i = 0; i < batches.length; i++) {
          if (!mounted.current) break;
          if (tenant.current.generation !== generation) {
            const rest = batches.slice(i).flat();
            setPending((prev) => [
              ...rest.map((file) => ({
                id: `pending-${++pendingSeq.current}`,
                name: file.name,
                size: file.size,
                collectionId: collectionId ?? null,
                status: "failed" as const,
                error: SWITCHED,
              })),
              ...prev,
            ]);
            out.push({ uploaded: [], failed: rest.length });
            break;
          }
          out.push(await sendBatch(batches[i]!, collectionId ?? null));
        }
        return out;
      };
      const run = uploadsRunning.current > 0 ? uploadQueue.current.then(job) : job();
      uploadsRunning.current += 1;
      setUploadJobs((n) => n + 1);
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      uploadQueue.current = settled;
      void settled.then(() => {
        uploadsRunning.current -= 1;
        if (mounted.current) setUploadJobs((n) => n - 1);
      });
      const results = await run;
      return {
        uploaded: results.flatMap((r) => r.uploaded),
        skipped,
        failed: results.reduce((n, r) => n + r.failed, 0),
      };
    },
    [sendBatch],
  );

  const dismissPending = useCallback((id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const remove = useCallback((fileId: string): Promise<ActionResult> => mutate(async () => {
    const file = filesRef.current.find((f) => f.id === fileId);
    if (!file) return { ok: false, code: "not_found", message: "That photo is already gone." };
    const minus = new Map(file.collection_ids.map((id) => [id, -1]));
    epoch.current += 1;
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
    setCollections((prev) => bumpCounts(prev, minus));
    const out = await send(
      `${FILES_PATH}/${encodeURIComponent(fileId)}`,
      { method: "DELETE" },
      `Couldn't delete ${file.name}.`,
    );
    if (!mounted.current) return out.ok ? { ok: true, value: null } : out;
    epoch.current += 1;
    if (out.ok || isGone(out)) return { ok: true, value: null };
    const plus = new Map(file.collection_ids.map((id) => [id, 1]));
    setFiles((prev) => insertNewestFirst(prev, file));
    setCollections((prev) => bumpCounts(prev, plus));
    return out;
  }), [mutate]);

  const createCollection = useCallback(
    (name: string): Promise<ActionResult<CollectionRow>> => mutate(async () => {
      const invalid = validateCollectionName(name);
      if (invalid) return { ok: false, code: "bad_name", message: invalid };
      const out = await send(
        COLLECTIONS_PATH,
        { method: "POST", body: JSON.stringify({ name: name.trim() }), retryOnNetworkError: false },
        "Couldn't create the collection.",
      );
      if (!out.ok) return out;
      const body = await readJson(out.res);
      const collection = toCollection(isRecord(body) ? body.collection : null);
      if (!collection) return { ok: false, code: null, message: "Couldn't create the collection." };
      if (!mounted.current) return { ok: true, value: collection };
      epoch.current += 1;
      setCollections((prev) =>
        prev.some((c) => c.id === collection.id) ? prev : [...prev, collection],
      );
      return { ok: true, value: collection };
    }),
    [mutate],
  );

  const renameCollection = useCallback(
    (collectionId: string, name: string): Promise<ActionResult<CollectionRow>> => mutate(async () => {
      const invalid = validateCollectionName(name);
      if (invalid) return { ok: false, code: "bad_name", message: invalid };
      const out = await send(
        `${COLLECTIONS_PATH}/${encodeURIComponent(collectionId)}`,
        { method: "PATCH", body: JSON.stringify({ name: name.trim() }) },
        "Couldn't rename the collection.",
      );
      if (!out.ok) return out;
      const body = await readJson(out.res);
      const renamed = toCollection(isRecord(body) ? body.collection : null);
      const nextName = renamed?.name ?? name.trim();
      const current = collectionsRef.current.find((c) => c.id === collectionId);
      const value: CollectionRow = {
        id: collectionId,
        name: nextName,
        created_at: current?.created_at ?? renamed?.created_at ?? "",
        file_count: current?.file_count ?? renamed?.file_count ?? 0,
      };
      if (!mounted.current) return { ok: true, value };
      epoch.current += 1;
      setCollections((prev) => prev.map((c) => (c.id === collectionId ? { ...c, name: nextName } : c)));
      return { ok: true, value };
    }),
    [mutate],
  );

  const deleteCollection = useCallback((collectionId: string): Promise<ActionResult> => mutate(async () => {
    const index = collectionsRef.current.findIndex((c) => c.id === collectionId);
    const collection = collectionsRef.current[index];
    if (!collection) return { ok: false, code: "not_found", message: "That collection is already gone." };
    const members = filesRef.current
      .filter((f) => f.collection_ids.includes(collectionId))
      .map((f) => f.id);
    epoch.current += 1;
    setCollections((prev) => prev.filter((c) => c.id !== collectionId));
    setFiles((prev) =>
      prev.map((f) =>
        f.collection_ids.includes(collectionId)
          ? { ...f, collection_ids: f.collection_ids.filter((id) => id !== collectionId) }
          : f,
      ),
    );
    const out = await send(
      `${COLLECTIONS_PATH}/${encodeURIComponent(collectionId)}`,
      { method: "DELETE" },
      `Couldn't delete ${collection.name}.`,
    );
    if (!mounted.current) return out.ok ? { ok: true, value: null } : out;
    epoch.current += 1;
    if (out.ok || isGone(out)) return { ok: true, value: null };
    setCollections((prev) => {
      if (prev.some((c) => c.id === collectionId)) return prev;
      const next = [...prev];
      next.splice(Math.min(index, next.length), 0, collection);
      return next;
    });
    setFiles((prev) =>
      prev.map((f) =>
        members.includes(f.id) && !f.collection_ids.includes(collectionId)
          ? { ...f, collection_ids: [...f.collection_ids, collectionId] }
          : f,
      ),
    );
    return out;
  }), [mutate]);

  const addToCollection = useCallback(
    (collectionId: string, fileIds: string[]): Promise<ActionResult> => mutate(async () => {
      const added = filesRef.current
        .filter((f) => fileIds.includes(f.id) && !f.collection_ids.includes(collectionId))
        .map((f) => f.id);
      if (added.length === 0) return { ok: true, value: null };
      epoch.current += 1;
      setFiles((prev) =>
        prev.map((f) =>
          added.includes(f.id) && !f.collection_ids.includes(collectionId)
            ? { ...f, collection_ids: [...f.collection_ids, collectionId] }
            : f,
        ),
      );
      setCollections((prev) => bumpCounts(prev, new Map([[collectionId, added.length]])));
      const out = await send(
        `${COLLECTIONS_PATH}/${encodeURIComponent(collectionId)}/files`,
        { method: "POST", body: JSON.stringify({ file_ids: added }), retryOnNetworkError: false },
        "Couldn't add the photos to that collection.",
      );
      if (!mounted.current) return out.ok ? { ok: true, value: null } : out;
      epoch.current += 1;
      if (out.ok) return { ok: true, value: null };
      setFiles((prev) =>
        prev.map((f) =>
          added.includes(f.id)
            ? { ...f, collection_ids: f.collection_ids.filter((id) => id !== collectionId) }
            : f,
        ),
      );
      setCollections((prev) => bumpCounts(prev, new Map([[collectionId, -added.length]])));
      return out;
    }),
    [mutate],
  );

  const removeFromCollection = useCallback(
    (collectionId: string, fileId: string): Promise<ActionResult> => mutate(async () => {
      const file = filesRef.current.find((f) => f.id === fileId);
      if (!file || !file.collection_ids.includes(collectionId)) return { ok: true, value: null };
      epoch.current += 1;
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, collection_ids: f.collection_ids.filter((id) => id !== collectionId) }
            : f,
        ),
      );
      setCollections((prev) => bumpCounts(prev, new Map([[collectionId, -1]])));
      const out = await send(
        `${COLLECTIONS_PATH}/${encodeURIComponent(collectionId)}/files/${encodeURIComponent(fileId)}`,
        { method: "DELETE" },
        `Couldn't remove ${file.name} from the collection.`,
      );
      if (!mounted.current) return out.ok ? { ok: true, value: null } : out;
      epoch.current += 1;
      if (out.ok || isGone(out)) return { ok: true, value: null };
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId && !f.collection_ids.includes(collectionId)
            ? { ...f, collection_ids: [...f.collection_ids, collectionId] }
            : f,
        ),
      );
      setCollections((prev) => bumpCounts(prev, new Map([[collectionId, 1]])));
      return out;
    }),
    [mutate],
  );

  return {
    status,
    error,
    files,
    collections,
    pending,
    load,
    upload,
    dismissPending,
    remove,
    createCollection,
    renameCollection,
    deleteCollection,
    addToCollection,
    removeFromCollection,
  };
}
