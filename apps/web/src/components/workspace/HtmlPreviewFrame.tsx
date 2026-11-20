'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

type HtmlPreviewFrameProps = {
  title: string;
  summary: string;
  html?: string;
  previewId?: string;
  onReadyChange?: (ready: boolean) => void;
};

const PREVIEW_CSP =
  `<meta http-equiv="Content-Security-Policy" ` +
  `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; ` +
  `form-action 'none'; base-uri 'none';">`;

const PREVIEW_CSP_SCRIPTS =
  `<meta http-equiv="Content-Security-Policy" ` +
  `content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; ` +
  `connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; ` +
  `form-action 'none'; base-uri 'none';">`;

const META_TAG = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const HTTP_EQUIV_REFRESH = /http-equiv\s*=\s*(?:["']\s*)?refresh/i;
const HREF_OR_ACTION = /\b(href|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const PING_ATTR = /\sping\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

function isInPageAnchor(value: string): boolean {
  return value.trim().startsWith("#");
}

function stripNavigationVectors(html: string): string {
  return (
    html
      .replace(META_TAG, (tag) => (HTTP_EQUIV_REFRESH.test(tag) ? "" : tag))
      .replace(HREF_OR_ACTION, (match, attr, dq, sq, uq) => {
        const value = (dq ?? sq ?? uq ?? "") as string;
        return isInPageAnchor(value) ? (match as string) : `${attr}="#"`;
      })
      .replace(PING_ATTR, "")
  );
}

export function harden(rawHtml: string, opts: { scripts?: boolean } = {}): string {
  const csp = opts.scripts ? PREVIEW_CSP_SCRIPTS : PREVIEW_CSP;
  const html = stripNavigationVectors(rawHtml);
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) {
    return html.replace(doctype[0], `${doctype[0]}${csp}`);
  }
  return csp + html;
}

export function HtmlPreviewFrame({
  title,
  summary,
  html,
  previewId,
  onReadyChange,
}: HtmlPreviewFrameProps) {
  const [loaded, setLoaded] = useState(false);
  const [artifactHtml, setArtifactHtml] = useState<string | null>(html ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    if (html) {
      setArtifactHtml(html);
      onReadyChange?.(false);
      return () => {
        cancelled = true;
      };
    }
    if (!previewId) {
      setArtifactHtml(null);
      setError("Preview artifact is missing.");
      onReadyChange?.(false);
      return () => {
        cancelled = true;
      };
    }
    onReadyChange?.(false);
    void apiFetch(
      `/api/workspace/engineer/html-preview/${encodeURIComponent(previewId)}`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error("Preview artifact is unavailable.");
        const body = (await res.json()) as {
          state?: string;
          html?: unknown;
        };
        if (
          body.state !== "html_preview_ready" ||
          typeof body.html !== "string"
        ) {
          throw new Error("Preview artifact is not ready.");
        }
        if (!cancelled) setArtifactHtml(body.html);
      })
      .catch((e) => {
        if (!cancelled) {
          setArtifactHtml(null);
          setError((e as Error).message);
          onReadyChange?.(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [html, onReadyChange, previewId]);

  return (
    <div className="mt-2 rounded-lg border border-ink/10 bg-white/70 p-4">
      <div className="mb-2">
        <p className="text-base font-semibold text-gray-900">{title}</p>
        {summary ? <p className="mt-0.5 text-xs text-gray-500">{summary}</p> : null}
      </div>
      <div className="relative overflow-hidden rounded-md border border-gray-200 bg-white">
        {error ? (
          <div className="flex h-[180px] items-center justify-center px-6 text-center text-base text-red-700">
            {error} The build remains blocked until a preview is displayed.
          </div>
        ) : null}
        {!error && !artifactHtml ? (
          <div className="flex h-[180px] items-center justify-center bg-white">
            <div className="h-4 w-24 animate-pulse rounded bg-gray-200" />
          </div>
        ) : null}
        {!error && artifactHtml && !loaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-white">
            <div className="h-4 w-24 animate-pulse rounded bg-gray-200" />
          </div>
        )}
        {artifactHtml ? <iframe
          srcDoc={harden(artifactHtml)}
          title={`UI preview: ${title}`}
          sandbox=""
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-[420px] w-full"
          onLoad={async () => {
            setLoaded(true);
            if (!previewId) {
              onReadyChange?.(true);
              return;
            }
            const acknowledged = await apiFetch(
              `/api/workspace/engineer/html-preview/${encodeURIComponent(previewId)}/displayed`,
              { method: 'POST' },
            );
            if (acknowledged.ok) {
              onReadyChange?.(true);
            } else {
              setError("Preview display could not be verified.");
              onReadyChange?.(false);
            }
          }}
        /> : null}
      </div>
      {}
      <p className="mt-2 text-xs text-gray-500">
        Static mock of one screen. The buttons and links inside it are inert.
      </p>
    </div>
  );
}
