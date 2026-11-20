
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { asTenantId, tenantClient, tenantStorage, type TenantId } from "@/services/tenant-client";
import { uploadFileToThread } from "@/services/tools/slack/upload_file";
import { logEvent } from "@/services/logging/logEvent";
import { trackMediaGenerated } from "@/services/analytics/action-events";
import { ExpectedToolError } from "@/services/tools/types";
import { assertRunTenantOwnership } from "./guard";
import { artifactRunBinding } from "./run-binding";
import { ARTIFACT_BUCKET } from "./constants";
import { safeFilename } from "./image-filename";
import { uploadWorkspaceFiles, workspaceFilesDeps } from "@/services/workspace-files/workspace-files";
import { normalizeDeclaredMime } from "@/services/workspace-files/sniff";
const CHAT_IMAGE_BUCKET = "agent-chat-images";
import { routeImage, isTaskConfigured, cacheModelTag, estimateCost, isMediaRouterEnabled } from "@/services/media-router/router";
import { chargeMedia, canAffordMedia, mediaChargeRecorded } from "@/services/media-router/charge";
import { isPreviewRunId } from "@/services/channels/preview-run-starts";
import { sanitizeSvg } from "@/services/media-router/svg";
import type { MediaTask } from "@/services/media-router/types";
import { meterPlatformGeneration } from "@/services/mcp/higgsfield-meter";

const ASPECTS = ["1:1", "4:5", "9:16", "16:9"] as const;
export type GenerateImageAspect = (typeof ASPECTS)[number];

const MAX_IMAGES = 5;

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_NAME_TRIES = 20;
const RANDOM_NAME_TRIES = 3;

function isAlreadyExists(e: unknown): boolean {
  const o = (e ?? {}) as { message?: unknown; statusCode?: unknown; status?: unknown; error?: unknown };
  const text = `${String(o.message ?? "")} ${String(o.error ?? "")}`.toLowerCase();
  return String(o.statusCode ?? o.status ?? "") === "409" || /already exists|duplicate/.test(text);
}
const FETCH_TIMEOUT_MS = 20_000;
const GEN_DEADLINE_MS = 150_000;
const ACCEPTED_MIMES = new Set(["image/png", "image/jpeg", "image/jpg"]);
const SVG_MIME = "image/svg+xml";

const OWN_FILE_RE = /^(agent-chat-images|agent-artifacts)\/([0-9a-f-]{36})\/[^\s]+$/i;
export function isAllowedReference(v: string): boolean {
  return /^https:\/\//i.test(v) || OWN_FILE_RE.test(v);
}
const REF_PATH_RE = /^(agent-chat-images|agent-artifacts)\/([^/]+)\/(.+)$/i;

export const generateImageInputSchema = z
  .object({
    prompts: z
      .array(
        z.object({
          prompt: z
            .string()
            .trim()
            .min(1, "prompt must be non-empty")
            .max(1000, "prompt must be ≤1000 chars"),
          filename: z
            .string()
            .trim()
            .max(80)
            .optional()
            .describe("output filename for this image; .png forced if missing"),
        }),
      )
      .min(1, "at least one prompt")
      .max(MAX_IMAGES, `at most ${MAX_IMAGES} images per call`),
    aspect_ratio: z.enum(ASPECTS).default("1:1"),
    mode: z.enum(["photo", "text", "edit", "vector", "draft"]).default("photo"),
    reference_url: z.string().trim().max(2000).optional(),
    channel_id: z.string().optional(),
    thread_ts: z.string().optional(),
  })
  .strict()
  .refine((v) => !v.reference_url || isAllowedReference(v.reference_url), {
    message:
      "reference_url must be a public https URL or your own file path (agent-chat-images/<tenant>/... or agent-artifacts/<tenant>/...)",
    path: ["reference_url"],
  })
  .refine((v) => v.mode !== "edit" || !!v.reference_url, {
    message: "mode 'edit' needs reference_url",
    path: ["reference_url"],
  });

export type GenerateImageInput = z.infer<typeof generateImageInputSchema>;

export type DeliverImageInput = Omit<GenerateImageInput, "prompts"> & {
  prompts: Array<{ prompt: string | null; filename?: string }>;
};

export type GeneratedImage = {
  artifact_id: string;
  slot: number;
  filename: string;
  bytes: number;
  cached: boolean;
  image_path?: string;
};
export type SkippedImage = {
  index: number;
  reason:
    | "not_configured"
    | "over_daily_cap"
    | "meter_error"
    | "generation_failed"
    | "vendor_out_of_credits"
    | "refused"
    | "insufficient_credits"
    | "download_failed"
    | "unsupported_type"
    | "store_failed"
    | "transform_failed"
    | "charge_failed"
    | "preview_render_used"
    | "deadline";
  detail?: string;
};

export type DeliverImageResult = {
  images: GeneratedImage[];
  generated: number;
  cached: number;
  typeset: number;
  skipped: SkippedImage[];
  slack_ok: boolean;
};

export type DeliverImageCtx = {
  tenant_id: string;
  run_id: string;
  slack_team_id?: string | null;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  transform?: (plate: Buffer | null, index: number) => Promise<{ bytes: Buffer; mime?: string } | null>;
  stageable?: boolean;
  task?: MediaTask;
  renderTag?: string;
  renderKey?: string;
};

async function saveDeliveredImageToFiles(
  tid: TenantId,
  artifactId: string,
  filename: string,
  mime: string,
  bytes: Buffer,
  log?: DeliverImageCtx["log"],
): Promise<void> {
  if (!normalizeDeclaredMime(mime)) return;
  try {
    await uploadWorkspaceFiles(workspaceFilesDeps(tid), {
      files: [{ originalname: filename, mimetype: mime, size: bytes.byteLength, buffer: bytes }],
      origin: `run_artifact:${artifactId}`,
    });
  } catch (e) {
    log?.(`deliver-image: Files copy skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function cacheKey(
  tenantId: string,
  aspect: string,
  prompt: string,
  model: string,
  ext: "png" | "svg" = "png",
): string {
  const h = createHash("sha256")
    .update(`${tenantId}|${model}|${aspect}|${prompt}`)
    .digest("hex")
    .slice(0, 32);
  return `image-cache/${tenantId}/${h}.${ext}`;
}

export function slotHash(
  prompt: string,
  aspect: string,
  mode: string,
  reference: string | undefined,
): string {
  return createHash("sha256")
    .update(`${prompt}|${aspect}|${mode}|${reference ?? ""}`)
    .digest("hex")
    .slice(0, 10);
}

async function fetchImage(
  url: string,
  log?: DeliverImageCtx["log"],
  task?: MediaTask,
): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const svgOk = mime === SVG_MIME && task === "image.vector";
    if (!ACCEPTED_MIMES.has(mime) && !svgOk) {
      log?.(`generate_image: dropped unsupported content-type ${mime || "(missing)"}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
    return { bytes: buf, mime: mime === "image/jpg" ? "image/jpeg" : mime };
  } catch (e) {
    log?.(`generate_image: fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const VENDOR_PLAN_REQUIRED = /requires \w+ plan or higher/i;

export function isVendorOutOfCredits(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  if (e.includes("not_enough_credits") || e.includes("insufficient_credits")) return true;
  if (VENDOR_PLAN_REQUIRED.test(e)) return true;
  return e.startsWith("submit 403") && e.includes("credit");
}

export function pendingPlatePath(tenantId: string, runId: string, slotKey: string, ext: "png" | "svg"): string {
  return `image-cache-pending/${tenantId}/${runId}/${slotKey.replace(/[^A-Za-z0-9-]/g, "-")}.${ext}`;
}

const PENDING_META_MIME = "application/vnd.zavi.ui+json";

export async function deliverImage(
  ctx: DeliverImageCtx,
  input: DeliverImageInput,
): Promise<DeliverImageResult> {
  const guardedTenantId = await assertRunTenantOwnership({
    tenant_id: ctx.tenant_id,
    run_id: ctx.run_id,
  });
  const tid = asTenantId(guardedTenantId);
  const tenantId = guardedTenantId;
  const store = tenantStorage(tid);
  const db = tenantClient(tid);
  const housePaid = await isPreviewRunId(tenantId, ctx.run_id);
  if (housePaid) {
    const { count, error: countErr } = await db
      .from("run_artifacts")
      .select("id", { count: "exact", head: true })
      .eq("run_id", ctx.run_id)
      .like("mime", "image/%");
    if (countErr || (count ?? 0) > 0) {
      return {
        images: [],
        generated: 0,
        typeset: 0,
        cached: 0,
        skipped: input.prompts.map((_, index) =>
          countErr
            ? { index, reason: "meter_error" as const, detail: "Could not check this run's image allowance. Try again." }
            : {
                index,
                reason: "preview_render_used" as const,
                detail: "This run already made its images. Put any other visual in the card's steps.",
              },
        ),
        slack_ok: false,
      };
    }
  }
  const images: GeneratedImage[] = [];
  const skipped: SkippedImage[] = [];
  const deadline = Date.now() + GEN_DEADLINE_MS;
  let capReached = false;
  let vendorOutOfCredits = false;
  let typesetCount = 0;

  const MODE_TASK: Record<GenerateImageInput["mode"], MediaTask> = {
    photo: "image.photo",
    text: "image.text",
    edit: "image.edit",
    vector: "image.vector",
    draft: "image.draft",
  };
  const mode = input.mode ?? "photo";
  const task: MediaTask = ctx.task ?? MODE_TASK[mode];
  const configured = await isTaskConfigured(task);
  const modelTag = await cacheModelTag(task);
  const ext: "png" | "svg" = task === "image.vector" ? "svg" : "png";

  let referenceUrl: string | undefined = input.reference_url;
  let referenceError: string | null = null;
  if (input.reference_url && !/^https:\/\//i.test(input.reference_url)) {
    const own = input.reference_url.match(REF_PATH_RE);
    const owner = own?.[2];
    if (!own || owner!.toLowerCase() !== tenantId.toLowerCase()) {
      referenceError = "reference_not_owned";
    } else {
      const { data, error } = await store.from(own[1]).createSignedUrl(`${owner}/${own[3]}`, 3600);
      if (error || !data?.signedUrl) referenceError = "reference_unavailable";
      else referenceUrl = data.signedUrl;
    }
  }

  const binding = await artifactRunBinding(ctx.run_id);

  for (let i = 0; i < input.prompts.length; i++) {
    const { prompt } = input.prompts[i];
    const needsPlate = prompt !== null;

    if (needsPlate && Date.now() > deadline) {
      skipped.push({ index: i, reason: "deadline" });
      continue;
    }
    if (needsPlate && capReached) {
      skipped.push({ index: i, reason: "over_daily_cap" });
      continue;
    }
    if (needsPlate && vendorOutOfCredits) {
      skipped.push({ index: i, reason: "vendor_out_of_credits" });
      continue;
    }
    if (needsPlate && referenceError) {
      skipped.push({ index: i, reason: "generation_failed", detail: referenceError });
      continue;
    }
    let filename = safeFilename(input.prompts[i].filename, i, ext);

    let bytes: Buffer | null = null;
    let mime = "image/png";
    let fromCache = false;
    let genCost = 0;
    let genModel = modelTag;
    let pendingCache: { path: string; pending: string; bytes: Buffer; mime: string } | null = null;

    if (needsPlate) {
      const identity = `${prompt}|${input.reference_url ?? ""}`;
      const cachePath = cacheKey(tenantId, input.aspect_ratio, identity, modelTag, ext);

      try {
        const dl = await store.from(ARTIFACT_BUCKET).download(cachePath);
        if (dl.data) {
          bytes = Buffer.from(await dl.data.arrayBuffer());
          mime = ext === "svg" ? SVG_MIME : "image/png";
          fromCache = true;
        }
      } catch {
      }
      if (fromCache && ctx.renderKey && (await isMediaRouterEnabled())) {
        genCost = estimateCost(task, { prompt, aspect_ratio: input.aspect_ratio });
        if (!housePaid && !(await canAffordMedia(tenantId, genCost))) {
          skipped.push({ index: i, reason: "insufficient_credits" });
          continue;
        }
      }

      const pendingPath = pendingPlatePath(
        tenantId,
        ctx.run_id,
        `${i}:${slotHash(prompt, input.aspect_ratio, mode, input.reference_url)}`,
        ext,
      );
      if (!bytes) {
        try {
          const pp = pendingPath;
          const [img, meta] = await Promise.all([
            store.from(ARTIFACT_BUCKET).download(pp),
            store.from(ARTIFACT_BUCKET).download(`${pp}.json`),
          ]);
          if (img.data && meta.data) {
            const m = JSON.parse(Buffer.from(await meta.data.arrayBuffer()).toString("utf8")) as {
              cost_usd?: unknown;
              model?: unknown;
              mime?: unknown;
              cache_model_tag?: unknown;
            };
            if (typeof m.cost_usd === "number" && typeof m.model === "string" && typeof m.cache_model_tag === "string") {
              if (!housePaid && !(await canAffordMedia(tenantId, m.cost_usd))) {
                skipped.push({ index: i, reason: "insufficient_credits" });
                continue;
              }
              bytes = Buffer.from(await img.data.arrayBuffer());
              mime = typeof m.mime === "string" ? m.mime : ext === "svg" ? SVG_MIME : "image/png";
              genCost = m.cost_usd;
              genModel = m.model;
              pendingCache = {
                path: cacheKey(tenantId, input.aspect_ratio, identity, m.cache_model_tag, ext),
                pending: pendingPath,
                bytes,
                mime,
              };
            }
          }
        } catch {
        }
      }

      if (!bytes) {
      if (!configured) {
        skipped.push({ index: i, reason: "not_configured" });
        continue;
      }
      const gate = await meterPlatformGeneration({
        tenant_id: tenantId,
        run_id: ctx.run_id,
        surface: "agent-image",
        index: `${i}:${slotHash(prompt, input.aspect_ratio, mode, input.reference_url)}`,
      });
      if (gate.decision === "over_cap") {
        capReached = true;
        skipped.push({ index: i, reason: "over_daily_cap" });
        continue;
      }
      if (gate.decision === "meter_error" || gate.decision === "already") {
        skipped.push({
          index: i,
          reason: "meter_error",
          detail: gate.decision === "already" ? "retry_replay" : gate.error,
        });
        continue;
      }
      if (
        !housePaid &&
        !(await canAffordMedia(
          tenantId,
          estimateCost(task, { prompt, aspect_ratio: input.aspect_ratio }),
        ))
      ) {
        skipped.push({ index: i, reason: "insufficient_credits" });
        continue;
      }
      const gen = await routeImage(task, {
        prompt,
        aspect_ratio: input.aspect_ratio,
        reference_url: referenceUrl,
      });
      if (!gen.ok) {
        if (gen.reason === "refused") {
          skipped.push({ index: i, reason: "refused", detail: gen.error });
          continue;
        }
        if (gen.reason === "out_of_credits" || isVendorOutOfCredits(gen.error)) {
          vendorOutOfCredits = true;
          skipped.push({ index: i, reason: "vendor_out_of_credits", detail: "zavi_image_service_unavailable" });
          void logEvent({
            level: "error",
            source: "reports.generate_image",
            code: "image_vendor_out_of_credits",
            tenant_id: tenantId,
            run_id: ctx.run_id,
            meta: VENDOR_PLAN_REQUIRED.test(gen.error ?? "")
              ? { failure_class: "vendor_plan_required" }
              : { failure_class: "vendor_out_of_credits", http_status: 403 },
          });
          continue;
        }
        skipped.push({ index: i, reason: "generation_failed", detail: gen.error });
        continue;
      }
      const fetched = await fetchImage(gen.imageUrl, ctx.log, task);
      if (!fetched) {
        skipped.push({ index: i, reason: "download_failed" });
        continue;
      }
      bytes = fetched.bytes;
      mime = fetched.mime;
      if (mime === SVG_MIME) {
        const clean = sanitizeSvg(bytes.toString("utf8"));
        if (!clean) {
          skipped.push({ index: i, reason: "unsupported_type", detail: "svg_unparseable" });
          continue;
        }
        bytes = Buffer.from(clean, "utf8");
      }
      genCost = gen.cost_usd;
      genModel = gen.model;
      pendingCache = { path: cachePath, pending: pendingPath, bytes, mime };
      try {
        const a = await store.from(ARTIFACT_BUCKET).upload(pendingPath, bytes, { contentType: mime, upsert: true });
        const b = a.error
          ? a
          : await store.from(ARTIFACT_BUCKET).upload(
              `${pendingPath}.json`,
              Buffer.from(JSON.stringify({ cost_usd: genCost, model: genModel, mime, cache_model_tag: modelTag })),
              { contentType: PENDING_META_MIME, upsert: true },
            );
        if (a.error || b.error) {
          await store.from(ARTIFACT_BUCKET).remove([pendingPath, `${pendingPath}.json`]);
          throw new Error((a.error ?? b.error)!.message);
        }
      } catch (e) {
        ctx.log?.(`generate_image: pending plate write skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
      }
    }

    if (!needsPlate && !ctx.transform) {
      skipped.push({ index: i, reason: "transform_failed", detail: "no_transform_for_plateless_slot" });
      continue;
    }

    if (ctx.transform) {
      try {
        const out = await ctx.transform(bytes, i);
        if (!out) {
          skipped.push({ index: i, reason: "transform_failed" });
          continue;
        }
        bytes = out.bytes;
        mime = out.mime ?? "image/png";
      } catch (e) {
        skipped.push({
          index: i,
          reason: "transform_failed",
          detail: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
    }

    if (!bytes) {
      skipped.push({ index: i, reason: "transform_failed", detail: "no_bytes" });
      continue;
    }

    let storagePath = "";
    let upErr: { message: string } | null = null;
    const requested = filename;
    for (let n = 1; n <= MAX_NAME_TRIES + RANDOM_NAME_TRIES; n++) {
      if (n > 1) {
        const tag = n <= MAX_NAME_TRIES ? String(n) : randomUUID().slice(0, 8);
        filename = requested.replace(/(\.[^.]+)$/, `-${tag}$1`);
      }
      storagePath = `${tenantId}/${ctx.run_id}/${filename}`;
      const { error } = await store
        .from(ARTIFACT_BUCKET)
        .upload(storagePath, bytes, { contentType: mime, upsert: false });
      upErr = error ? { message: error.message } : null;
      if (!upErr || !isAlreadyExists(error)) break;
    }
    if (upErr) {
      skipped.push({ index: i, reason: "store_failed", detail: upErr.message });
      continue;
    }
    const { data: rowData, error: rowErr } = await db
      .from("run_artifacts")
      .upsert(
        {
          tenant_id: tenantId,
          run_id: ctx.run_id,
          storage_path: storagePath,
          filename,
          mime,
          bytes: bytes.byteLength,
          agent_slug: binding.agent_slug,
          thread_id: binding.thread_id,
          render_input: {
            prompt,
            aspect_ratio: input.aspect_ratio,
            ...(needsPlate && ctx.renderTag ? { tag: ctx.renderTag } : {}),
          },
        },
        { onConflict: "tenant_id,run_id,filename" },
      )
      .select("id")
      .single();
    if (rowErr || !rowData) {
      skipped.push({ index: i, reason: "store_failed", detail: rowErr?.message });
      continue;
    }
    let chargeOk = true;
    if (!housePaid && needsPlate && genCost > 0) {
      const renderPart = ctx.renderKey
        ? `:${createHash("sha256").update(ctx.renderKey).digest("hex").slice(0, 10)}`
        : "";
      const charge = {
        tenant_id: tenantId,
        run_id: ctx.run_id,
        key: `${ctx.run_id}:agent-image:${i}:${slotHash(prompt!, input.aspect_ratio, mode, input.reference_url)}${renderPart}`,
        cost_usd: genCost,
        task,
        model: genModel,
      };
      let outcome = await chargeMedia(charge);
      if (outcome === "error") outcome = await chargeMedia(charge);
      if (outcome === "error" && (await mediaChargeRecorded(tenantId, charge.key).catch(() => false))) {
        outcome = "charged";
      }
      chargeOk = outcome !== "error";
    }
    if (!chargeOk) {
      const artifactId = (rowData as { id: string }).id;
      const takeBack = async (): Promise<string | null> => {
        try {
          const rm = await store.from(ARTIFACT_BUCKET).remove([storagePath]);
          const del = await db.from("run_artifacts").delete().eq("id", artifactId);
          return rm.error?.message ?? del.error?.message ?? null;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      };
      const cleanupErr = (await takeBack()) && (await takeBack());
      if (cleanupErr) {
        void logEvent({
          level: "error",
          source: "reports.generate_image",
          code: "withheld_image_cleanup_failed",
          tenant_id: tenantId,
          run_id: ctx.run_id,
          error: new Error(cleanupErr),
        });
      }
      skipped.push({ index: i, reason: "charge_failed" });
      continue;
    }
    trackMediaGenerated({ tenant_id: tenantId, media: "image", kind: prompt !== null ? "ai_image" : "text_panel" });
    if (pendingCache && !housePaid) {
      try {
        const { error: cacheErr } = await store
          .from(ARTIFACT_BUCKET)
          .upload(pendingCache.path, pendingCache.bytes, { contentType: pendingCache.mime, upsert: true });
        if (cacheErr) throw new Error(cacheErr.message);
        await store.from(ARTIFACT_BUCKET).remove([pendingCache.pending, `${pendingCache.pending}.json`]);
      } catch (e) {
        ctx.log?.(`generate_image: cache write skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await saveDeliveredImageToFiles(tid, (rowData as { id: string }).id, filename, mime, bytes, ctx.log);
    let image_path: string | undefined;
    if (ctx.stageable && mime !== SVG_MIME) {
      try {
        const jpeg = await sharp(bytes).flatten({ background: "#ffffff" }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
        const stagePath = `${tenantId}/${randomUUID()}.jpg`;
        const { error: stErr } = await store
          .from(CHAT_IMAGE_BUCKET)
          .upload(stagePath, jpeg, { contentType: "image/jpeg", upsert: false });
        if (stErr) throw new Error(stErr.message);
        image_path = stagePath;
      } catch (e) {
        ctx.log?.(`deliver-image: stageable copy skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    images.push({
      artifact_id: (rowData as { id: string }).id,
      slot: i,
      filename,
      bytes: bytes.byteLength,
      cached: fromCache && !(genCost > 0),
      ...(image_path ? { image_path } : {}),
    });
    if (!needsPlate) typesetCount += 1;
  }

  let slack_ok = false;
  if (input.channel_id && images.length) {
    for (const img of images) {
      try {
        const dl = await store
          .from(ARTIFACT_BUCKET)
          .download(`${tenantId}/${ctx.run_id}/${img.filename}`);
        if (!dl.data) continue;
        const b = Buffer.from(await dl.data.arrayBuffer());
        const uploaded = await uploadFileToThread({
          tenant_id: tenantId,
          channel_id: input.channel_id,
          thread_ts: input.thread_ts,
          bytes: b,
          filename: img.filename,
          title: img.filename,
          team_id: ctx.slack_team_id ?? undefined,
        });
        slack_ok = true;
        await db
          .from("run_artifacts")
          .update({
            slack_delivered: true,
            slack_file_id: uploaded.file_id,
            slack_channel_id: input.channel_id,
            slack_thread_ts: input.thread_ts ?? null,
            slack_team_id: ctx.slack_team_id ?? null,
          })
          .eq("run_id", ctx.run_id)
          .eq("filename", img.filename);
      } catch (e) {
        ctx.log?.(`generate_image: slack drop soft-failed: ${e instanceof Error ? e.message : String(e)}`);
        await logEvent({
          level: "warn",
          source: "slack.artifact_delivery",
          code: "inline_delivery_soft_failed",
          tenant_id: tenantId,
          run_id: ctx.run_id,
          error: e,
        });
      }
    }
  }

  if (!images.length && skipped.length) {
    void logEvent({
      level: "warn",
      source: "reports.generate_image",
      code: "no_images_delivered",
      tenant_id: tenantId,
      run_id: ctx.run_id,
      meta: { requested: input.prompts.length, skipped_reason: skipped[0]?.reason },
    });
  }

  return {
    images,
    generated: images.filter((x) => !x.cached).length - typesetCount,
    typeset: typesetCount,
    cached: images.filter((x) => x.cached).length,
    skipped,
    slack_ok,
  };
}
