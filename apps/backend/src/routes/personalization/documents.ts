
import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import { authMiddleware, requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { getBoolSettingStrictResolved } from "@/services/settings";
import {
  deleteDocument,
  DocumentError,
  getDocument,
  listDocuments,
  MAX_DOCUMENT_BYTES,
  replaceDocument,
  setDocumentStatus,
  signedDownloadUrl,
  uploadDocument,
} from "@/services/personalization/documents";
import { inngest } from "@/../workers/client";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES } });

export function documentUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      res.status(400).json({
        error: {
          code: tooBig ? "file_too_large" : "upload_rejected",
          message: tooBig ? `file exceeds ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB cap` : err.message,
        },
      });
      return;
    }
    if (err) {
      res.status(400).json({ error: { code: "upload_rejected", message: String(err) } });
      return;
    }
    next();
  });
}

function fail(res: Response, e: unknown): void {
  if (e instanceof DocumentError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  res.status(500).json({ error: { code: "internal", message: (e as Error).message } });
}

function idParam(req: Request, res: Response): string | null {
  const id = req.params.id;
  if (!ID_RE.test(id)) {
    res.status(400).json({ error: { code: "bad_id", message: "invalid document id" } });
    return null;
  }
  return id;
}

function fileOf(req: Request, res: Response): Express.Multer.File | null {
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: { code: "no_file", message: "file field is required" } });
    return null;
  }
  return file;
}

export async function listPersonalizationDocuments(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json({ documents: await listDocuments(auth.tenant_id, undefined, { excludeImported: true }) });
  } catch (e) {
    fail(res, e);
  }
}

export async function uploadPersonalizationDocument(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const file = fileOf(req, res);
  if (!file) return;
  const importing = req.query.purpose === "import";
  if (importing) {
    let enabled: boolean;
    try {
      enabled = await getBoolSettingStrictResolved("welcome_setup_enabled", auth.tenant_id);
    } catch {
      res.status(503).json({ error: { code: "settings_unavailable", message: "Couldn't check that just now. Try again in a moment." } });
      return;
    }
    if (!enabled) {
      res.status(409).json({ error: { code: "feature_disabled", message: "Adding past work is turned off." } });
      return;
    }
  }
  try {
    const document = await uploadDocument(auth.tenant_id, {
      buffer: file.buffer,
      filename: file.originalname,
      mime: file.mimetype || "application/octet-stream",
      actor_user_id: auth.user_id,
      status: importing ? "imported" : "approved",
    });
    if (importing) {
      try {
        await inngest.send({ name: "knowledge/import.read", data: { doc_id: document.id, tenant_id: auth.tenant_id } });
      } catch (e) {
        console.warn(`[documents] knowledge/import.read send failed for ${document.id}: ${(e as Error).message}`);
      }
    }
    res.status(201).json({ document });
  } catch (e) {
    fail(res, e);
  }
}

export async function replacePersonalizationDocument(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = idParam(req, res);
  if (!id) return;
  const file = fileOf(req, res);
  if (!file) return;
  try {
    const document = await replaceDocument(auth.tenant_id, id, {
      buffer: file.buffer,
      filename: file.originalname,
      mime: file.mimetype || "application/octet-stream",
      actor_user_id: auth.user_id,
    });
    res.json({ document });
  } catch (e) {
    fail(res, e);
  }
}

function statusSetter(status: "approved" | "archived") {
  return async (req: Request, res: Response): Promise<void> => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
    const id = idParam(req, res);
    if (!id) return;
    try {
      res.json({ document: await setDocumentStatus(auth.tenant_id, id, status) });
    } catch (e) {
      fail(res, e);
    }
  };
}

export const archivePersonalizationDocument = statusSetter("archived");
export const restorePersonalizationDocument = statusSetter("approved");

export async function deletePersonalizationDocument(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = idParam(req, res);
  if (!id) return;
  try {
    await deleteDocument(auth.tenant_id, id);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
}

export async function personalizationDocumentUrl(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = idParam(req, res);
  if (!id) return;
  try {
    const doc = await getDocument(auth.tenant_id, id);
    if (doc.status === "imported" && !(await requireTenantRole(auth, ["owner", "admin"], res))) return;
    res.json({ url: await signedDownloadUrl(auth.tenant_id, id), expires_in: 300 });
  } catch (e) {
    fail(res, e);
  }
}

export const personalizationUploadChain = [
  authMiddleware,
  documentUploadMiddleware,
  uploadPersonalizationDocument,
];
export const personalizationReplaceChain = [
  authMiddleware,
  documentUploadMiddleware,
  replacePersonalizationDocument,
];
