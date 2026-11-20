import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import { authMiddleware, requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantStorage } from "@/services/tenant-client";
import {
  WORKSPACE_FILE_MAX_BYTES,
  WORKSPACE_FILE_MAX_COUNT,
  WORKSPACE_UPLOAD_MAX_REQUEST_BYTES,
  WorkspaceFilesError,
  addFilesToCollection,
  createCollection,
  deleteCollection,
  deleteWorkspaceFile,
  isUuid,
  listWorkspaceFiles,
  readPublicWorkspaceFile,
  removeFileFromCollection,
  renameCollection,
  uploadWorkspaceFiles,
  workspaceFilesDeps,
  type IncomingFile,
} from "@/services/workspace-files/workspace-files";

export { WORKSPACE_FILE_MAX_BYTES, WORKSPACE_FILE_MAX_COUNT, WORKSPACE_UPLOAD_MAX_REQUEST_BYTES };

export const WORKSPACE_UPLOAD_MEMORY_BUDGET_BYTES = 400 * 1024 * 1024;

const WRITER_ROLES = ["owner", "admin"] as const;

function sendError(res: Response, e: unknown): void {
  if (e instanceof WorkspaceFilesError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong with your files." } });
}

async function requireWriter(req: Request, res: Response): Promise<AuthedRequest | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  try {
    return (await requireTenantRole(auth, WRITER_ROLES, res)) ? auth : null;
  } catch (e) {
    console.error(`[workspace-files] role lookup failed: ${(e as Error).message}`);
    res.status(500).json({ error: { code: "role_check_failed", message: "Something went wrong with your files." } });
    return null;
  }
}

export async function workspaceFilesWriterGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await requireWriter(req, res)) next();
}

function decodeName(raw: string): string {
  const decoded = Buffer.from(raw ?? "", "latin1").toString("utf8");
  return decoded.includes("�") ? raw : decoded;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: WORKSPACE_FILE_MAX_BYTES,
    files: WORKSPACE_FILE_MAX_COUNT,
    fields: 5,
    fieldSize: 1024,
    parts: WORKSPACE_FILE_MAX_COUNT + 5,
  },
});

export function workspaceFilesBodyCap(req: Request, res: Response, next: NextFunction): void {
  const length = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(length) && length > WORKSPACE_UPLOAD_MAX_REQUEST_BYTES) {
    res.status(413).json({ error: { code: "request_too_large", message: "That upload is too large. Send fewer photos at once." } });
    return;
  }
  next();
}

const uploadsInFlight = new Set<string>();

export function workspaceFilesUploadGate(req: Request, res: Response, next: NextFunction): void {
  const tenant = (req as Request & { auth?: { tenant_id?: string } }).auth?.tenant_id;
  if (!tenant) {
    next();
    return;
  }
  if (uploadsInFlight.has(tenant)) {
    res.status(429).json({
      error: { code: "upload_in_progress", message: "Another upload is still running. Try again when it finishes." },
    });
    return;
  }
  uploadsInFlight.add(tenant);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    uploadsInFlight.delete(tenant);
  };
  res.on("finish", release);
  res.on("close", release);
  next();
}

let uploadBytesInFlight = 0;

export function workspaceUploadBytesInFlight(): number {
  return uploadBytesInFlight;
}

export function workspaceFilesMemoryBudget(req: Request, res: Response, next: NextFunction): void {
  const declared = Number(req.headers["content-length"]);
  const reserve =
    Number.isFinite(declared) && declared > 0
      ? Math.min(declared, WORKSPACE_UPLOAD_MAX_REQUEST_BYTES)
      : WORKSPACE_UPLOAD_MAX_REQUEST_BYTES;
  if (uploadBytesInFlight + reserve > WORKSPACE_UPLOAD_MEMORY_BUDGET_BYTES) {
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: { code: "upload_capacity_busy", message: "Uploads are busy right now. Try again in a few seconds." },
    });
    return;
  }
  uploadBytesInFlight += reserve;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    uploadBytesInFlight -= reserve;
  };
  res.on("finish", release);
  res.on("close", release);
  next();
}

export function workspaceFilesUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  upload.array("files", WORKSPACE_FILE_MAX_COUNT)(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: { code: "file_too_large", message: "Each photo must be 10MB or smaller." } });
        return;
      }
      if (err.code === "LIMIT_FILE_COUNT" || (err.code === "LIMIT_UNEXPECTED_FILE" && err.field === "files")) {
        res.status(400).json({
          error: { code: "too_many_files", message: `Upload at most ${WORKSPACE_FILE_MAX_COUNT} photos at a time.` },
        });
        return;
      }
      res.status(400).json({ error: { code: "upload_rejected", message: err.message } });
      return;
    }
    if (err) {
      res.status(400).json({ error: { code: "upload_rejected", message: "The upload could not be read." } });
      return;
    }
    next();
  });
}

export async function getWorkspaceFiles(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json(await listWorkspaceFiles(workspaceFilesDeps(auth.tenant_id)));
  } catch (e) {
    sendError(res, e);
  }
}

export async function postWorkspaceFiles(req: Request, res: Response): Promise<void> {
  const auth = await requireWriter(req, res);
  if (!auth) return;
  const raw = ((req as Request & { files?: unknown }).files ?? []) as Express.Multer.File[];
  const files: IncomingFile[] = (Array.isArray(raw) ? raw : []).map((f) => ({
    originalname: decodeName(f.originalname),
    mimetype: f.mimetype,
    size: f.size,
    buffer: f.buffer,
  }));
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const rows = await uploadWorkspaceFiles(workspaceFilesDeps(auth.tenant_id), {
      files,
      collectionId: body.collection_id,
      uploadedBy: auth.user_id,
    });
    res.status(201).json({ files: rows });
  } catch (e) {
    sendError(res, e);
  }
}

export async function deleteWorkspaceFileRoute(req: Request, res: Response): Promise<void> {
  const auth = await requireWriter(req, res);
  if (!auth) return;
  try {
    await deleteWorkspaceFile(workspaceFilesDeps(auth.tenant_id), req.params.id);
    res.status(204).end();
  } catch (e) {
    sendError(res, e);
  }
}

export async function postWorkspaceFileCollection(req: Request, res: Response): Promise<void> {
  const auth = await requireWriter(req, res);
  if (!auth) return;
  try {
    const collection = await createCollection(workspaceFilesDeps(auth.tenant_id), req.body?.name);
    res.status(201).json({ collection });
  } catch (e) {
    sendError(res, e);
  }
}

export async function patchWorkspaceFileCollection(req: Request, res: Response): Promise<void> {
  const auth = await requireWriter(req, res);
  if (!auth) return;
  try {
    const collection = await renameCollection(workspaceFilesDeps(auth.tenant_id), req.params.id, req.body?.name);
    res.json({ collection });
  } catch (e) {
    sendError(res, e);
  }
}

export async function deleteWorkspaceFileCollection(req: Request, res: Response): Promise<void> {
  const auth = await requireWriter(req, res);
  if (!auth) return;
  try {
    await deleteCollection(workspaceFilesDeps(auth.tenant_id), req.params.id);
    res.status(204).end();
  } catch (e) {
    sendError(res, e);
  }
}

export async function postWorkspaceFileCollectionFiles(req: Request, res: Response): Promise<void> {
  const auth = await requireWriter(req, res);
  if (!auth) return;
  try {
    await addFilesToCollection(workspaceFilesDeps(auth.tenant_id), req.params.id, req.body?.file_ids);
    res.status(204).end();
  } catch (e) {
    sendError(res, e);
  }
}

export async function deleteWorkspaceFileCollectionFile(req: Request, res: Response): Promise<void> {
  const auth = await requireWriter(req, res);
  if (!auth) return;
  try {
    await removeFileFromCollection(workspaceFilesDeps(auth.tenant_id), req.params.id, req.params.fileId);
    res.status(204).end();
  } catch (e) {
    sendError(res, e);
  }
}

const PUBLIC_NOT_FOUND = { error: { code: "file_not_found", message: "No file at that address." } };

export async function getPublicWorkspaceFile(req: Request, res: Response): Promise<void> {
  const { tenantId, fileId, name } = req.params;
  if (!isUuid(tenantId) || !isUuid(fileId)) {
    res.status(404).json(PUBLIC_NOT_FOUND);
    return;
  }
  try {
    const found = await readPublicWorkspaceFile(tenantStorage(asTenantId(tenantId.toLowerCase())), tenantId, fileId, name);
    if (!found) {
      res.status(404).json(PUBLIC_NOT_FOUND);
      return;
    }
    res.setHeader("Content-Type", found.mime);
    res.setHeader("Content-Length", String(found.body.length));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.status(200).end(found.body);
  } catch (e) {
    sendError(res, e);
  }
}

export const workspaceFilesUploadChain = [
  authMiddleware,
  workspaceFilesWriterGate,
  workspaceFilesBodyCap,
  workspaceFilesUploadGate,
  workspaceFilesMemoryBudget,
  workspaceFilesUploadMiddleware,
  postWorkspaceFiles,
];
