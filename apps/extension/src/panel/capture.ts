
import { BROAD_HOST_PATTERN, MAX_TITLE_BYTES } from "../shared/config";
import { capExtraction } from "../shared/extraction-cap";
import { truncateToBytes } from "../shared/text-caps";
import { stripUrlQuery } from "../shared/url";
import type { PageCaptureRaw } from "../content/capture-entry";

const CAPTURE_SCRIPT = "page-capture.js";

export type TabInfo = {
  tabId: number;
  url: string;
  title: string;
};

export type PageCapture = {
  url: string;
  title: string;
  adapter: {
    adapter_id: string;
    schema_version: number;
    extraction: unknown;
  } | null;
  truncated: boolean;
};

export class CaptureError extends Error {}

const UNREADABLE_SCHEMES = [
  "chrome:",
  "chrome-extension:",
  "edge:",
  "about:",
  "devtools:",
  "view-source:",
  "file:",
];

export function isCapturableUrl(url: string | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (UNREADABLE_SCHEMES.includes(u.protocol)) return false;
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.hostname === "chromewebstore.google.com" || u.hostname === "chrome.google.com") {
    return false;
  }
  return true;
}

export async function hasPageAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [BROAD_HOST_PATTERN] });
}

export async function requestPageAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [BROAD_HOST_PATTERN] });
  } catch (e) {
    throw new CaptureError(
      e instanceof Error ? e.message : "Could not ask for page access.",
    );
  }
}

export async function activeTab(): Promise<TabInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || typeof tab.id !== "number") return null;
  if (!tab.url) return null;
  return { tabId: tab.id, url: tab.url, title: tab.title ?? tab.url };
}

export async function capturePage(tab: TabInfo): Promise<PageCapture> {
  if (!isCapturableUrl(tab.url)) {
    throw new CaptureError("Zavi can't read this page.");
  }

  let raw: PageCaptureRaw | null;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.tabId },
      files: [CAPTURE_SCRIPT],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.tabId },
      func: runBundledCapture,
    });
    raw = (results?.[0]?.result as PageCaptureRaw | null | undefined) ?? null;
  } catch (e) {
    throw new CaptureError(
      e instanceof Error ? e.message : "Zavi couldn't read this page.",
    );
  }

  if (!raw || typeof raw.url !== "string") {
    throw new CaptureError("Zavi couldn't read this page.");
  }

  const url = stripUrlQuery(raw.url);
  if (!url) throw new CaptureError("Zavi can't read this page.");

  const title = truncateToBytes(raw.title || url, MAX_TITLE_BYTES);

  if (!raw.adapter) {
    return { url, title, adapter: null, truncated: false };
  }

  const capped = capExtraction(raw.adapter.extraction);
  return {
    url,
    title,
    adapter: {
      adapter_id: raw.adapter.adapter_id,
      schema_version: raw.adapter.schema_version,
      extraction: capped.value,
    },
    truncated: capped.truncated,
  };
}

function runBundledCapture(): unknown {
  const g = globalThis as unknown as {
    __zaviCapture?: { capture: () => unknown };
  };
  try {
    return g.__zaviCapture ? g.__zaviCapture.capture() : null;
  } catch {
    return null;
  }
}
