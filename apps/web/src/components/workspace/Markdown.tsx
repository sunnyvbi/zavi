"use client";

import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import { memo, useMemo, useState, type ReactNode } from "react";
import { FigureMarksProvider, FigureSpan, rehypeFigureMarks, type FigureMarks } from "./receipts/figureMarks";
import { connectInfoFor } from "@zavi/shared";
import { launchConnect } from "@/app/connectors/connectStrategies";
import { apiFetch } from "@/lib/api";
import { isPraxisActionHref, parsePraxisAction } from "./praxisActionUrl";
import { pushWorkspaceLocation, WORKSPACE_PATH } from "./navigation/workspaceRoutes";

async function fetchGithubInstallUrl(): Promise<string> {
  const res = await apiFetch("/api/connectors/github/install-url", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(
      window.location.pathname + window.location.search,
    )}`;
    throw new Error("session expired");
  }
  const body = (await res.json().catch(() => ({}))) as {
    url?: string;
    error?: { code?: string; message?: string };
  };
  if (!res.ok || !body.url) {
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return body.url;
}

function PraxisActionButton({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const parsed = parsePraxisAction(href);
  if (!parsed) {
    return <span className="text-ink">{children}</span>;
  }
  return (
    <span className="inline-flex flex-col items-start gap-1 align-baseline">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            if (parsed.verb === "add-repo") {
              const url = await fetchGithubInstallUrl();
              window.open(url, "_blank", "noopener,noreferrer");
              setBusy(false);
            } else {
              const info = connectInfoFor(parsed.slug);
              if (info) await launchConnect(parsed.slug, info);
              setBusy(false);
            }
          } catch (e) {
            setErr((e as Error).message);
            setBusy(false);
          }
        }}
        className="inline-flex items-center gap-1 rounded-cta bg-ink px-2.5 py-1 text-base font-medium text-white shadow-sm transition hover:bg-inkSoft active:bg-inkSoft disabled:opacity-60"
      >
        {busy ? "Opening…" : children}
      </button>
      {err && (
        <span className="text-[12px] text-rose-700">Couldn't open: {err}</span>
      )}
    </span>
  );
}

export { stripModelControlXml } from "./markdownPreprocess";
import { stripModelControlXml as _stripForLocal } from "./markdownPreprocess";

const SANITIZE_SCHEMA: Schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== "img"),
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: ["http", "https", "mailto"],
  },
  attributes: {
    ...(defaultSchema.attributes ?? {}),
  },
};

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm];
const REMARK_PLUGINS_BREAKS: Options["remarkPlugins"] = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS: Options["rehypePlugins"] = [
  [rehypeSanitize, SANITIZE_SCHEMA],
];

const BARE_URL_MAX = 36;
export function shortUrlLabel(href: string): string {
  try {
    const u = new URL(href);
    const label = `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
    return label.length > BARE_URL_MAX ? `${label.slice(0, BARE_URL_MAX - 1)}…` : label;
  } catch {
    return href;
  }
}

function isBareUrl(href: string, children: ReactNode): boolean {
  const text = Array.isArray(children) && children.length === 1 ? children[0] : children;
  return typeof text === "string" && /^https?:\/\//.test(href) && text.trim() === href;
}

function buildComponents(disableActionLinks: boolean): Components {
  return {
    table: ({ children, node: _node, ...props }) => (
      <div className="max-w-full overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    ),
    pre: ({ children, node: _node, className, ...props }) => (
      <pre
        {...props}
        className={`${className ?? ""} overflow-x-auto whitespace-pre-wrap break-words`.trim()}
      >
        {children}
      </pre>
    ),
    code: ({ children, node: _node, className, ...props }) => (
      <code {...props} className={`${className ?? ""} break-words`.trim()}>
        {children}
      </code>
    ),
    a: ({ href, children, node: _node, ...props }) => {
      if (isPraxisActionHref(href)) {
        if (disableActionLinks) {
          return <span className="text-ink">{children}</span>;
        }
        return (
          <PraxisActionButton href={href as string}>
            {children}
          </PraxisActionButton>
        );
      }
      if (!href || href.startsWith("#")) {
        return (
          <a href={href} {...props}>
            {children}
          </a>
        );
      }
      if (isWorkspaceHref(href)) {
        return (
          <a
            href={href}
            {...props}
            onClick={(e) => {
              if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              if (!window.location.pathname.startsWith(WORKSPACE_PATH)) return;
              e.preventDefault();
              pushWorkspaceLocation(href);
            }}
          >
            {children}
          </a>
        );
      }
      const bare = isBareUrl(href, children);
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          {...props}
          {...(bare ? { title: href } : {})}
        >
          {bare ? shortUrlLabel(href) : children}
        </a>
      );
    },
  };
}

export function isWorkspaceHref(href: string): boolean {
  return href === WORKSPACE_PATH || href.startsWith(`${WORKSPACE_PATH}?`) || href.startsWith(`${WORKSPACE_PATH}#`) || href.startsWith(`${WORKSPACE_PATH}/`);
}

const ACTIVE_COMPONENTS = buildComponents(false);
const PASSIVE_COMPONENTS = buildComponents(true);
const ACTIVE_COMPONENTS_FIGURES: Components = { ...ACTIVE_COMPONENTS, span: FigureSpan as Components["span"] };

export const Markdown = memo(function Markdown({
  source,
  className,
  disableActionLinks = false,
  breaks = false,
  reading = false,
  compact = false,
  figures = null,
}: {
  source: string;
  figures?: FigureMarks | null;
  className?: string;
  breaks?: boolean;
  disableActionLinks?: boolean;
  reading?: boolean;
  compact?: boolean;
}) {
  const cleaned = _stripForLocal(source);
  const rehypePlugins = useMemo<Options["rehypePlugins"]>(
    () => (figures ? [...(REHYPE_PLUGINS ?? []), rehypeFigureMarks(figures)] : REHYPE_PLUGINS),
    [figures],
  );
  const typeScale = compact
    ? `text-[14px] leading-[1.75]
       prose-p:my-[0.85em] prose-p:leading-[1.75] prose-p:text-[14px]
       prose-li:my-[0.35em] prose-li:text-[14px] prose-li:leading-[1.75]`
    : reading
    ? `font-reading text-[16px] leading-[1.7]
       prose-p:my-[0.8em] prose-p:leading-[1.7] prose-p:text-[16px]
       prose-li:text-[16px] prose-li:leading-[1.7]`
    : `text-[16px] leading-[1.6]
       prose-p:my-[0.72em] prose-p:leading-[1.62] prose-p:text-[16px]
       prose-li:text-[16px] prose-li:leading-[1.6]`;
  const body = (
    <div
      className={`prose prose-slate max-w-none break-words
        [--tw-prose-body:rgb(var(--c-ink))]
        [--tw-prose-headings:rgb(var(--c-ink))]
        [--tw-prose-bold:rgb(var(--c-ink))]
        [--tw-prose-links:rgb(var(--c-ink))]
        [--tw-prose-quotes:rgb(var(--c-ink))]
        [--tw-prose-code:rgb(var(--c-ink))]
        [--tw-prose-counters:rgb(var(--c-ink-muted))]
        [--tw-prose-bullets:rgb(var(--c-ink-muted))]
        [--tw-prose-captions:rgb(var(--c-ink-muted))]
        [--tw-prose-hr:rgb(var(--c-rule))]
        [--tw-prose-th-borders:rgb(var(--c-rule))]
        [--tw-prose-td-borders:rgb(var(--c-rule))]
        ${typeScale}
        prose-headings:tracking-tight
        prose-headings:mt-5 prose-headings:mb-2
        prose-h1:text-[22px] prose-h2:text-[20px] prose-h3:text-[16px]
        prose-strong:text-ink prose-strong:font-semibold
        prose-hr:my-4 prose-hr:border-ink/10
        prose-code:before:content-none prose-code:after:content-none
        prose-code:font-code prose-code:rounded prose-code:bg-bone prose-code:px-1.5 prose-code:py-0.5 prose-code:text-[16px] prose-code:font-normal prose-code:tracking-[-0.01em]
        prose-pre:font-code prose-pre:bg-bone prose-pre:text-ink prose-pre:text-[16px]
        prose-table:text-[16px]
        prose-th:border prose-th:border-ink/10 prose-th:bg-bone prose-th:px-2 prose-th:py-1
        prose-td:border prose-td:border-ink/10 prose-td:px-2 prose-td:py-1
        prose-a:text-ink prose-a:underline prose-a:underline-offset-2 hover:prose-a:decoration-2
        prose-ul:my-[0.72em] prose-ol:my-[0.72em] prose-ul:pl-5 prose-ol:pl-5 prose-li:my-[0.35em]
        [&_li::marker]:text-inkMuted
        [&_li>p]:my-0 [&_li>p+p]:mt-2
        [&_blockquote>p]:my-0
        [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
        prose-blockquote:border-l-2 prose-blockquote:border-ink/15 prose-blockquote:pl-3 prose-blockquote:text-ink
        [&_blockquote_p:first-of-type]:before:content-none [&_blockquote_p:last-of-type]:after:content-none
        ${className ?? ""}`}
    >
      <ReactMarkdown
        remarkPlugins={breaks ? REMARK_PLUGINS_BREAKS : REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={
          disableActionLinks ? PASSIVE_COMPONENTS : figures ? ACTIVE_COMPONENTS_FIGURES : ACTIVE_COMPONENTS
        }
      >
        {cleaned}
      </ReactMarkdown>
    </div>
  );
  return figures ? <FigureMarksProvider marks={figures}>{body}</FigureMarksProvider> : body;
});
