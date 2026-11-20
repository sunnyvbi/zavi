import { inngest } from "@/../workers/client";
import { asTenantId, creatorTimerClient, tenantClient, tenantStorage } from "@/services/tenant-client";
import {
  createSandbox,
  destroySandbox,
  execCommand,
  readFileBytes,
  type ExecResult,
} from "@/services/sandbox/e2b-client";
import { ACCEPTED_REASONS } from "./library";

export const DELIVERABLES_BUCKET = "creator-deliverables";
export const PREVIEW_STALE_MS = 20 * 60 * 1000;
export const MAX_PREVIEW_ATTEMPTS = 3;
export const PREVIEW_WATERMARK_TEXT = "ZAVI PREVIEW";
export const PREVIEW_FOOTER_TEXT = "Unpaid preview - the original unlocks once the job is paid";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const WORK = "/home/user/preview";
const SOURCE_URL_TTL_SECONDS = 30 * 60;

export type PreviewMedia = "video" | "image";
export type PreviewState = "pending" | "ready" | "failed";

export type PreviewSubmissionRow = {
  id: string;
  tenant_id: string;
  order_id: string;
  version: number;
  storage_path: string;
  mime_type: string | null;
  preview_path: string | null;
  preview_state: PreviewState | null;
  preview_updated_at: string | null;
  preview_attempts?: number | null;
};

const VIDEO_EXT = new Set(["mp4", "mov", "webm"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp"]);

export function previewMedia(mime_type: string | null, storage_path: string): PreviewMedia | null {
  const mime = (mime_type ?? "").toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  const ext = storage_path.split(".").pop()?.toLowerCase() ?? "";
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

export function isPaidOrder(order: { status: string; closed_reason: string | null }): boolean {
  return order.status === "completed" && order.closed_reason !== null && ACCEPTED_REASONS.has(order.closed_reason);
}

export function previewPathFor(
  row: Pick<PreviewSubmissionRow, "tenant_id" | "order_id" | "id">,
  media: PreviewMedia,
): string {
  return `${row.tenant_id}/${row.order_id}/preview/${row.id}.${media === "video" ? "mp4" : "jpg"}`;
}

function pendingIsStale(row: Partial<Pick<PreviewSubmissionRow, "preview_updated_at">>, now: Date): boolean {
  const at = row.preview_updated_at ? Date.parse(row.preview_updated_at) : NaN;
  return !Number.isFinite(at) || now.getTime() - at > PREVIEW_STALE_MS;
}

export function previewGaveUp(
  row: Pick<PreviewSubmissionRow, "preview_state" | "preview_attempts"> & Partial<Pick<PreviewSubmissionRow, "preview_updated_at">>,
  now?: Date,
): boolean {
  if (row.preview_state === "ready" || (row.preview_attempts ?? 0) < MAX_PREVIEW_ATTEMPTS) return false;
  if (row.preview_state === "pending") return now !== undefined && pendingIsStale(row, now);
  return true;
}

export function previewNeedsWork(
  row: Pick<PreviewSubmissionRow, "preview_state" | "preview_updated_at" | "preview_attempts">,
  now: Date,
): boolean {
  if (row.preview_state === "ready" || (row.preview_attempts ?? 0) >= MAX_PREVIEW_ATTEMPTS) return false;
  if (row.preview_state !== "pending") return true;
  return pendingIsStale(row, now);
}

function escapeDrawText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%");
}

export function buildWatermarkFilter(media: PreviewMedia): string {
  const maxWidth = media === "video" ? 1920 : 2048;
  return [
    media === "video" ? `scale='trunc(min(${maxWidth},iw)/2)*2':-2` : `scale='min(${maxWidth},iw)':-2`,
    `drawtext=fontfile=${FONT}:text='${escapeDrawText(PREVIEW_WATERMARK_TEXT)}':fontcolor=white@0.4:fontsize='min(w,h)/8':borderw=3:bordercolor=black@0.3:x=(w-text_w)/2:y=(h-text_h)/2`,
    `drawtext=fontfile=${FONT}:text='${escapeDrawText(PREVIEW_WATERMARK_TEXT)}':fontcolor=white@0.3:fontsize='min(w,h)/14':x=(w-text_w)/2:y=h/8`,
    `drawtext=fontfile=${FONT}:text='${escapeDrawText(PREVIEW_FOOTER_TEXT)}':fontcolor=white@0.9:fontsize='min(w,h)/36':box=1:boxcolor=black@0.5:boxborderw=8:x=(w-text_w)/2:y=h-text_h-h/16`,
  ].join(",");
}

export function buildFfmpegCommand(media: PreviewMedia): string {
  const vf = buildWatermarkFilter(media);
  if (media === "image") {
    return `ffmpeg -y -loglevel error -protocol_whitelist file -i ${WORK}/in -vf "${vf}" -frames:v 1 -q:v 3 ${WORK}/out.jpg`;
  }
  return (
    `ffmpeg -y -loglevel error -protocol_whitelist file -i ${WORK}/in -vf "${vf}" -map 0:v:0 -map '0:a:0?' ` +
    `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart ${WORK}/out.mp4`
  );
}

export class SubmissionPreviewError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "SubmissionPreviewError";
  }
}

export type PreviewSandbox = {
  open: (tenant_id: string) => Promise<string>;
  exec: (sandbox_id: string, command: string, timeoutMs: number, env?: Record<string, string>) => Promise<ExecResult>;
  readBytes: (sandbox_id: string, path: string) => Promise<Uint8Array | null>;
  close: (sandbox_id: string) => Promise<void>;
};

export const realPreviewSandbox: PreviewSandbox = {
  open: (tenant_id) => createSandbox({ tenant_id, repo_full_name: "zavi/creator-preview" }),
  exec: (sandbox_id, command, timeoutMs, env) => execCommand(sandbox_id, command, timeoutMs, env ? { env } : {}),
  readBytes: async (sandbox_id, path) => (await readFileBytes(sandbox_id, path)) ?? null,
  close: (sandbox_id) => destroySandbox(sandbox_id),
};

export type PreviewStore = {
  loadOrder: (order_id: string) => Promise<{ id: string; tenant_id: string; status: string; closed_reason: string | null } | null>;
  hasOpenDispute: (tenant_id: string, order_id: string) => Promise<boolean>;
  listVersion: (tenant_id: string, order_id: string, version: number) => Promise<PreviewSubmissionRow[]>;
  mark: (
    row: PreviewSubmissionRow,
    patch: { preview_state: PreviewState; preview_path: string | null; preview_error: string | null; preview_attempts?: number },
  ) => Promise<void>;
  signSource: (tenant_id: string, storage_path: string) => Promise<string>;
  upload: (tenant_id: string, path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
};

export const realPreviewStore: PreviewStore = {
  loadOrder: async (order_id) => {
    const { data, error } = await creatorTimerClient("watermark preview worker resolves an order's tenant by order id")
      .from("creator_orders")
      .select("id, tenant_id, status, closed_reason")
      .eq("id", order_id)
      .maybeSingle();
    if (error) throw new Error(`preview order read failed: ${error.message}`);
    return (data as { id: string; tenant_id: string; status: string; closed_reason: string | null } | null) ?? null;
  },
  hasOpenDispute: async (tenant_id, order_id) => {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("creator_disputes")
      .select("id")
      .eq("order_id", order_id)
      .eq("status", "open")
      .limit(1);
    if (error) throw new Error(`preview dispute read failed: ${error.message}`);
    return (data ?? []).length > 0;
  },
  listVersion: async (tenant_id, order_id, version) => {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("creator_submissions")
      .select("id, tenant_id, order_id, version, storage_path, mime_type, preview_path, preview_state, preview_updated_at, preview_attempts")
      .eq("tenant_id", tenant_id)
      .eq("order_id", order_id)
      .eq("version", version)
      .order("position", { ascending: true });
    if (error) throw new Error(`preview submission read failed: ${error.message}`);
    return (data ?? []) as PreviewSubmissionRow[];
  },
  mark: async (row, patch) => {
    const { error } = await tenantClient(asTenantId(row.tenant_id))
      .from("creator_submissions")
      .update({ ...patch, preview_updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("tenant_id", row.tenant_id)
      .eq("order_id", row.order_id);
    if (error) throw new Error(`preview state write failed: ${error.message}`);
  },
  signSource: async (tenant_id, storage_path) => {
    const { data, error } = await tenantStorage(asTenantId(tenant_id))
      .from(DELIVERABLES_BUCKET)
      .createSignedUrl(storage_path, SOURCE_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) throw new Error(`preview source sign failed: ${error?.message ?? "no url"}`);
    return data.signedUrl;
  },
  upload: async (tenant_id, path, bytes, contentType) => {
    const { error } = await tenantStorage(asTenantId(tenant_id))
      .from(DELIVERABLES_BUCKET)
      .upload(path, bytes, { contentType, upsert: true });
    if (error) throw new Error(`preview upload failed: ${error.message}`);
  },
};

function tail(s: string, n = 400): string {
  return s.length > n ? s.slice(-n) : s;
}

async function ensureFfmpeg(sandbox: PreviewSandbox, id: string): Promise<void> {
  await sandbox.exec(
    id,
    `command -v ffmpeg >/dev/null 2>&1 || (sudo apt-get update -y && sudo apt-get install -y ffmpeg); ` +
      `test -f ${FONT} || (sudo apt-get update -y && sudo apt-get install -y fonts-dejavu-core) || true`,
    300_000,
  );
  const check = await sandbox.exec(id, `command -v ffmpeg >/dev/null 2>&1 && test -f ${FONT} && echo OK || echo MISSING`, 30_000);
  if (!/\bOK\b/.test(check.stdout)) {
    throw new SubmissionPreviewError("watermark_deps_missing", "ffmpeg or the watermark font is missing in the sandbox");
  }
}

async function watermarkOne(
  sandbox: PreviewSandbox,
  id: string,
  sourceUrl: string,
  media: PreviewMedia,
): Promise<Uint8Array> {
  const fetched = await sandbox.exec(
    id,
    `mkdir -p ${WORK} && rm -f ${WORK}/in ${WORK}/out.* && curl -fsSL --max-time 600 "$SOURCE_URL" -o ${WORK}/in`,
    660_000,
    { SOURCE_URL: sourceUrl },
  );
  if (fetched.exit_code !== 0) throw new SubmissionPreviewError("source_fetch_failed", tail(fetched.stderr || fetched.stdout));
  const rendered = await sandbox.exec(id, buildFfmpegCommand(media), 1_200_000);
  if (rendered.exit_code !== 0) throw new SubmissionPreviewError("watermark_failed", tail(rendered.stderr || rendered.stdout));
  const bytes = await sandbox.readBytes(id, `${WORK}/out.${media === "video" ? "mp4" : "jpg"}`);
  if (!bytes || bytes.byteLength === 0) throw new SubmissionPreviewError("watermark_empty", "the watermark produced no bytes");
  return bytes;
}

export type BuildPreviewsResult = {
  skipped?: "order_not_found" | "order_paid" | "nothing_to_do";
  ready: string[];
  failed: Array<{ id: string; code: string }>;
};

export async function buildSubmissionPreviews(
  args: { order_id: string; version: number; now?: Date },
  store: PreviewStore = realPreviewStore,
  sandbox: PreviewSandbox = realPreviewSandbox,
): Promise<BuildPreviewsResult> {
  const order = await store.loadOrder(args.order_id);
  if (!order) return { skipped: "order_not_found", ready: [], failed: [] };
  if (isPaidOrder(order) && !(await store.hasOpenDispute(order.tenant_id, order.id))) {
    return { skipped: "order_paid", ready: [], failed: [] };
  }

  const now = args.now ?? new Date();
  const rows = (await store.listVersion(order.tenant_id, order.id, args.version)).filter(
    (r) => previewMedia(r.mime_type, r.storage_path) !== null && previewNeedsWork(r, now),
  );
  if (rows.length === 0) return { skipped: "nothing_to_do", ready: [], failed: [] };

  const result: BuildPreviewsResult = { ready: [], failed: [] };
  let id: string | null = null;
  try {
    id = await sandbox.open(order.tenant_id);
    await ensureFfmpeg(sandbox, id);
    for (const row of rows) {
      const media = previewMedia(row.mime_type, row.storage_path) as PreviewMedia;
      await store.mark(row, { preview_state: "pending", preview_path: null, preview_error: null, preview_attempts: (row.preview_attempts ?? 0) + 1 });
      try {
        const bytes = await watermarkOne(sandbox, id, await store.signSource(row.tenant_id, row.storage_path), media);
        const path = previewPathFor(row, media);
        await store.upload(row.tenant_id, path, bytes, media === "video" ? "video/mp4" : "image/jpeg");
        await store.mark(row, { preview_state: "ready", preview_path: path, preview_error: null });
        result.ready.push(row.id);
      } catch (e) {
        const code = e instanceof SubmissionPreviewError ? e.code : "preview_failed";
        await store.mark(row, { preview_state: "failed", preview_path: null, preview_error: `${code}: ${tail((e as Error).message, 500)}` });
        result.failed.push({ id: row.id, code });
      }
    }
  } catch (e) {
    const code = e instanceof SubmissionPreviewError ? e.code : "sandbox_failed";
    for (const row of rows) {
      if (result.ready.includes(row.id) || result.failed.some((f) => f.id === row.id)) continue;
      await store.mark(row, {
        preview_state: "failed",
        preview_path: null,
        preview_error: `${code}: ${tail((e as Error).message, 500)}`,
        preview_attempts: (row.preview_attempts ?? 0) + 1,
      });
      result.failed.push({ id: row.id, code });
    }
  } finally {
    if (id) await sandbox.close(id).catch(() => {});
  }
  return result;
}

export type PreviewRequester = (args: { tenant_id: string; order_id: string; version: number }) => Promise<void>;

export const requestSubmissionPreviews: PreviewRequester = async ({ tenant_id, order_id, version }) => {
  await inngest.send({
    id: `creator-preview-${order_id}-v${version}-${Math.floor(Date.now() / PREVIEW_STALE_MS)}`,
    name: "creator/submission.preview.requested",
    data: { order_id, version, tenant_id },
  });
};
