"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useArtifactPreview } from "./artifacts/artifactPreviewContext";
import { PAGE_MIME } from "./artifacts/artifactRender";
import type { Artifact } from "./artifacts/types";

export type SharedPage = {
  id: string;
  run_id: string;
  title: string;
  visibility: "private" | "public";
  public_url: string | null;
  expires_at: string | null;
  created_at: string;
};

const PAGE_LINK_RE = /\/pages\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function replyLinksAPage(text: string | undefined | null): boolean {
  return !!text && PAGE_LINK_RE.test(text);
}

function pageHref(page: SharedPage): string {
  return `/pages/${page.id}`;
}

function toPageArtifact(page: SharedPage): Artifact {
  return {
    id: page.id,
    run_id: page.run_id,
    title: page.title,
    filename: page.title,
    mime: PAGE_MIME,
    type: "website",
    bytes: 0,
    created_at: page.created_at,
    updated_at: page.created_at,
    preview_url: pageHref(page),
    source: { kind: "chat", id: page.run_id, title: page.title, href: pageHref(page) },
  };
}

function openPageInNewTab(page: SharedPage) {
  window.open(pageHref(page), "_blank", "noopener,noreferrer");
}

function useDockPage() {
  const { canDock, open, openArtifact } = useArtifactPreview();
  const dock = useCallback(
    (page: SharedPage, auto = false) =>
      openArtifact({ artifact: toPageArtifact(page), onDownload: () => openPageInNewTab(page), autoOpened: auto }),
    [openArtifact],
  );
  return { canDock, dock, paneOpen: open !== null };
}

export function SharedPagesForRun({ runId, autoOpen = false }: { runId: string; autoOpen?: boolean }) {
  const [pages, setPages] = useState<SharedPage[] | null>(null);
  const { canDock, dock, paneOpen } = useDockPage();
  const autoOpenedRun = useRef<string | null>(null);

  useEffect(() => {
    if (!autoOpen || !canDock || paneOpen) return;
    if (autoOpenedRun.current === runId) return;
    const first = pages?.[0];
    if (!first) return;
    autoOpenedRun.current = runId;
    dock(first, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, canDock, dock, pages, runId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(`/api/workspace/shared-pages?run_id=${encodeURIComponent(runId)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { pages?: SharedPage[] };
        if (!cancelled) setPages(data.pages ?? []);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (!pages || pages.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {pages.map((p) => (
        <SharedPageCard key={p.id} initial={p} />
      ))}
    </div>
  );
}

export function useSharedPageActions(initial: SharedPage) {
  const [page, setPage] = useState(initial);
  const [busy, setBusy] = useState<null | "publish" | "revoke">(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const act = async (action: "publish" | "revoke") => {
    setBusy(action);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/shared-pages/${encodeURIComponent(page.id)}/${action}`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        page?: SharedPage;
        error?: { message?: string };
      };
      if (!res.ok || !data.page) throw new Error(data.error?.message ?? `Could not ${action === "publish" ? "make it public" : "revoke the link"}.`);
      setPage(data.page);
      if (action === "publish" && data.page.public_url) await copy(data.page.public_url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
    }
  };

  return { page, busy, error, copied, publish: () => act("publish"), revoke: () => act("revoke"), copy };
}

export function SharePageControls({ actions }: { actions: ReturnType<typeof useSharedPageActions> }) {
  const { page, busy, error, copied, publish, revoke, copy } = actions;
  const expires = page.expires_at
    ? new Date(page.expires_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;
  return (
    <div className="flex flex-col gap-2">
      {page.visibility === "private" ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void publish()}
            disabled={busy !== null}
            className="rounded-cta bg-ink px-3 py-1.5 text-xs font-medium text-cream hover:bg-inkSoft disabled:opacity-50"
          >
            {busy === "publish" ? "Making public…" : "Make public"}
          </button>
          <span className="text-xs text-inkMuted">Only your workspace can see this page.</span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => page.public_url && void copy(page.public_url)}
            className="rounded-cta border border-transparent bg-ink px-3 py-1.5 text-xs font-medium text-cream hover:bg-inkSoft"
            title={page.public_url ?? undefined}
          >
            {copied ? "Link copied" : "Copy public link"}
          </button>
          <button
            type="button"
            onClick={() => void revoke()}
            disabled={busy !== null}
            className="rounded-cta border border-creamDeep px-3 py-1.5 text-xs text-inkSoft hover:border-inkMuted disabled:opacity-50"
          >
            {busy === "revoke" ? "Revoking…" : "Revoke"}
          </button>
          <span className="text-xs text-inkMuted">
            Anyone with the link can open it{expires ? ` until ${expires}` : ""}.
          </span>
        </div>
      )}
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}

export function SharedPageCard({ initial }: { initial: SharedPage }) {
  const actions = useSharedPageActions(initial);
  const { page } = actions;
  const { canDock, dock } = useDockPage();
  const openClass = "rounded-cta border border-creamDeep px-3 py-1.5 text-xs font-medium text-ink hover:border-inkMuted";
  return (
    <div className="flex flex-col gap-2 rounded-[16px] border border-creamDeep bg-white p-4 dark:bg-transparent">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-base font-medium text-ink">{page.title}</p>
          <p className="text-xs text-inkMuted">Page · {page.visibility === "public" ? "Public" : "Private"}</p>
        </div>
        {canDock ? (
          <button type="button" onClick={() => dock(page)} className={openClass}>
            Open
          </button>
        ) : (
          <a href={pageHref(page)} target="_blank" rel="noopener" className={openClass}>
            Open
          </a>
        )}
      </div>
      <SharePageControls actions={actions} />
    </div>
  );
}
