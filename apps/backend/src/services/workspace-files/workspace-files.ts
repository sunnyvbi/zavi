import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tenantStorage, type TenantId } from "@/services/tenant-client";
import {
  WORKSPACE_FILE_MIMES,
  displayName,
  normalizeDeclaredMime,
  sanitizeFileName,
  sniffImageMime,
  type WorkspaceFileMime,
} from "./sniff";

export const WORKSPACE_FILES_BUCKET = "tenant-documents";
export const WORKSPACE_FILES_PREFIX = "workspace-files";
export const WORKSPACE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const WORKSPACE_FILE_MAX_COUNT = 20;
export const WORKSPACE_UPLOAD_MAX_REQUEST_BYTES = WORKSPACE_FILE_MAX_BYTES * WORKSPACE_FILE_MAX_COUNT + 1024 * 1024;
export const WORKSPACE_COLLECTION_NAME_MAX = 60;
export const WORKSPACE_COLLECTION_ADD_MAX = 100;
export const WORKSPACE_FILES_TOTAL_MAX = 5000;
export const WORKSPACE_COLLECTIONS_TOTAL_MAX = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FileRow = {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  created_at: string;
  collection_ids: string[];
};

export type CollectionRow = { id: string; name: string; created_at: string; file_count: number };

export type IncomingFile = { originalname: string; mimetype: string; size: number; buffer: Buffer };

export type IndexFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  created_at: string;
  uploaded_by: string | null;
  origin?: string;
};

export type IndexCollection = { id: string; name: string; created_at: string; file_ids: string[] };

export type WorkspaceFilesIndex = { version: 1; rev?: number; files: IndexFile[]; collections: IndexCollection[] };

export type WorkspaceFilesDeps = {
  tenantId: TenantId;
  storage: SupabaseClient["storage"];
  newId: () => string;
  now: () => Date;
  publicBase: string;
};

export class WorkspaceFilesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function workspaceFilesPublicBase(): string {
  const base = process.env.BACKEND_PUBLIC_URL?.trim() || "https://api.zaviagent.com";
  return base.replace(/\/+$/, "");
}

export function workspaceFilesDeps(tenantId: TenantId): WorkspaceFilesDeps {
  return {
    tenantId,
    storage: tenantStorage(tenantId),
    newId: randomUUID,
    now: () => new Date(),
    publicBase: workspaceFilesPublicBase(),
  };
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function indexPath(tenantId: string): string {
  return `${tenantId}/${WORKSPACE_FILES_PREFIX}/index.json`;
}

export function fileObjectPath(tenantId: string, fileId: string, storedName: string): string {
  return `${tenantId}/${WORKSPACE_FILES_PREFIX}/${fileId}/${storedName}`;
}

export function isServableName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !/[/\\\0]/.test(name)
  );
}

export function publicUrl(deps: WorkspaceFilesDeps, f: IndexFile): string {
  const stored = f.path.split("/").pop() ?? "";
  return `${deps.publicBase}/api/public/workspace-files/${deps.tenantId}/${f.id}/${encodeURIComponent(stored)}`;
}

function ownsPath(deps: WorkspaceFilesDeps, path: unknown): path is string {
  if (typeof path !== "string") return false;
  const segments = path.split("/");
  return (
    segments.length === 4 &&
    segments[0] === deps.tenantId &&
    segments[1] === WORKSPACE_FILES_PREFIX &&
    isUuid(segments[2]) &&
    segments.every((seg) => seg.length > 0 && seg !== "." && seg !== "..")
  );
}

type StorageErr = { message?: string; statusCode?: string | number; status?: number } | null;

function isNotFound(error: StorageErr): boolean {
  if (!error) return false;
  return String(error.statusCode) === "404" || error.status === 404 || /not found/i.test(error.message ?? "");
}

function unavailable(where: string, error: unknown): never {
  const msg = error instanceof Error ? error.message : (error as StorageErr)?.message;
  console.error(`[workspace-files] ${where}: ${msg ?? "unknown"}`);
  throw new WorkspaceFilesError(503, "files_unavailable", "Your files could not be reached. Try again.");
}

function emptyIndex(): WorkspaceFilesIndex {
  return { version: 1, files: [], collections: [] };
}

function parseIndex(raw: string): WorkspaceFilesIndex {
  const parsed = JSON.parse(raw) as Partial<WorkspaceFilesIndex>;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.files) || !Array.isArray(parsed.collections)) {
    throw new Error("index has an unexpected shape");
  }
  const rev = typeof parsed.rev === "number" && Number.isFinite(parsed.rev) ? parsed.rev : 0;
  return { version: 1, rev, files: parsed.files, collections: parsed.collections };
}

const lastWritten = new Map<string, WorkspaceFilesIndex>();

export function _resetIndexMemoForTest(): void {
  lastWritten.clear();
}

function newest(deps: WorkspaceFilesDeps, stored: WorkspaceFilesIndex): WorkspaceFilesIndex {
  const mine = lastWritten.get(deps.tenantId);
  return mine && (mine.rev ?? 0) > (stored.rev ?? 0) ? mine : stored;
}

export async function readIndex(deps: WorkspaceFilesDeps): Promise<WorkspaceFilesIndex> {
  let result: { data: Blob | null; error: StorageErr };
  try {
    result = (await deps.storage.from(WORKSPACE_FILES_BUCKET).download(indexPath(deps.tenantId))) as typeof result;
  } catch (e) {
    unavailable("index read threw", e);
  }
  if (result.error) {
    if (isNotFound(result.error)) return newest(deps, emptyIndex());
    unavailable("index read failed", result.error);
  }
  try {
    return newest(deps, parseIndex(await (result.data as Blob).text()));
  } catch (e) {
    console.error(`[workspace-files] index for ${deps.tenantId} is unreadable: ${(e as Error).message}`);
    throw new WorkspaceFilesError(500, "files_index_corrupt", "Something went wrong with your files. Try again.");
  }
}

async function writeIndex(deps: WorkspaceFilesDeps, index: WorkspaceFilesIndex): Promise<void> {
  const next: WorkspaceFilesIndex = { ...index, rev: (index.rev ?? 0) + 1 };
  let error: StorageErr;
  try {
    ({ error } = (await deps.storage
      .from(WORKSPACE_FILES_BUCKET)
      .upload(indexPath(deps.tenantId), Buffer.from(JSON.stringify(next)), {
        contentType: "application/json",
        cacheControl: "0",
        upsert: true,
      })) as { error: StorageErr });
  } catch (e) {
    unavailable("index write threw", e);
  }
  if (error) unavailable("index write failed", error);
  lastWritten.set(deps.tenantId, next);
}

const tenantLocks = new Map<string, Promise<unknown>>();

export function withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tenantLocks.get(tenantId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tenantLocks.set(tenantId, tail);
  void tail.then(() => {
    if (tenantLocks.get(tenantId) === tail) tenantLocks.delete(tenantId);
  });
  return run;
}

function mutate<T>(deps: WorkspaceFilesDeps, fn: (index: WorkspaceFilesIndex) => Promise<T>): Promise<T> {
  return withTenantLock(deps.tenantId, async () => fn(await readIndex(deps)));
}

function toFileRow(deps: WorkspaceFilesDeps, f: IndexFile, collectionIds: string[]): FileRow {
  return {
    id: f.id,
    name: f.name,
    mime: f.mime,
    size: f.size,
    url: publicUrl(deps, f),
    created_at: f.created_at,
    collection_ids: collectionIds,
  };
}

function byNewest(a: IndexFile, b: IndexFile): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byName(a: IndexCollection, b: IndexCollection): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function collectionRow(index: WorkspaceFilesIndex, c: IndexCollection): CollectionRow {
  const fileIds = new Set(index.files.map((f) => f.id));
  return {
    id: c.id,
    name: c.name,
    created_at: c.created_at,
    file_count: new Set(c.file_ids.filter((id) => fileIds.has(id))).size,
  };
}

export async function listWorkspaceFiles(
  deps: WorkspaceFilesDeps,
): Promise<{ files: FileRow[]; collections: CollectionRow[] }> {
  const index = await readIndex(deps);
  const byFile = new Map<string, string[]>();
  const collections = [...index.collections].sort(byName);
  for (const c of collections) {
    for (const fileId of new Set(c.file_ids)) byFile.set(fileId, [...(byFile.get(fileId) ?? []), c.id]);
  }
  return {
    files: [...index.files].sort(byNewest).map((f) => toFileRow(deps, f, byFile.get(f.id) ?? [])),
    collections: collections.map((c) => collectionRow(index, c)),
  };
}

function requireCollection(index: WorkspaceFilesIndex, id: unknown): IndexCollection {
  const found = isUuid(id) ? index.collections.find((c) => c.id === id.toLowerCase()) : undefined;
  if (!found) throw new WorkspaceFilesError(404, "collection_not_found", "That collection was not found.");
  return found;
}

type Validated = { file: IncomingFile; mime: WorkspaceFileMime; name: string };

function validateUpload(files: IncomingFile[]): Validated[] {
  if (files.length === 0) throw new WorkspaceFilesError(400, "no_files", "Choose at least one photo to upload.");
  if (files.length > WORKSPACE_FILE_MAX_COUNT) {
    throw new WorkspaceFilesError(400, "too_many_files", `Upload at most ${WORKSPACE_FILE_MAX_COUNT} photos at a time.`);
  }
  return files.map((file) => {
    const size = file.buffer?.length ?? 0;
    if (size > WORKSPACE_FILE_MAX_BYTES || file.size > WORKSPACE_FILE_MAX_BYTES) {
      throw new WorkspaceFilesError(413, "file_too_large", `${displayName(file.originalname)} is larger than 10MB.`);
    }
    const declared = normalizeDeclaredMime(file.mimetype);
    const sniffed = size > 0 ? sniffImageMime(file.buffer) : null;
    if (!declared || !sniffed) {
      throw new WorkspaceFilesError(
        415,
        "unsupported_type",
        `${displayName(file.originalname)} is not a supported image (${WORKSPACE_FILE_MIMES.join(", ")}).`,
      );
    }
    return { file, mime: sniffed, name: displayName(file.originalname) };
  });
}

async function removeObjects(deps: WorkspaceFilesDeps, paths: string[]): Promise<void> {
  const owned = paths.filter((p) => ownsPath(deps, p));
  if (owned.length === 0) return;
  const error = await deps.storage
    .from(WORKSPACE_FILES_BUCKET)
    .remove(owned)
    .then(
      (r) => r.error as unknown,
      (e: unknown) => e,
    );
  if (error) {
    const reason = error instanceof Error ? error.message : (error as StorageErr)?.message;
    console.error(`[workspace-files] orphaned objects ${owned.join(", ")}: ${reason ?? "unknown"}`);
  }
}

export async function uploadWorkspaceFiles(
  deps: WorkspaceFilesDeps,
  input: { files: IncomingFile[]; collectionId?: unknown; uploadedBy?: string | null; origin?: string },
): Promise<FileRow[]> {
  const validated = validateUpload(input.files);
  const hasCollection = input.collectionId !== undefined && input.collectionId !== null && input.collectionId !== "";

  return mutate(deps, async (index) => {
    const collection = hasCollection ? requireCollection(index, input.collectionId) : null;
    if (input.origin) {
      const existing = index.files.filter((f) => f.origin === input.origin);
      if (existing.length > 0) {
        return existing.map((f) =>
          toFileRow(deps, f, index.collections.filter((c) => c.file_ids.includes(f.id)).map((c) => c.id)),
        );
      }
    }
    if (index.files.length + validated.length > WORKSPACE_FILES_TOTAL_MAX) {
      throw new WorkspaceFilesError(
        409,
        "files_limit",
        `A workspace can hold up to ${WORKSPACE_FILES_TOTAL_MAX} photos. Delete some to make room.`,
      );
    }

    const createdAt = deps.now().toISOString();
    const planned: IndexFile[] = validated.map((v) => {
      const id = deps.newId();
      return {
        id,
        name: v.name,
        mime: v.mime,
        size: v.file.buffer.length,
        path: fileObjectPath(deps.tenantId, id, sanitizeFileName(v.file.originalname, v.mime)),
        created_at: createdAt,
        uploaded_by: input.uploadedBy ?? null,
        ...(input.origin ? { origin: input.origin } : {}),
      };
    });

    const uploaded: string[] = [];
    try {
      for (const [i, p] of planned.entries()) {
        const { error } = await deps.storage.from(WORKSPACE_FILES_BUCKET).upload(p.path, validated[i].file.buffer, {
          contentType: p.mime,
          cacheControl: "31536000",
          upsert: false,
        });
        if (error) {
          console.error(`[workspace-files] object upload failed: ${error.message}`);
          throw new WorkspaceFilesError(502, "upload_failed", "Could not store one of the photos. Nothing was saved.");
        }
        uploaded.push(p.path);
      }

      const next: WorkspaceFilesIndex = {
        ...index,
        files: [...index.files, ...planned],
        collections: collection
          ? index.collections.map((c) =>
              c.id === collection.id ? { ...c, file_ids: [...c.file_ids, ...planned.map((p) => p.id)] } : c,
            )
          : index.collections,
      };
      await writeIndex(deps, next);
    } catch (e) {
      await removeObjects(deps, uploaded);
      throw e;
    }

    return planned.map((p) => toFileRow(deps, p, collection ? [collection.id] : []));
  });
}

export async function deleteWorkspaceFile(deps: WorkspaceFilesDeps, id: unknown): Promise<void> {
  if (!isUuid(id)) throw new WorkspaceFilesError(404, "file_not_found", "That file was not found.");
  const fileId = id.toLowerCase();
  await mutate(deps, async (index) => {
    const file = index.files.find((f) => f.id === fileId);
    if (!file) throw new WorkspaceFilesError(404, "file_not_found", "That file was not found.");
    if (ownsPath(deps, file.path)) {
      const error = await deps.storage
        .from(WORKSPACE_FILES_BUCKET)
        .remove([file.path])
        .then(
          (r) => r.error as unknown,
          (e: unknown) => e,
        );
      if (error) unavailable("delete object failed", error);
    }
    await writeIndex(deps, {
      ...index,
      files: index.files.filter((f) => f.id !== fileId),
      collections: index.collections.map((c) => ({ ...c, file_ids: c.file_ids.filter((f) => f !== fileId) })),
    });
  });
}

export function normalizeCollectionName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  const len = Array.from(name).length;
  if (len < 1 || len > WORKSPACE_COLLECTION_NAME_MAX) {
    throw new WorkspaceFilesError(400, "bad_name", `Collection names must be 1 to ${WORKSPACE_COLLECTION_NAME_MAX} characters.`);
  }
  return name;
}

function assertNameFree(index: WorkspaceFilesIndex, name: string, exceptId?: string): void {
  const lower = name.toLowerCase();
  if (index.collections.some((c) => c.id !== exceptId && c.name.toLowerCase() === lower)) {
    throw new WorkspaceFilesError(409, "collection_exists", "A collection with that name already exists.");
  }
}

export async function createCollection(deps: WorkspaceFilesDeps, rawName: unknown): Promise<CollectionRow> {
  const name = normalizeCollectionName(rawName);
  return mutate(deps, async (index) => {
    assertNameFree(index, name);
    if (index.collections.length >= WORKSPACE_COLLECTIONS_TOTAL_MAX) {
      throw new WorkspaceFilesError(
        409,
        "collections_limit",
        `A workspace can hold up to ${WORKSPACE_COLLECTIONS_TOTAL_MAX} collections.`,
      );
    }
    const created: IndexCollection = { id: deps.newId(), name, created_at: deps.now().toISOString(), file_ids: [] };
    await writeIndex(deps, { ...index, collections: [...index.collections, created] });
    return { id: created.id, name, created_at: created.created_at, file_count: 0 };
  });
}

export async function renameCollection(deps: WorkspaceFilesDeps, id: unknown, rawName: unknown): Promise<CollectionRow> {
  const name = normalizeCollectionName(rawName);
  return mutate(deps, async (index) => {
    const existing = requireCollection(index, id);
    assertNameFree(index, name, existing.id);
    const renamed = { ...existing, name };
    const next = { ...index, collections: index.collections.map((c) => (c.id === existing.id ? renamed : c)) };
    await writeIndex(deps, next);
    return collectionRow(next, renamed);
  });
}

export async function deleteCollection(deps: WorkspaceFilesDeps, id: unknown): Promise<void> {
  await mutate(deps, async (index) => {
    const existing = requireCollection(index, id);
    await writeIndex(deps, { ...index, collections: index.collections.filter((c) => c.id !== existing.id) });
  });
}

export async function addFilesToCollection(deps: WorkspaceFilesDeps, id: unknown, rawFileIds: unknown): Promise<void> {
  if (
    !Array.isArray(rawFileIds) ||
    rawFileIds.length < 1 ||
    rawFileIds.length > WORKSPACE_COLLECTION_ADD_MAX ||
    !rawFileIds.every(isUuid)
  ) {
    throw new WorkspaceFilesError(400, "bad_file_ids", `file_ids must be 1 to ${WORKSPACE_COLLECTION_ADD_MAX} file ids.`);
  }
  const fileIds = [...new Set((rawFileIds as string[]).map((f) => f.toLowerCase()))];
  await mutate(deps, async (index) => {
    const collection = requireCollection(index, id);
    const known = new Set(index.files.map((f) => f.id));
    if (fileIds.some((f) => !known.has(f))) {
      throw new WorkspaceFilesError(404, "file_not_found", "One or more files were not found.");
    }
    const missing = fileIds.filter((f) => !collection.file_ids.includes(f));
    if (missing.length === 0) return;
    await writeIndex(deps, {
      ...index,
      collections: index.collections.map((c) =>
        c.id === collection.id ? { ...c, file_ids: [...c.file_ids, ...missing] } : c,
      ),
    });
  });
}

export async function removeFileFromCollection(deps: WorkspaceFilesDeps, id: unknown, fileId: unknown): Promise<void> {
  if (!isUuid(fileId)) throw new WorkspaceFilesError(404, "file_not_found", "That file was not found.");
  const target = fileId.toLowerCase();
  await mutate(deps, async (index) => {
    const collection = requireCollection(index, id);
    if (!collection.file_ids.includes(target)) return;
    await writeIndex(deps, {
      ...index,
      collections: index.collections.map((c) =>
        c.id === collection.id ? { ...c, file_ids: c.file_ids.filter((f) => f !== target) } : c,
      ),
    });
  });
}

export type ServedFile = { body: Buffer; mime: WorkspaceFileMime };

export async function readPublicWorkspaceFile(
  storage: SupabaseClient["storage"],
  tenantId: unknown,
  fileId: unknown,
  name: unknown,
): Promise<ServedFile | null> {
  if (!isUuid(tenantId) || !isUuid(fileId) || !isServableName(name)) return null;
  const path = fileObjectPath(tenantId.toLowerCase(), fileId.toLowerCase(), name);
  const { data, error } = (await storage.from(WORKSPACE_FILES_BUCKET).download(path)) as {
    data: Blob | null;
    error: StorageErr;
  };
  if (error) {
    if (isNotFound(error)) return null;
    unavailable("public read failed", error);
  }
  const body = Buffer.from(await (data as Blob).arrayBuffer());
  const mime = sniffImageMime(body);
  return mime ? { body, mime } : null;
}
