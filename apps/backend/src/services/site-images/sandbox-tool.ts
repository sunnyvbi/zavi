
import { z } from "zod";
import { getBoolSetting } from "@/services/settings";
import { isAssistantRun } from "@/services/mcp/assistant-policy";
import { execCommand, readFile, writeFile, writeFileBytes } from "@/services/sandbox/e2b-client";
import { logEvent } from "@/services/logging/logEvent";
import { downloadMedia, generateMediaWithFallback, isMediaRouterEnabled, isTaskConfiguredWithFallback, routeImage } from "@/services/media-router/router";
import {
  generateSiteImages,
  MAX_IMAGES_PER_CALL,
  SITE_IMAGE_ASPECTS,
  siteImageRequestSchema,
  type SiteImageDeps,
  type SiteImagesResult,
} from "./generate";

export const SITE_IMAGES_TOOL_NAME = "add_site_images";

export const SITE_IMAGES_TOOL_DESCRIPTION = [
  `Generate up to ${MAX_IMAGES_PER_CALL} photos for this website in ONE call (they render in parallel, about 20-60 seconds) and save them into the repo as optimized webp files under public/images/.`,
  "Each entry: slug (file name, e.g. `hero`, `about-team`), prompt (what the photo shows: subject, setting, mood, light, palette; a real scene, no text or logos), alt (what a screen reader should say), aspect (`16:9` hero/banner, `4:5` portrait card, `1:1` square); optional role (hero|service|product|people|gallery|supporting), placement, overlay (copy sits on it), focal {x,y} 0-100 (where the subject sits; crops keep it) and style (the brief's photo style).",
  "Returns {images:[{slug, src, srcset, width, height, alt, focal}], skipped:[{slug, reason}]}. Pass {src, srcset, width, height, alt, focal} as a section's `image`, or use each image with its exact src/srcset/width/height/alt: `<img src={src} srcSet={srcset} sizes=\"100vw\" width={width} height={height} alt={alt} />` (add `loading=\"lazy\"` below the first screen). Never hotlink an image from another site.",
  "A slug already generated is returned again for free; pick a NEW slug to replace a picture. If an image is skipped (or none land), do not call again for it: use the no-image layout. With the starter's sections, leave `image` out (Hero falls back to its centered layout, Features alternating to an icon panel, CTA split to the banner, Gallery drops it); by hand, use a brand-colour or gradient panel. Never leave a box labelled \"image\" or \"photo\", an image icon standing in for a photo, a broken image or an empty frame.",
].join("\n");

export const siteImagesToolInput = {
  images: z.array(siteImageRequestSchema).min(1).max(MAX_IMAGES_PER_CALL * 2),
};

export function liveSiteImageDeps(getSandboxId: () => Promise<string>, trace: { tenant_id?: string; run_id?: string } = {}): SiteImageDeps {
  const madeDirs = new Set<string>();
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  async function ensureDir(dir: string): Promise<void> {
    if (madeDirs.has(dir)) return;
    const r = await execCommand(await getSandboxId(), `mkdir -p ${q(dir)}`, 30_000);
    if (r.exit_code !== 0) throw new Error(`mkdir failed: ${r.stderr.slice(0, 120)}`);
    madeDirs.add(dir);
  }
  return {
    configured: (task) => isTaskConfiguredWithFallback(task),
    async generate(task, prompt, aspect) {
      if (await isMediaRouterEnabled()) {
        const r = await generateMediaWithFallback(task, { prompt, aspect_ratio: aspect }, { pollDelayMs: 2_000, maxPolls: 45 });
        if (r.attempts.length > 0) {
          void logEvent({
            level: r.ok ? "info" : "warn",
            source: "site-images",
            code: "site_images.vendor_fallback",
            tenant_id: trace.tenant_id ?? null,
            run_id: trace.run_id ?? null,
            meta: {
              passed_over: r.attempts.map((a) => `${a.vendor}:${a.reason}`).join(","),
              ...(r.ok ? { served_by: r.vendor, cost_usd: r.cost_usd } : { skipped_reason: r.reason }),
            },
          });
        }
        return r.ok ? { ok: true, url: r.url, cost_usd: r.cost_usd, model: r.model } : { ok: false, reason: r.reason, error: r.error };
      }
      const r = await routeImage(task, { prompt, aspect_ratio: aspect });
      return r.ok ? { ok: true, url: r.imageUrl, cost_usd: r.cost_usd, model: r.model } : { ok: false, reason: r.reason, error: r.error };
    },
    download: (url, maxBytes) => downloadMedia(url, maxBytes),
    async readText(path) {
      try {
        return await readFile(await getSandboxId(), path);
      } catch {
        return null;
      }
    },
    async exists(path) {
      const r = await execCommand(await getSandboxId(), `test -s ${q(path)}`, 30_000);
      return r.exit_code === 0;
    },
    async present(path) {
      const r = await execCommand(await getSandboxId(), `test -e ${q(path)}`, 30_000);
      return r.exit_code === 0;
    },
    async writeBytes(path, bytes) {
      await ensureDir(dirOf(path));
      await writeFileBytes(await getSandboxId(), path, bytes);
    },
    async writeText(path, text) {
      await ensureDir(dirOf(path));
      await writeFile(await getSandboxId(), path, text);
    },
  };
}

export async function runSiteImagesTool(
  ctx: { tenant_id: string; run_id: string; root: string; getSandboxId: () => Promise<string> },
  args: { images: Array<z.input<typeof siteImageRequestSchema>> },
  deps: SiteImageDeps = liveSiteImageDeps(ctx.getSandboxId, { tenant_id: ctx.tenant_id, run_id: ctx.run_id }),
): Promise<SiteImagesResult> {
  const images = args.images.map((i) => siteImageRequestSchema.parse(i));
  return generateSiteImages({ tenant_id: ctx.tenant_id, run_id: ctx.run_id, repoRoot: ctx.root, images }, deps);
}

export function isSiteBoundPayload(payload: unknown): boolean {
  const x = payload as { site_id?: unknown; target?: { github_full_name?: unknown } } | null;
  return (
    !!x &&
    typeof x.site_id === "string" &&
    x.site_id.trim().length > 0 &&
    typeof x.target?.github_full_name === "string" &&
    x.target.github_full_name.trim().length > 0
  );
}

export async function siteImagesSandboxOptions(
  payload: unknown,
  tenant_id: string,
  trigger?: string,
): Promise<{ site_images?: true }> {
  if (!isSiteBoundPayload(payload) || isAssistantRun(trigger)) return {};
  try {
    return (await getBoolSetting("site_images", tenant_id)) ? { site_images: true } : {};
  } catch {
    return { site_images: true };
  }
}

export { SITE_IMAGE_ASPECTS };
