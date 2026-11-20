
import { setTimeout as delay } from "node:timers/promises";
import {
  assertSafeUrl,
  SsrfBlockedError,
} from "../../onboarding/enrichment/url-guard";
import {
  sanitizeFetchedContent,
  xmlEscapeContent,
} from "../../onboarding/enrichment/sanitize";
import {
  SOCIAL_CRAWLER_UA,
  isSocialOgDomain,
  extractSocialCard,
  renderSocialCardBody,
  hostnameOf,
} from "./social-card";

export class WebFetchError extends Error {
  constructor(
    public readonly code:
      | "web_fetch_timeout"
      | "web_fetch_network"
      | "web_fetch_too_many_redirects"
      | "web_fetch_bad_redirect"
      | "web_fetch_no_response"
      | "web_fetch_http_error"
      | "web_fetch_no_body"
      | "web_fetch_body_too_large",
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WebFetchError";
  }
}

export const MAX_REDIRECTS = 3;
export const MAX_BODY_BYTES = 1 * 1024 * 1024;
export const WALLCLOCK_MS = 60_000;

export const DEFAULT_EXCERPT_BYTES = 16 * 1024;
export const MAX_EXCERPT_BYTES = 64 * 1024;

const SPA_ROOT_MARKERS: RegExp[] = [
  /<div[^>]*\bid=["']root["']/i,
  /<div[^>]*\bid=["']__next["']/i,
  /<div[^>]*\bid=["']app["']/i,
  /\bdata-reactroot\b/i,
  /\b__NEXT_DATA__\b/,
  /\bself\.__next_f\b/,
];

export type FetchOptions = {
  max_bytes: number;
  timeout_ms: number;
  max_excerpt_bytes?: number;
  userAgent?: string;
  ogCardOnly?: boolean;
};

export type CaptureKind = "dom_text" | "blocked" | "empty_shell" | "social_card";

export type FetchResult = {
  final_url: string;
  status: number;
  content_type: string;
  body_text: string;
  capture: CaptureKind;
  tag_detection?: string;
};

export async function fetchWithGuards(
  initialUrl: string,
  opts: FetchOptions,
  fetchFn: typeof fetch = fetch,
): Promise<FetchResult> {
  const startTs = Date.now();
  let url = initialUrl;
  let res: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (Date.now() - startTs > opts.timeout_ms) {
      throw new WebFetchError(
        "web_fetch_timeout",
        `request exceeded ${opts.timeout_ms}ms`,
      );
    }
    await assertSafeUrl(url);

    const remainingMs = opts.timeout_ms - (Date.now() - startTs);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remainingMs);
    try {
      res = await fetchFn(url, {
        method: "GET",
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "user-agent": opts.userAgent ?? "praxis-web-fetch/1.0",
          accept: "text/html, text/plain, application/json;q=0.8, */*;q=0.5",
        },
      });
    } catch (e) {
      throw new WebFetchError(
        "web_fetch_network",
        `network failure: ${(e as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      if (hop === MAX_REDIRECTS) {
        throw new WebFetchError(
          "web_fetch_too_many_redirects",
          `exceeded ${MAX_REDIRECTS} redirects`,
        );
      }
      try {
        url = new URL(loc, url).toString();
      } catch {
        throw new WebFetchError(
          "web_fetch_bad_redirect",
          `malformed Location header: ${loc.slice(0, 200)}`,
        );
      }
      await delay(10);
      continue;
    }
    break;
  }

  if (!res) {
    throw new WebFetchError("web_fetch_no_response", "no response captured");
  }

  const ANTI_BOT_5XX = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);
  if (
    res.status === 401 ||
    res.status === 403 ||
    res.status === 429 ||
    res.status === 999 ||
    ANTI_BOT_5XX.has(res.status)
  ) {
    if (!opts.ogCardOnly && isSocialOgDomain(url)) {
      try {
        const cardRes = await fetchWithGuards(
          initialUrl,
          { ...opts, userAgent: SOCIAL_CRAWLER_UA, ogCardOnly: true },
          fetchFn,
        );
        if (cardRes.capture === "social_card") return cardRes;
      } catch {
      }
    }
    return {
      final_url: url,
      status: res.status,
      content_type: res.headers.get("content-type") ?? "",
      body_text: `<untrusted_web_content>\n[blocked: HTTP ${res.status} from ${url} — origin refused the request. A real-browser render may be required.]\n</untrusted_web_content>`,
      capture: "blocked",
    };
  }
  if (res.status >= 400) {
    throw new WebFetchError(
      "web_fetch_http_error",
      `HTTP ${res.status} from ${url}`,
      { status: res.status, final_url: url },
    );
  }

  const content_type = res.headers.get("content-type") ?? "";

  const reader = res.body?.getReader();
  if (!reader) {
    throw new WebFetchError("web_fetch_no_body", "response body unreadable");
  }
  let bytesRead = 0;
  let bodyCut = false;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (bytesRead + value.byteLength > opts.max_bytes) {
      const room = opts.max_bytes - bytesRead;
      if (room > 0) {
        chunks.push(value.subarray(0, room));
        bytesRead += room;
      }
      bodyCut = true;
      try {
        await reader.cancel();
      } catch {
      }
      break;
    }
    bytesRead += value.byteLength;
    chunks.push(value);
  }

  const buf = new Uint8Array(bytesRead);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  let raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (bodyCut) {
    for (const tag of ["script", "style"]) {
      const open = raw.toLowerCase().lastIndexOf(`<${tag}`);
      if (open > raw.toLowerCase().lastIndexOf(`</${tag}`)) raw = raw.slice(0, open);
    }
    const lastLt = raw.lastIndexOf("<");
    if (lastLt > raw.lastIndexOf(">")) raw = raw.slice(0, lastLt);
  }

  if (opts.ogCardOnly) {
    const card = extractSocialCard(raw);
    if (card) {
      return {
        final_url: url,
        status: res.status,
        content_type,
        body_text: `<untrusted_web_content>\n${renderSocialCardBody(card, hostnameOf(url))}\n</untrusted_web_content>`,
        capture: "social_card",
      };
    }
    return {
      final_url: url,
      status: res.status,
      content_type,
      body_text: `<untrusted_web_content>\n[blocked: ${url} returned no og: share card to a preview crawler.]\n</untrusted_web_content>`,
      capture: "blocked",
    };
  }

  const sanitized = sanitizeFetchedContent(raw);

  const isHtml =
    /\bhtml\b/i.test(content_type) || (content_type === "" && /<html[\s>]/i.test(raw));
  const SHELL_VISIBLE_THRESHOLD = 1200;
  const visibleTextLen = sanitized.replace(/\s+/g, " ").trim().length;
  const hasSpaMarker = SPA_ROOT_MARKERS.some((re) => re.test(raw));
  const isEmptyShell =
    isHtml && hasSpaMarker && visibleTextLen < SHELL_VISIBLE_THRESHOLD;

  if (isEmptyShell) {
    return {
      final_url: url,
      status: res.status,
      content_type,
      body_text: `<untrusted_web_content>\n[empty_shell: HTTP ${res.status} from ${url} — the page is a client-rendered SPA shell with only ${visibleTextLen} visible characters in the raw HTML. The real content is rendered by JavaScript we don't execute; a real-browser render is required to read it.]\n</untrusted_web_content>`,
      capture: "empty_shell",
    };
  }

  const escaped = xmlEscapeContent(sanitized);
  const EXCERPT_BYTES = Math.min(
    MAX_EXCERPT_BYTES,
    Math.max(DEFAULT_EXCERPT_BYTES, opts.max_excerpt_bytes ?? DEFAULT_EXCERPT_BYTES),
  );
  const droppedBytes = Math.max(0, escaped.length - EXCERPT_BYTES);
  const trimmed =
    droppedBytes > 0 ? `${escaped.slice(0, EXCERPT_BYTES)} …[truncated]` : escaped;
  const note =
    droppedBytes > 0
      ? `\n[excerpt_truncated: returned ${EXCERPT_BYTES} of ${escaped.length} bytes; ${droppedBytes} dropped. This is a PARTIAL read — do NOT conclude an element or section is absent based on it. Re-fetch with max_excerpt_bytes (up to ${MAX_EXCERPT_BYTES}) to see more, and if the page still exceeds that, say so rather than reporting an absence.]`
      : "";
  const cutNote = bodyCut
    ? `\n[body_truncated: the page is larger than ${opts.max_bytes} bytes; only the first ${opts.max_bytes} were downloaded. This is a PARTIAL read — do NOT conclude an element or section is absent based on it.]`
    : "";
  const tagNote = isHtml
    ? `[tag_detection_unavailable: <script> and <style> blocks are removed from this body before you see it, so a pixel, tag manager, analytics or conversion snippet CANNOT be observed here. Do not report a tag as missing, absent or "not installed" from this read — say tag presence is unverified, and check it in the platform's own UI or an installed-tag tool.]`
    : "";
  const body_text = `<untrusted_web_content>\n${trimmed}\n</untrusted_web_content>${note}${cutNote}`;

  return {
    final_url: url,
    status: res.status,
    content_type,
    ...(tagNote ? { tag_detection: tagNote } : {}),
    body_text,
    capture: "dom_text",
  };
}

export { SsrfBlockedError } from "../../onboarding/enrichment/url-guard";
