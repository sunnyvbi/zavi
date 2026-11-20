
import { chromium } from "playwright-core";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { scrubDom } from "./browser-mcp/dom-scrub";
import {
  sanitizePickedElement,
  type PickedElement,
} from "./browser-mcp/picker-overlay";
import { getPreviewCdp } from "./engineer-site-preview";
import { serviceClient } from "@/services/supabase";

const SCREENSHOT_LONG_EDGE = 1568;
const SCREENSHOT_JPEG_QUALITY = 85;

export interface PreviewSnapshot {
  screenshotPng: Buffer | null;
  screenshotMime: string;
  url: string | null;
  rawDomHtml: string | null;
  pickedRaw?: unknown;
}

export interface PreviewSnapshotter {
  snapshot(args: { cdpUrl: string }): Promise<PreviewSnapshot>;
}

function createCdpSnapshotter(): PreviewSnapshotter {
  return {
    async snapshot({ cdpUrl }) {
      const browser = await chromium.connectOverCDP(cdpUrl);
      try {
        const ctx = browser.contexts()[0] ?? (await browser.newContext());
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        const screenshotPng = await page
          .screenshot({ fullPage: false })
          .catch(() => null);
        let url: string | null = null;
        try {
          url = page.url();
        } catch {
          url = null;
        }
        const rawDomHtml = await page
          .evaluate(() => document.documentElement.outerHTML)
          .catch(() => null);
        const pickedRaw = await page
          .evaluate(
            () => (window as unknown as { __praxis_picked?: unknown }).__praxis_picked,
          )
          .catch(() => undefined);
        return {
          screenshotPng,
          screenshotMime: "image/png",
          url,
          rawDomHtml,
          pickedRaw,
        };
      } finally {
        await browser.close().catch(() => {
        });
      }
    },
  };
}

let snapshotterImpl: PreviewSnapshotter | null = null;
let defaultSnapshotter: PreviewSnapshotter | null = null;

export function _setPreviewSnapshotter(s: PreviewSnapshotter | null): void {
  snapshotterImpl = s;
}

function getSnapshotter(): PreviewSnapshotter {
  if (snapshotterImpl) return snapshotterImpl;
  if (!defaultSnapshotter) defaultSnapshotter = createCdpSnapshotter();
  return defaultSnapshotter;
}

export type PreviewCaptureResult =
  | {
      ok: true;
      screenshotPng: Buffer | null;
      screenshotMime: string;
      url: string | null;
      scrubbedDomHtml: string | null;
      domBytes: number;
      pickedElement: PickedElement | null;
      ms: number;
    }
  | { ok: false; reason: string; ms: number };

export async function captureEngineerPreview(args: {
  session_id: string;
  tenant_id: string;
}): Promise<PreviewCaptureResult> {
  const started = Date.now();
  const entry = getPreviewCdp(args.session_id);
  if (!entry || entry.tenantId !== args.tenant_id) {
    return { ok: false, reason: "no_open_preview", ms: Date.now() - started };
  }

  let snap: PreviewSnapshot;
  try {
    snap = await getSnapshotter().snapshot({ cdpUrl: entry.cdpUrl });
  } catch {
    return { ok: false, reason: "snapshot_failed", ms: Date.now() - started };
  }

  const scrubbed =
    typeof snap.rawDomHtml === "string" && snap.rawDomHtml.length > 0
      ? scrubDom(snap.rawDomHtml)
      : null;

  const pickedElement = sanitizePickedElement(snap.pickedRaw);

  return {
    ok: true,
    screenshotPng: snap.screenshotPng ?? null,
    screenshotMime: snap.screenshotMime || "image/png",
    url: snap.url ?? null,
    scrubbedDomHtml: scrubbed?.html ?? null,
    domBytes: scrubbed?.stats.bytesOut ?? 0,
    pickedElement,
    ms: Date.now() - started,
  };
}

export function previewCaptureLogMeta(r: PreviewCaptureResult): {
  ms: number;
  bytes: number;
  captured: boolean;
} {
  return { ms: r.ms, bytes: r.ok ? r.domBytes : 0, captured: r.ok };
}

export async function storePreviewScreenshot(
  tenantId: string,
  png: Buffer,
): Promise<string | null> {
  let jpeg: Buffer;
  try {
    jpeg = await sharp(png)
      .rotate()
      .resize(SCREENSHOT_LONG_EDGE, SCREENSHOT_LONG_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: SCREENSHOT_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch {
    return null;
  }
  const path = `${tenantId}/${randomUUID()}.jpg`;
  const { error } = await serviceClient()
    .storage.from("agent-chat-images")
    .upload(path, jpeg, { contentType: "image/jpeg", upsert: false });
  if (error) return null;
  return path;
}
