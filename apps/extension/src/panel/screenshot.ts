
import {
  BROAD_HOST_PATTERN,
  MAX_TITLE_BYTES,
  SCREENSHOT_JPEG_QUALITY,
  SCREENSHOT_MAX_EDGE,
} from "../shared/config";
import { truncateToBytes } from "../shared/text-caps";
import { stripUrlQuery } from "../shared/url";
import { isCapturableUrl } from "./capture";

export type Screenshot = {
  blob: Blob;
  url: string;
  title: string;
};

export type CaptureOutcome =
  | { kind: "ok"; shot: Screenshot }
  | { kind: "uncapturable" };

type TabLite = {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
  active?: boolean;
};

async function ownTab(tabId: number | null): Promise<TabLite | null> {
  if (tabId !== null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab || tab.active === false) return null;
      return tab;
    } catch {
      return null;
    }
  }
  return null;
}

export function isPermissionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /permission|activeTab|all_urls/i.test(msg);
}

async function hasBroadAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [BROAD_HOST_PATTERN] });
  } catch {
    return false;
  }
}

async function requestBroadAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [BROAD_HOST_PATTERN] });
  } catch {
    return false;
  }
}

export async function captureActiveTab(
  tabId: number | null = null,
): Promise<CaptureOutcome> {
  let tab = await ownTab(tabId);
  if (!tab || typeof tab.windowId !== "number") return { kind: "uncapturable" };

  if (tab.url !== undefined && !isCapturableUrl(tab.url)) {
    return { kind: "uncapturable" };
  }

  let dataUrl: string;
  try {
    dataUrl = await captureVisible(tab.windowId);
  } catch (e) {
    if (!isPermissionError(e) || (await hasBroadAccess())) {
      return { kind: "uncapturable" };
    }
    const granted = await requestBroadAccess();
    if (!granted) return { kind: "uncapturable" };
    try {
      tab = (await ownTab(tabId)) ?? tab;
      if (tab.url !== undefined && !isCapturableUrl(tab.url)) {
        return { kind: "uncapturable" };
      }
      dataUrl = await captureVisible(tab.windowId as number);
    } catch {
      return { kind: "uncapturable" };
    }
  }

  if (tab.url === undefined) tab = (await ownTab(tabId)) ?? tab;
  if (tab.url === undefined || !isCapturableUrl(tab.url)) return { kind: "uncapturable" };

  const url = stripUrlQuery(tab.url);
  if (!url) return { kind: "uncapturable" };
  const title = truncateToBytes(tab.title || url, MAX_TITLE_BYTES);

  let blob: Blob;
  try {
    blob = await downscaleJpeg(dataUrl);
  } catch {
    return { kind: "uncapturable" };
  }
  return { kind: "ok", shot: { blob, url, title } };
}

function captureVisible(windowId: number): Promise<string> {
  return chrome.tabs.captureVisibleTab(windowId, {
    format: "jpeg",
    quality: SCREENSHOT_JPEG_QUALITY,
  });
}

export function scaledSize(
  width: number,
  height: number,
  max: number = SCREENSHOT_MAX_EDGE,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max || long === 0) return { width, height };
  const k = max / long;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
  };
}

export async function downscaleJpeg(dataUrl: string): Promise<Blob> {
  const original = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(original);
  const size = scaledSize(bitmap.width, bitmap.height);
  if (size.width === bitmap.width && size.height === bitmap.height) {
    bitmap.close();
    return original;
  }
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("no 2d context");
  }
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  return canvas.convertToBlob({
    type: "image/jpeg",
    quality: SCREENSHOT_JPEG_QUALITY / 100,
  });
}
