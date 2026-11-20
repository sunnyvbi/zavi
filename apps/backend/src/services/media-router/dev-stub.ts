import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { isProdBackend } from "@/services/config/backend-env";
import type { MediaAspect, MediaRequest, MediaResult, MediaTask } from "./types";

export const DEV_STUB_MODEL = "dev-stub";

const IMAGE_MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const SIZE: Record<MediaAspect, [number, number]> = { "1:1": [1024, 1024], "4:5": [1024, 1280], "9:16": [900, 1600], "16:9": [1600, 900] };

function onKnownNonProdDb(env: Record<string, string | undefined>): boolean {
  try {
    const host = new URL(String(env.SUPABASE_URL ?? "")).hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return true;
    return host.endsWith(".supabase.co") && !isProdBackend(env);
  } catch {
    return false;
  }
}

export function isDevStubEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MEDIA_DEV_STUB === "1" && env.NODE_ENV !== "production" && onKnownNonProdDb(env);
}

export function isDevStubbed(task: MediaTask, env: Record<string, string | undefined> = process.env): boolean {
  if (!task.startsWith("image.") || !isDevStubEnabled(env)) return false;
  return !String(env.MEDIA_DEV_STUB_EXCEPT ?? "")
    .split(",")
    .map((t) => t.trim())
    .includes(task);
}

export function devImagesDir(env: Record<string, string | undefined> = process.env): string {
  return (env.MEDIA_DEV_IMAGES_DIR || "").trim() || join(homedir(), ".zavi", "dev-images");
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function pickLocalImage(dir: string, key: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => IMAGE_MIME[extname(f).toLowerCase()]).sort();
  if (files.length === 0) return null;
  const file = files[hash(key) % files.length]!;
  const bytes = await readFile(join(dir, file)).catch(() => null);
  return bytes && bytes.byteLength > 0 ? { mime: IMAGE_MIME[extname(file).toLowerCase()]!, bytes: new Uint8Array(bytes) } : null;
}

async function placeholderPng(aspect: MediaAspect, key: string): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default;
  const [w, h] = SIZE[aspect];
  const hue = hash(key) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,82%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},40%,58%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.62}" cy="${h * 0.42}" r="${Math.min(w, h) * 0.22}" fill="hsl(${hue},35%,92%)" opacity="0.7"/></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

function placeholderSvgLogo(key: string): string {
  const hue = hash(key) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="hsl(${hue},45%,38%)"/><path d="M20 40 L32 18 L44 40 Z" fill="hsl(${hue},40%,92%)"/></svg>`;
}

export async function devStubMedia(task: MediaTask, req: MediaRequest): Promise<MediaResult | null> {
  if (!task.startsWith("image.")) return null;
  const key = `${task}|${req.prompt ?? ""}|${req.reference_url ?? ""}`;
  if (task === "image.vector") {
    return { ok: true, url: dataUrl("image/svg+xml", new TextEncoder().encode(placeholderSvgLogo(key))), mime: "image/svg+xml", vendor: "fal", model: DEV_STUB_MODEL, cost_usd: 0 };
  }
  const local = await pickLocalImage(devImagesDir(), key);
  if (local) return { ok: true, url: dataUrl(local.mime, local.bytes), mime: local.mime, vendor: "fal", model: DEV_STUB_MODEL, cost_usd: 0 };
  const png = await placeholderPng(req.aspect_ratio ?? "1:1", key);
  return { ok: true, url: dataUrl("image/png", png), mime: "image/png", vendor: "fal", model: DEV_STUB_MODEL, cost_usd: 0 };
}
