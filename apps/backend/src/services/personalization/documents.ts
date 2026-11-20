
import { randomUUID } from "node:crypto";
import path from "node:path";
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { isMissingRelation, noteMissingRelationOnce } from "./missing-relation";

export const DOCUMENT_BUCKET = "tenant-documents";
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export const ALLOWED_EXTENSIONS = new Set([
  "pdf", "txt", "md", "csv", "json", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "png", "jpg", "jpeg", "webp", "gif",
]);

export type DocumentStatus = "approved" | "archived" | "imported";

export type TenantDocument = {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  status: DocumentStatus;
  version: number;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
};

const SELECT = "id, filename, mime, size_bytes, status, version, uploaded_by, created_at, updated_at, storage_path";

type Row = TenantDocument & { storage_path: string };

export class DocumentError extends Error {
  constructor(
    public readonly code: "unsupported_extension" | "bad_filename" | "not_found" | "upload_failed" | "write_failed" | "sign_failed",
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export function safeFilename(raw: string): string {
  const base = path.basename(raw).replace(/[\u0000-\u001f\\/]+/g, "").trim();
  return base.slice(0, 200);
}

function extensionOf(filename: string): string {
  return path.extname(filename).toLowerCase().slice(1);
}

function strip(row: Row): TenantDocument {
  const { storage_path: _p, ...rest } = row;
  return rest;
}

function objectPath(tenant_id: string, doc_id: string, version: number, filename: string): string {
  return `${tenant_id}/${doc_id}/${version}/${filename}`;
}

async function rows(tenant_id: string, status?: DocumentStatus, opts: { excludeImported?: boolean } = {}): Promise<Row[]> {
  try {
    let q = tenantClient(asTenantId(tenant_id)).from("tenant_document").select(SELECT);
    if (status) q = q.eq("status", status);
    if (opts.excludeImported) q = q.neq("status", "imported");
    const { data, error } = await q.order("updated_at", { ascending: false }).limit(200);
    if (error) {
      if (isMissingRelation(error)) {
        noteMissingRelationOnce("tenant_document", error);
        return [];
      }
      throw new Error(error.message);
    }
    return (data ?? []) as Row[];
  } catch (e) {
    if (isMissingRelation(e)) {
      noteMissingRelationOnce("tenant_document", e);
      return [];
    }
    throw e;
  }
}

export async function listDocuments(
  tenant_id: string,
  status?: DocumentStatus,
  opts: { excludeImported?: boolean } = {},
): Promise<TenantDocument[]> {
  return (await rows(tenant_id, status, opts)).map(strip);
}

async function getRow(tenant_id: string, id: string): Promise<Row> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .select(SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new DocumentError("write_failed", error.message, 500);
  if (!data) throw new DocumentError("not_found", "document not found", 404);
  return data as Row;
}

function validate(filename: string): string {
  const name = safeFilename(filename);
  if (!name) throw new DocumentError("bad_filename", "filename is required", 400);
  const ext = extensionOf(name);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new DocumentError(
      "unsupported_extension",
      `.${ext || "?"} is not supported (allowed: ${[...ALLOWED_EXTENSIONS].join(", ")})`,
      400,
    );
  }
  return name;
}

async function putObject(tenant_id: string, storage_path: string, buffer: Buffer, mime: string): Promise<void> {
  const { error } = await tenantStorage(asTenantId(tenant_id))
    .from(DOCUMENT_BUCKET)
    .upload(storage_path, buffer, { contentType: mime, upsert: false });
  if (error) throw new DocumentError("upload_failed", error.message, 500);
}

async function removeObject(tenant_id: string, storage_path: string): Promise<void> {
  try {
    await tenantStorage(asTenantId(tenant_id)).from(DOCUMENT_BUCKET).remove([storage_path]);
  } catch {
  }
}

export async function uploadDocument(
  tenant_id: string,
  input: { buffer: Buffer; filename: string; mime: string; actor_user_id: string | null; status?: "approved" | "imported" },
): Promise<TenantDocument> {
  const filename = validate(input.filename);
  const id = randomUUID();
  const storage_path = objectPath(tenant_id, id, 1, filename);
  await putObject(tenant_id, storage_path, input.buffer, input.mime);
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .insert({
      id,
      filename,
      mime: input.mime,
      size_bytes: input.buffer.byteLength,
      storage_path,
      status: input.status ?? "approved",
      version: 1,
      uploaded_by: input.actor_user_id,
    })
    .select(SELECT)
    .single();
  if (error) {
    if ((input.status ?? "approved") === "imported") {
      const { error: rmErr } = await tenantStorage(asTenantId(tenant_id)).from(DOCUMENT_BUCKET).remove([storage_path]);
      if (rmErr) console.error(`[documents] ORPHANED imported object ${storage_path}: ${rmErr.message}`);
    } else {
      await removeObject(tenant_id, storage_path);
    }
    throw new DocumentError("write_failed", error.message, 500);
  }
  return strip(data as Row);
}

export async function replaceDocument(
  tenant_id: string,
  id: string,
  input: { buffer: Buffer; filename: string; mime: string; actor_user_id: string | null },
): Promise<TenantDocument> {
  const current = await getRow(tenant_id, id);
  if (current.status === "imported") {
    throw new DocumentError("not_found", "imported files are managed under Settings → Personalization", 409);
  }
  const filename = validate(input.filename);
  const version = current.version + 1;
  const storage_path = objectPath(tenant_id, id, version, filename);
  await putObject(tenant_id, storage_path, input.buffer, input.mime);
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .update({
      filename,
      mime: input.mime,
      size_bytes: input.buffer.byteLength,
      storage_path,
      version,
      uploaded_by: input.actor_user_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(SELECT)
    .single();
  if (error) {
    await removeObject(tenant_id, storage_path);
    throw new DocumentError("write_failed", error.message, 500);
  }
  await removeObject(tenant_id, current.storage_path);
  signedCache.delete(cacheKey(id, current.version));
  return strip(data as Row);
}

export async function setDocumentStatus(
  tenant_id: string,
  id: string,
  status: DocumentStatus,
): Promise<TenantDocument> {
  const current = await getRow(tenant_id, id);
  if (current.status === "imported") {
    throw new DocumentError("not_found", "imported files are managed under Settings → Personalization", 409);
  }
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(SELECT)
    .single();
  if (error) throw new DocumentError("write_failed", error.message, 500);
  return strip(data as Row);
}

export async function deleteDocument(tenant_id: string, id: string): Promise<void> {
  const current = await getRow(tenant_id, id);
  if (current.status === "imported") {
    throw new DocumentError("not_found", "imported files are managed under Settings → Personalization", 409);
  }
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .delete()
    .eq("id", id);
  if (error) throw new DocumentError("write_failed", error.message, 500);
  await removeObject(tenant_id, current.storage_path);
  signedCache.delete(cacheKey(id, current.version));
}

export async function signedDownloadUrl(tenant_id: string, id: string, ttlSeconds = 300): Promise<string> {
  const row = await getRow(tenant_id, id);
  return signPath(tenant_id, row.storage_path, ttlSeconds);
}

async function signPath(tenant_id: string, storage_path: string, ttlSeconds: number): Promise<string> {
  const { data, error } = await tenantStorage(asTenantId(tenant_id))
    .from(DOCUMENT_BUCKET)
    .createSignedUrl(storage_path, ttlSeconds);
  if (error || !data?.signedUrl) {
    throw new DocumentError("sign_failed", error?.message ?? "could not sign url", 500);
  }
  return data.signedUrl;
}

export async function getDocument(
  tenant_id: string,
  id: string,
): Promise<TenantDocument & { storage_path: string; extraction: unknown }> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .select(`${SELECT}, extraction`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new DocumentError("write_failed", error.message, 500);
  if (!data) throw new DocumentError("not_found", "document not found", 404);
  return data as TenantDocument & { storage_path: string; extraction: unknown };
}

export async function downloadDocument(tenant_id: string, storage_path: string): Promise<Buffer> {
  if (!storage_path.startsWith(`${tenant_id}/`)) {
    throw new DocumentError("not_found", "document not found", 404);
  }
  const { data, error } = await tenantStorage(asTenantId(tenant_id)).from(DOCUMENT_BUCKET).download(storage_path);
  if (error || !data) throw new DocumentError("sign_failed", error?.message ?? "download failed", 500);
  return Buffer.from(await data.arrayBuffer());
}

export async function setDocumentExtraction(
  tenant_id: string,
  id: string,
  claimId: string,
  extraction: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .update({ extraction, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "imported")
    .eq("extraction->>state", "reading")
    .eq("extraction->>claim_id", claimId)
    .select("id");
  if (error) throw new DocumentError("write_failed", error.message, 500);
  return (data ?? []).length === 1;
}

export function encodeImportCursor(created_at: string, id: string): string {
  return Buffer.from(`${created_at}|${id}`, "utf8").toString("base64url");
}
function decodeImportCursor(cursor: string): { created_at: string; id: string } | null {
  const [created_at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  return created_at && /^[0-9a-f-]{36}$/i.test(id ?? "") && !Number.isNaN(Date.parse(created_at)) ? { created_at, id } : null;
}

export async function listImportedDocuments(
  tenant_id: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<{ documents: Array<TenantDocument & { extraction: unknown }>; next_cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  let q = tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .select(`${SELECT}, extraction`)
    .eq("status", "imported");
  const at = opts.cursor ? decodeImportCursor(opts.cursor) : null;
  if (opts.cursor && !at) throw new DocumentError("bad_filename", "invalid cursor", 400);
  if (at) q = q.or(`created_at.lt.${at.created_at},and(created_at.eq.${at.created_at},id.lt.${at.id})`);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw new DocumentError("write_failed", error.message, 500);
  const rows = (data ?? []) as Array<Row & { extraction: unknown }>;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    documents: page.map((r) => ({ ...strip(r), extraction: r.extraction })),
    next_cursor: rows.length > limit && last ? encodeImportCursor(last.created_at, last.id) : null,
  };
}

export const READ_CLAIM_STALE_MS = 3 * 60 * 1000;

export async function claimDocumentDeletion(tenant_id: string, id: string, now = Date.now()): Promise<boolean> {
  const db = tenantClient(asTenantId(tenant_id));
  const claim = { extraction: { state: "deleting", claimed_at: new Date(now).toISOString() } };
  const notReading = await db
    .from("tenant_document")
    .update(claim)
    .eq("id", id)
    .eq("status", "imported")
    .or("extraction.is.null,extraction->>state.neq.reading")
    .select("id");
  if (notReading.error) throw new DocumentError("write_failed", notReading.error.message, 500);
  if ((notReading.data ?? []).length > 0) return true;
  const staleRead = await db
    .from("tenant_document")
    .update(claim)
    .eq("id", id)
    .eq("status", "imported")
    .eq("extraction->>state", "reading")
    .lt("extraction->>claimed_at", new Date(now - READ_CLAIM_STALE_MS).toISOString())
    .select("id");
  if (staleRead.error) throw new DocumentError("write_failed", staleRead.error.message, 500);
  return (staleRead.data ?? []).length > 0;
}

export async function claimDocumentRead(tenant_id: string, id: string, now = Date.now()): Promise<string | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const claimId = randomUUID();
  const claim = { extraction: { state: "reading", claim_id: claimId, claimed_at: new Date(now).toISOString() } };
  const fresh = await db.from("tenant_document").update(claim).eq("id", id).eq("status", "imported").is("extraction", null).select("id");
  if (fresh.error) throw new DocumentError("write_failed", fresh.error.message, 500);
  if ((fresh.data ?? []).length > 0) return claimId;
  const stale = await db
    .from("tenant_document")
    .update(claim)
    .eq("id", id)
    .eq("status", "imported")
    .in("extraction->>state", ["reading", "compensating"])
    .lt("extraction->>claimed_at", new Date(now - READ_CLAIM_STALE_MS).toISOString())
    .select("id");
  if (stale.error) throw new DocumentError("write_failed", stale.error.message, 500);
  return (stale.data ?? []).length > 0 ? claimId : null;
}

export async function beginReadCompensation(tenant_id: string, id: string, claimId: string, now = Date.now()): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .update({ extraction: { state: "compensating", claim_id: claimId, claimed_at: new Date(now).toISOString() } })
    .eq("id", id)
    .eq("status", "imported")
    .eq("extraction->>state", "reading")
    .eq("extraction->>claim_id", claimId)
    .select("id");
  if (error) throw new DocumentError("write_failed", error.message, 500);
  return (data ?? []).length === 1;
}

export async function finishReadCompensation(tenant_id: string, id: string, claimId: string): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .update({ extraction: null })
    .eq("id", id)
    .eq("status", "imported")
    .eq("extraction->>state", "compensating")
    .eq("extraction->>claim_id", claimId);
  if (error) throw new DocumentError("write_failed", error.message, 500);
}

export async function releaseDocumentRead(tenant_id: string, id: string, claimId: string): Promise<void> {
  await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .update({ extraction: null })
    .eq("id", id)
    .eq("status", "imported")
    .eq("extraction->>state", "reading")
    .eq("extraction->>claim_id", claimId);
}

export async function removeImportedObject(tenant_id: string, id: string): Promise<void> {
  const current = await getRow(tenant_id, id);
  if (current.status !== "imported") throw new DocumentError("not_found", "document not found", 404);
  const { error } = await tenantStorage(asTenantId(tenant_id)).from(DOCUMENT_BUCKET).remove([current.storage_path]);
  if (error) throw new DocumentError("write_failed", `could not remove the file: ${error.message}`, 502);
}

export async function deleteImportedRow(tenant_id: string, id: string): Promise<void> {
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("tenant_document")
    .delete()
    .eq("id", id)
    .eq("status", "imported");
  if (error) throw new DocumentError("write_failed", error.message, 500);
}

const AGENT_LINK_TTL_SECONDS = 24 * 60 * 60;
const AGENT_LINK_REFRESH_BEFORE_MS = 2 * 60 * 60 * 1000;
const signedCache = new Map<string, { url: string; expires_at: number }>();

function cacheKey(id: string, version: number): string {
  return `${id}:${version}`;
}

export async function approvedDocumentLinks(
  tenant_id: string,
  now: number = Date.now(),
): Promise<Array<{ filename: string; url: string }>> {
  const approved = await rows(tenant_id, "approved");
  const out: Array<{ filename: string; url: string }> = [];
  for (const row of approved) {
    const key = cacheKey(row.id, row.version);
    const hit = signedCache.get(key);
    if (hit && hit.expires_at - now > AGENT_LINK_REFRESH_BEFORE_MS) {
      out.push({ filename: row.filename, url: hit.url });
      continue;
    }
    try {
      const url = await signPath(tenant_id, row.storage_path, AGENT_LINK_TTL_SECONDS);
      signedCache.set(key, { url, expires_at: now + AGENT_LINK_TTL_SECONDS * 1000 });
      out.push({ filename: row.filename, url });
    } catch {
    }
  }
  return out;
}
