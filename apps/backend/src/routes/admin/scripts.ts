
import type { NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";
import { assertStaff } from "@/services/auth/staff-middleware";
import { writeStaffAuditStrict } from "@/services/staff/audit";
import {
  getScript,
  listScripts,
  ScriptInputError,
  SCRIPTS,
  type ScriptContext,
  type UploadedFile,
} from "@/services/admin-scripts/registry";
import { AlreadyRunningError, finishRun, getRun, heartbeat, listRecent, reapStale, startRun } from "@/services/admin-scripts/runs";

export const SCRIPT_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorJson(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: { code, message, ...extra } });
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: SCRIPT_UPLOAD_MAX_BYTES, files: 1 } });

export function scriptUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.is("multipart/form-data")) return next();
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") return errorJson(res, 413, "file_too_large", "The CSV must be 2 MB or smaller.");
      return errorJson(res, 400, "upload_rejected", err.message);
    }
    if (err) return errorJson(res, 400, "upload_rejected", String(err));
    next();
  });
}

function uploadedFile(req: Request): UploadedFile | undefined {
  const f = (req as Request & { file?: Express.Multer.File }).file;
  if (!f) return undefined;
  if (!/\.csv$/i.test(f.originalname)) throw new ScriptInputError("not_csv", "The file must be a .csv export of the sheet.");
  return { name: f.originalname.slice(0, 200), bytes: f.size, text: f.buffer.toString("utf8") };
}

function readBody(req: Request): { mode: unknown; args: Record<string, unknown>; confirm: string | undefined; previewToken: string | undefined } {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (req.is("multipart/form-data")) {
    const { mode, confirm, preview_token, ...args } = body;
    return { mode, args, confirm: str(confirm), previewToken: str(preview_token) };
  }
  const args = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
  return { mode: body.mode, args, confirm: str(body.confirm), previewToken: str(body.preview_token) };
}

export async function adminScriptsList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  await reapStale();
  const runs = Object.fromEntries(await Promise.all(SCRIPTS.map(async (s) => [s.key, await listRecent(s.key, 10)] as const)));
  res.json({ scripts: listScripts(), runs });
}

export async function adminScriptRunGet(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) return errorJson(res, 400, "bad_run_id", "Run id must be a uuid.");
  const run = await getRun(id);
  if (!run) return errorJson(res, 404, "run_not_found", "No such run.");
  res.json({ run });
}

export async function adminScriptRunPost(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const script = getScript(String(req.params.key ?? ""));
  if (!script) return errorJson(res, 404, "unknown_script", "No such script.");

  const { mode, args: rawArgs, confirm, previewToken } = readBody(req);
  if (mode !== "dry_run" && mode !== "apply") return errorJson(res, 400, "bad_mode", "mode must be dry_run or apply.");
  if (mode === "apply" && !script.applies) return errorJson(res, 400, "read_only", "This script has no Apply.");

  const parsed = script.schema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorJson(res, 400, "invalid_args", parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; "));
  }
  const args = parsed.data;

  try {
    const ctx: ScriptContext = { staff: { user_id: staff.user_id, email: staff.email }, env: process.env, file: uploadedFile(req) };

    if (mode === "dry_run") {
      const result = await script.dryRun(args, ctx);
      if (script.key === "creator-list" && (args as { show_emails?: boolean }).show_emails) {
        await writeStaffAuditStrict({
          actor_user_id: staff.user_id,
          actor_email: staff.email,
          action: "admin_script.creator-list.show_emails",
          target_table: "creator_invites",
          meta: { batch: (args as { batch: string }).batch, row_count: (result as { total?: number }).total ?? null },
        });
      }
      res.json({ mode, result });
      return;
    }

    const prepared = await script.prepareApply!(args, ctx, confirm, previewToken);
    const stored = script.storedArgs(args, ctx);
    const run = await startRun({ scriptKey: script.key, args: stored, lockKey: script.lockKey(args), runBy: staff.user_id, runByEmail: staff.email });
    try {
      await writeStaffAuditStrict({
        actor_user_id: staff.user_id,
        actor_email: staff.email,
        action: `admin_script.${script.key}.apply`,
        target_table: "admin_script_runs",
        target_id: run.id,
        meta: { args: stored },
      });
    } catch (e) {
      await finishRun(run.id, { status: "failed", error: `not started: ${(e as Error).message}` });
      throw e;
    }

    let lastProgress: Record<string, unknown> = {};
    const progress = async (p: Record<string, unknown>) => {
      lastProgress = p;
      await heartbeat(run.id, p).catch((e) => console.warn(`[admin-scripts] heartbeat ${run.id} failed: ${(e as Error).message}`));
    };

    const execute = async () => {
      const timer = setInterval(() => void progress(lastProgress), HEARTBEAT_MS);
      try {
        const out = await prepared.execute(progress);
        clearInterval(timer);
        await finishRun(run.id, { status: "done", summary: out.summary, progress: lastProgress });
        return out;
      } catch (e) {
        clearInterval(timer);
        await finishRun(run.id, { status: "failed", progress: lastProgress, error: (e as Error).message });
        throw e;
      }
    };

    if (script.longRunning) {
      execute().catch((e) => console.error(`[admin-scripts] run ${run.id} (${script.key}) failed: ${(e as Error).message}`));
      res.status(202).json({ mode, run_id: run.id, async: true });
      return;
    }
    const out = await execute();
    res.json({ mode, run_id: run.id, result: out.result });
  } catch (e) {
    if (e instanceof ScriptInputError) return errorJson(res, e.status, e.code, e.message, e.extra);
    if (e instanceof AlreadyRunningError) return errorJson(res, 409, "already_running", e.message, { run_id: e.runId });
    return errorJson(res, 500, "script_failed", (e as Error).message);
  }
}
