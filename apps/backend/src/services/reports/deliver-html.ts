
import { z } from "zod";
import { asTenantId, tenantClient, tenantStorage } from "@/services/tenant-client";
import { uploadFileToThread } from "@/services/tools/slack/upload_file";
import { logEvent } from "@/services/logging/logEvent";
import { trackDocumentDelivered } from "@/services/analytics/action-events";
import { ExpectedToolError } from "@/services/tools/types";
import { figureGuardedText } from "./unsourced-figure-gate";
import { assertRunTenantOwnership } from "./guard";
import { artifactRunBinding } from "./run-binding";
import { ARTIFACT_BUCKET, ARTIFACT_MAX_BYTES } from "./constants";
import { renderBlogHtml } from "./render-html";
import { blogThemeFromBrand, DEFAULT_BLOG_THEME } from "./brand-theme";
import { resolveBrandKit } from "@/services/brand/resolve-brand-kit";
import { estimateCost, isTaskConfigured, routeImage } from "@/services/media-router/router";
import { mediaSlotHash } from "@/services/media-router/keys";
import {
  canAffordMedia,
  flushCharges,
  type PendingCharge,
} from "@/services/media-router/charge";
import { meterPlatformGeneration } from "@/services/mcp/higgsfield-meter";
import { sanitizeArtifactFilename } from "@/services/sandbox/tool-registry";
import sharp from "sharp";

const HTML_MIME = "text/html";
const HERO_ASPECT = "16:9";
const MAX_HERO_IMAGES = 3;
const IMAGE_PROMPT_SUFFIX = ", no text, no logos, no watermarks";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const HERO_WIDTH_PX = 1600;
const HERO_WEBP_QUALITY = 80;
const MAX_EMBEDDED_IMAGE_BYTES_TOTAL = 2 * 1024 * 1024;
const MAX_BLOG_ARTIFACTS_WITH_IMAGES_PER_RUN = 2;

export const deliverBlogHtmlInputSchema = z.object({
  title: z.string().min(1).max(300),
  subtitle: z.string().max(500).optional(),
  body: z.string().min(1),
  readTimeMinutes: z.number().int().positive().max(120).optional(),
  image_concepts: z.array(z.string().min(1).max(1000)).max(MAX_HERO_IMAGES).optional(),
  filename: z.string().min(1).max(120),
  channel_id: z.string().optional(),
  thread_ts: z.string().optional(),
});
export type DeliverBlogHtmlInput = z.infer<typeof deliverBlogHtmlInputSchema>;

export type DeliverBlogHtmlCtx = {
  tenant_id: string;
  run_id: string;
  slack_team_id?: string;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export type DeliverBlogHtmlResult = {
  artifact_id: string;
  filename: string;
  bytes: number;
  slack_ok: boolean;
  images_generated: number;
};

function normalizeHtmlFilename(raw: string): string {
  const stem = raw.replace(/\.(html?|md|pdf|txt)$/i, "");
  const safeStem = sanitizeArtifactFilename(stem) || "blog";
  return sanitizeArtifactFilename(`${safeStem}.html`) || "blog.html";
}

async function compressForWeb(
  buf: Buffer,
  log?: DeliverBlogHtmlCtx["log"],
): Promise<{ buf: Buffer; contentType: string }> {
  try {
    const out = await sharp(buf)
      .resize({ width: HERO_WIDTH_PX, withoutEnlargement: true })
      .webp({ quality: HERO_WEBP_QUALITY })
      .toBuffer();
    if (out.byteLength > 0 && out.byteLength < buf.byteLength)
      return { buf: out, contentType: "image/webp" };
  } catch (e) {
    log?.(`hero image compress failed, using original: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { buf, contentType: "" };
}

async function fetchAsDataUri(
  url: string,
  log?: DeliverBlogHtmlCtx["log"],
): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
    if (!/^image\//i.test(ct)) return null;
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.byteLength === 0 || raw.byteLength > MAX_IMAGE_BYTES) return null;
    const { buf, contentType } = await compressForWeb(raw, log);
    if (buf.byteLength > MAX_EMBEDDED_IMAGE_BYTES_TOTAL) {
      log?.(`hero image dropped: ${buf.byteLength} bytes still over the embed ceiling`);
      return null;
    }
    log?.(`hero image ${raw.byteLength} → ${buf.byteLength} bytes`);
    return `data:${contentType || ct};base64,${buf.toString("base64")}`;
  } catch (e) {
    log?.(`hero image fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function generateHeroImages(
  concepts: string[],
  meterCtx: { tenant_id: string; run_id: string },
  log?: DeliverBlogHtmlCtx["log"],
): Promise<{ images: Array<{ url: string; alt: string }>; charges: PendingCharge[] }> {
  if (!concepts.length) return { images: [], charges: [] };
  if (!(await isTaskConfigured("image.hero"))) {
    log?.("image generation not configured — delivering blog without hero images");
    return { images: [], charges: [] };
  }
  const out: Array<{ url: string; alt: string }> = [];
  const charges: PendingCharge[] = [];
  const picked = concepts.slice(0, MAX_HERO_IMAGES);
  let embeddedBytes = 0;
  for (let i = 0; i < picked.length; i++) {
    const concept = picked[i];
    try {
      if (embeddedBytes >= MAX_EMBEDDED_IMAGE_BYTES_TOTAL) {
        log?.(
          `hero image ${i} skipped: embed budget spent (${embeddedBytes} of ${MAX_EMBEDDED_IMAGE_BYTES_TOTAL} bytes)`,
        );
        break;
      }
      const gate = await meterPlatformGeneration({
        tenant_id: meterCtx.tenant_id,
        run_id: meterCtx.run_id,
        surface: "blog-hero",
        index: `${i}:${mediaSlotHash(concept, HERO_ASPECT)}`,
      });
      if (gate.decision !== "charged") {
        log?.(
          `hero image ${i} skipped by the higgsfield meter (${gate.decision})${gate.error ? `: ${gate.error}` : ""}`,
        );
        continue;
      }
      const req = {
        prompt: `${concept}${IMAGE_PROMPT_SUFFIX}`,
        aspect_ratio: HERO_ASPECT,
      } as const;
      if (!(await canAffordMedia(meterCtx.tenant_id, estimateCost("image.hero", req)))) {
        log?.(`image ${i} skipped: insufficient credits`);
        continue;
      }
      const gen = await routeImage("image.hero", req);
      if (!gen.ok) {
        log?.(`hero image gen failed: ${gen.error}`);
        continue;
      }
      const dataUri = await fetchAsDataUri(gen.imageUrl, log);
      if (dataUri) {
        embeddedBytes += dataUri.length;
        out.push({ url: dataUri, alt: concept.slice(0, 200) });
        charges.push({
          tenant_id: meterCtx.tenant_id,
          run_id: meterCtx.run_id,
          key: `${meterCtx.run_id}:blog-hero:${i}:${mediaSlotHash(concept, HERO_ASPECT)}`,
          cost_usd: gen.cost_usd,
          task: "image.hero",
          model: gen.model,
        });
      }
    } catch (e) {
      log?.(`hero image gen threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { images: out, charges };
}

export async function deliverBlogHtml(
  ctx: DeliverBlogHtmlCtx,
  rawInput: unknown,
): Promise<DeliverBlogHtmlResult> {
  let input: DeliverBlogHtmlInput;
  try {
    input = deliverBlogHtmlInputSchema.parse(rawInput);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new ExpectedToolError(
        "invalid_input",
        e.issues.map((er) => er.message).join("; "),
      );
    }
    throw e;
  }

  const guardedTenantId = await assertRunTenantOwnership({
    tenant_id: ctx.tenant_id,
    run_id: ctx.run_id,
  });

  const tid = asTenantId(guardedTenantId);
  const db = tenantClient(tid);

  {
    const guarded = figureGuardedText(
      ctx.run_id,
      [input.title, input.subtitle ?? "", input.body].join("\n"),
      ctx.log,
    );
    if (guarded !== [input.title, input.subtitle ?? "", input.body].join("\n")) {
      input = { ...input, body: figureGuardedText(ctx.run_id, input.body, ctx.log) };
    }
  }

  let allowImages = (input.image_concepts?.length ?? 0) > 0;
  if (allowImages) {
    const { count } = await db
      .from("run_artifacts")
      .select("id", { count: "exact", head: true })
      .eq("run_id", ctx.run_id)
      .eq("mime", HTML_MIME);
    if ((count ?? 0) >= MAX_BLOG_ARTIFACTS_WITH_IMAGES_PER_RUN) {
      allowImages = false;
      ctx.log?.("per-run blog image budget reached — delivering text-only");
    }
  }
  const hero = allowImages
    ? await generateHeroImages(
        input.image_concepts ?? [],
        { tenant_id: guardedTenantId, run_id: ctx.run_id },
        ctx.log,
      )
    : { images: [], charges: [] as PendingCharge[] };
  const heroImages = hero.images;

  let theme = DEFAULT_BLOG_THEME;
  try {
    theme = blogThemeFromBrand(await resolveBrandKit(guardedTenantId));
  } catch (e) {
    ctx.log?.(`brand_theme_unresolved: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }

  let html: string;
  try {
    html = renderBlogHtml(
      {
        title: input.title,
        subtitle: input.subtitle,
        body: input.body,
        readTimeMinutes: input.readTimeMinutes,
        heroImages,
      },
      theme,
    );
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw new ExpectedToolError(
        "invalid_input",
        e.issues.map((er) => er.message).join("; "),
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new ExpectedToolError("blog_render_failed", msg.slice(0, 300));
  }

  const bytes = Buffer.from(html, "utf8");
  if (bytes.byteLength === 0 || !html.startsWith("<!doctype html>")) {
    throw new ExpectedToolError(
      "blog_render_failed",
      "renderer produced bytes that do not look like an HTML document.",
    );
  }
  if (bytes.byteLength > ARTIFACT_MAX_BYTES) {
    throw new ExpectedToolError(
      "blog_too_large",
      `blog html is ${bytes.byteLength} bytes; cap is ${ARTIFACT_MAX_BYTES}.`,
    );
  }

  const filename = normalizeHtmlFilename(input.filename);

  const storagePath = `${guardedTenantId}/${ctx.run_id}/${filename}`;
  const { error: upErr } = await tenantStorage(tid)
    .from(ARTIFACT_BUCKET)
    .upload(storagePath, bytes, { contentType: HTML_MIME, upsert: true });
  if (upErr) {
    throw new ExpectedToolError("storage_upload_failed", upErr.message);
  }

  const binding = await artifactRunBinding(ctx.run_id);
  const { data: rowData, error: rowErr } = await db
    .from("run_artifacts")
    .upsert(
      {
        tenant_id: guardedTenantId,
        run_id: ctx.run_id,
        storage_path: storagePath,
        filename,
        title: input.title,
        mime: HTML_MIME,
        bytes: bytes.byteLength,
        agent_slug: binding.agent_slug,
        thread_id: binding.thread_id,
      },
      { onConflict: "tenant_id,run_id,filename" },
    )
    .select("id")
    .single();
  if (rowErr || !rowData) {
    throw new ExpectedToolError(
      "artifact_row_failed",
      rowErr?.message ?? "row upsert failed",
    );
  }
  const artifact_id = (rowData as { id: string }).id;
  trackDocumentDelivered({ tenant_id: guardedTenantId, mime: HTML_MIME });

  await flushCharges(hero.charges).catch(() => undefined);

  let slack_ok = false;
  if (input.channel_id) {
    try {
      await uploadFileToThread({
        tenant_id: guardedTenantId,
        channel_id: input.channel_id,
        thread_ts: input.thread_ts,
        bytes,
        filename,
        title: input.title,
        team_id: ctx.slack_team_id,
      });
      slack_ok = true;
      await db
        .from("run_artifacts")
        .update({ slack_delivered: true })
        .eq("run_id", ctx.run_id)
        .eq("filename", filename);
    } catch (e) {
      ctx.log?.(`slack delivery soft-failed: ${e instanceof Error ? e.message : String(e)}`);
      await logEvent({
        level: "warn",
        source: "slack.artifact_delivery",
        code: "inline_delivery_soft_failed",
        tenant_id: guardedTenantId,
        run_id: ctx.run_id,
        error: e,
      });
    }
  }

  return {
    artifact_id,
    filename,
    bytes: bytes.byteLength,
    slack_ok,
    images_generated: heroImages.length,
  };
}
