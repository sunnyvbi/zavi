
import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { loadTenantRole, requireTenantRole } from "@/services/auth/tenant-role";
import { BulkEmailError } from "@/services/comms/bulk-outbound/errors";
import {
  CSV_MAX_BYTES,
  DATABASE_IMPORT_MAX_ROWS,
  LIST_VERSION_MAX_CONTACTS,
} from "@/services/comms/bulk-outbound/config";
import { csvColumnValues, csvContactNames, previewCsv } from "@/services/comms/bulk-outbound/contacts-csv";
import { listImportTables, readDatabaseColumn } from "@/services/comms/bulk-outbound/database-import";
import { bulkSendProgress } from "@/services/comms/bulk-outbound/progress";
import {
  archiveList,
  archivedLists,
  archivedListsFor,
  eraseContact,
  importListVersion,
  isDatabaseList,
  listContactsPage,
  listPeople,
  listSummaries,
  listSummariesFor,
  previewImportCounts,
  recordListConsent,
  unarchiveList,
} from "@/services/comms/bulk-outbound/lists";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CSV_MAX_BYTES, files: 1, fields: 8, fieldSize: 1024 },
});

function csvUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: { code: "csv_too_large", message: "That file is larger than 2 MB. Split it into smaller files and upload each one." } });
      return;
    }
    if (err) {
      res.status(400).json({ error: { code: "bad_upload", message: "We could not read that upload. Try again." } });
      return;
    }
    next();
  });
}

const ADMIN_ROLES = ["owner", "admin"] as const;

function refuseOverride(auth: AuthedRequest, res: Response): boolean {
  if (auth.tenant_overridden !== true) return false;
  res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden workspace." } });
  return true;
}

async function writerAuth(req: Request, res: Response): Promise<AuthedRequest | null> {
  const auth = await requireAuth(req, res);
  if (!auth || refuseOverride(auth, res)) return null;
  return auth;
}

async function adminAuth(req: Request, res: Response): Promise<AuthedRequest | null> {
  const auth = await writerAuth(req, res);
  if (!auth) return null;
  try {
    return (await requireTenantRole(auth, ADMIN_ROLES, res)) ? auth : null;
  } catch {
    res.status(500).json({ error: { code: "role_check_failed", message: "Something went wrong. Try again." } });
    return null;
  }
}

async function authGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await writerAuth(req, res)) next();
}

function fail(res: Response, e: unknown): void {
  if (e instanceof BulkEmailError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  console.error(`[email-lists] unexpected ${(e as Error)?.name ?? "error"}`);
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong. Try again." } });
}

function csvFile(req: Request): Buffer {
  const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
  if (!file || !/\.csv$/i.test(file.originalname ?? "")) {
    throw new BulkEmailError("csv_required", "Upload a .csv file.");
  }
  return file.buffer;
}

function target(body: Record<string, unknown> | undefined): { listId: string | null; name: string | null } {
  const listId = typeof body?.list_id === "string" && body.list_id.trim() ? body.list_id.trim() : null;
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : null;
  if (listId && !UUID_RE.test(listId)) throw new BulkEmailError("list_not_found", "That contact list was not found.", 404);
  if (!listId && !name) throw new BulkEmailError("invalid_name", "Give the list a name.");
  return { listId, name: listId ? null : name };
}

function authed(req: Request): AuthedRequest {
  return req.auth as AuthedRequest;
}

function field(body: Record<string, unknown> | undefined, key: string): string | null {
  const v = body?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function previewCsvHandler(req: Request, res: Response): Promise<void> {
  try {
    const auth = authed(req);
    const buf = csvFile(req);
    const preview = previewCsv(buf);
    const body = req.body as Record<string, unknown> | undefined;
    const column = field(body, "column");
    if (!column) {
      res.json(preview);
      return;
    }
    const values = csvColumnValues(buf, column);
    csvContactNames(buf, field(body, "first_column"), field(body, "last_column"), field(body, "full_column"));
    const listId = field(body, "list_id");
    if (listId && !UUID_RE.test(listId)) throw new BulkEmailError("list_not_found", "That contact list was not found.", 404);
    const role = listId ? await loadTenantRole(auth).catch(() => null) : null;
    const counts = await previewImportCounts({
      tenantId: auth.tenant_id,
      userId: auth.user_id,
      listId,
      values,
      cap: LIST_VERSION_MAX_CONTACTS,
      canSeeDatabaseAddresses: role === "owner" || role === "admin",
    });
    res.json({ ...preview, column, counts });
  } catch (e) {
    fail(res, e);
  }
}

const WRITE_ROLES = new Set(["owner", "admin", "member"]);

async function importCsvHandler(req: Request, res: Response): Promise<void> {
  const auth = authed(req);
  let role: string | null;
  try {
    role = await loadTenantRole(auth);
  } catch {
    res.status(503).json({ error: { code: "role_check_failed", message: "Something went wrong. Try again." } });
    return;
  }
  if (!role || !WRITE_ROLES.has(role)) {
    res.status(403).json({ error: { code: "not_authorized", message: "Your role cannot import contacts." } });
    return;
  }
  try {
    const buf = csvFile(req);
    const body = req.body as Record<string, unknown> | undefined;
    const column =
      typeof body?.column === "string" && body.column.trim() ? body.column.trim() : previewCsv(buf).auto_column;
    if (!column) throw new BulkEmailError("csv_column_not_found", "Choose which column holds the email addresses.");
    const { listId, name } = target(body);
    const firstColumn = field(body, "first_column");
    const lastColumn = field(body, "last_column");
    const fullColumn = field(body, "full_column");
    const result = await importListVersion({
      tenantId: auth.tenant_id,
      userId: auth.user_id,
      listId,
      name,
      sourceKind: "csv",
      sourceRef: { column: column.slice(0, 120) },
      values: csvColumnValues(buf, column),
      ...(firstColumn || lastColumn || fullColumn ? { names: csvContactNames(buf, firstColumn, lastColumn, fullColumn) } : {}),
      cap: LIST_VERSION_MAX_CONTACTS,
      canSeeDatabaseAddresses: role === "owner" || role === "admin",
    });
    res.json({ ...result, column });
  } catch (e) {
    fail(res, e);
  }
}

export const previewCsvChain = [authGate, csvUpload, previewCsvHandler];
export const importCsvChain = [authGate, csvUpload, importCsvHandler];

export async function getImportTables(req: Request, res: Response): Promise<void> {
  const auth = await adminAuth(req, res);
  if (!auth) return;
  try {
    const tables = await listImportTables(auth.tenant_id, auth.user_id);
    res.json({ tables: tables.map((t) => ({ name: t.name, column_count: t.columns.length })) });
  } catch (e) {
    fail(res, e);
  }
}

export async function getImportTableColumns(req: Request, res: Response): Promise<void> {
  const auth = await adminAuth(req, res);
  if (!auth) return;
  try {
    const want = String(req.params.table ?? "").trim().toLowerCase();
    const table = (await listImportTables(auth.tenant_id, auth.user_id)).find((t) => t.name.toLowerCase() === want);
    if (!table) throw new BulkEmailError("database_table_not_found", "That table was not found in your connected database.", 404);
    res.json({ table: table.name, columns: table.columns });
  } catch (e) {
    fail(res, e);
  }
}

export async function postImportDatabase(req: Request, res: Response): Promise<void> {
  const auth = await adminAuth(req, res);
  if (!auth) return;
  try {
    const body = req.body as Record<string, unknown> | undefined;
    const table = typeof body?.table === "string" ? body.table : "";
    const column = typeof body?.column === "string" ? body.column : "";
    if (!table.trim() || !column.trim()) {
      throw new BulkEmailError("database_bad_name", "Choose a table and the column that holds the email addresses.");
    }
    const { listId, name } = target(body);
    const read = await readDatabaseColumn({ tenantId: auth.tenant_id, userId: auth.user_id, table, column });
    const result = await importListVersion({
      tenantId: auth.tenant_id,
      userId: auth.user_id,
      listId,
      name,
      sourceKind: "database",
      sourceRef: { db_type: read.db_type, table: read.table, column: read.column },
      values: read.values,
      cap: DATABASE_IMPORT_MAX_ROWS,
      canSeeDatabaseAddresses: true,
    });
    res.json({
      ...result,
      truncated_at: read.truncated ? DATABASE_IMPORT_MAX_ROWS : null,
      ...(read.truncated
        ? { notice: `Imported the first ${DATABASE_IMPORT_MAX_ROWS.toLocaleString("en-US")} rows. For a larger list, upload a CSV.` }
        : {}),
    });
  } catch (e) {
    fail(res, e);
  }
}

export const CONSENT_ADMIN_ONLY_MESSAGE = "Only a workspace owner or admin can confirm consent for a list.";

export async function postListConsent(req: Request, res: Response): Promise<void> {
  const auth = await writerAuth(req, res);
  if (!auth) return;
  let role: string | null;
  try {
    role = await loadTenantRole(auth);
  } catch {
    res.status(500).json({ error: { code: "role_check_failed", message: "Something went wrong. Try again." } });
    return;
  }
  if (role !== "owner" && role !== "admin") {
    res.status(403).json({ error: { code: "not_authorized", message: CONSENT_ADMIN_ONLY_MESSAGE } });
    return;
  }
  try {
    const { id, vid } = req.params;
    if (!UUID_RE.test(id ?? "") || !UUID_RE.test(vid ?? "")) {
      throw new BulkEmailError("version_not_found", "That import was not found.", 404);
    }
    if ((req.body as { confirmed?: unknown } | undefined)?.confirmed !== true) {
      throw new BulkEmailError("consent_required", "Tick the box to confirm these people agreed to hear from you.");
    }
    res.json(await recordListConsent({ tenantId: auth.tenant_id, userId: auth.user_id, listId: id, versionId: vid }));
  } catch (e) {
    fail(res, e);
  }
}

export async function getEmailLists(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const lists = await listSummaries(auth.tenant_id);
    const role = lists.some(isDatabaseList) ? await loadTenantRole(auth).catch(() => null) : null;
    res.json({ lists: listSummariesFor(lists, role === "owner" || role === "admin") });
  } catch (e) {
    fail(res, e);
  }
}

export async function getEmailListContacts(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    if (!UUID_RE.test(req.params.id ?? "")) throw new BulkEmailError("list_not_found", "That contact list was not found.", 404);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const page = await listContactsPage({ tenantId: auth.tenant_id, listId: req.params.id, limit, offset });
    if (page.source_kind === "database") {
      const role = await loadTenantRole(auth).catch(() => null);
      if (role !== "owner" && role !== "admin") {
        res.json({ total: null, contacts: [], version_id: page.version_id, source_kind: page.source_kind, masked: true, members_hidden: true });
        return;
      }
    }
    res.json({ ...page, masked: false, members_hidden: false });
  } catch (e) {
    fail(res, e);
  }
}

export async function getEmailContacts(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const rawList = typeof req.query.list_id === "string" ? req.query.list_id.trim() : "";
    if (rawList && !UUID_RE.test(rawList)) throw new BulkEmailError("list_not_found", "That contact list was not found.", 404);
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 200) : "";
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.min(1_000_000, Math.max(0, Number(req.query.offset) || 0));
    const page = await listPeople({
      tenantId: auth.tenant_id,
      userId: auth.user_id,
      search: search || null,
      listId: rawList || null,
      limit,
      offset,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(page);
  } catch (e) {
    fail(res, e);
  }
}

export async function deleteEmailList(req: Request, res: Response): Promise<void> {
  const auth = await adminAuth(req, res);
  if (!auth) return;
  try {
    if (!UUID_RE.test(req.params.id ?? "")) throw new BulkEmailError("list_not_found", "That contact list was not found.", 404);
    await archiveList(auth.tenant_id, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
}

export async function getArchivedEmailLists(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const lists = await archivedLists(auth.tenant_id);
    const role = lists.some((l) => l.from_database) ? await loadTenantRole(auth).catch(() => null) : null;
    res.json({ lists: archivedListsFor(lists, role === "owner" || role === "admin") });
  } catch (e) {
    fail(res, e);
  }
}

export async function postUnarchiveEmailList(req: Request, res: Response): Promise<void> {
  const auth = await adminAuth(req, res);
  if (!auth) return;
  try {
    if (!UUID_RE.test(req.params.id ?? "")) throw new BulkEmailError("list_not_found", "That contact list was not found.", 404);
    res.json({ ok: true, ...(await unarchiveList(auth.tenant_id, req.params.id, auth.user_id)) });
  } catch (e) {
    fail(res, e);
  }
}

export async function deleteEmailContact(req: Request, res: Response): Promise<void> {
  const auth = await adminAuth(req, res);
  if (!auth) return;
  try {
    if (!UUID_RE.test(req.params.id ?? "")) throw new BulkEmailError("contact_not_found", "That contact was not found.", 404);
    await eraseContact(auth.tenant_id, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
}

export async function getBulkSendProgress(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    if (!UUID_RE.test(req.params.decisionId ?? "")) throw new BulkEmailError("send_not_found", "That send was not found.", 404);
    res.json({ send: await bulkSendProgress(auth.tenant_id, req.params.decisionId) });
  } catch (e) {
    fail(res, e);
  }
}
