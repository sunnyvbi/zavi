"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Check, Facebook, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { channelMark } from "../channelMark";
import { cx, FOCUS_RING } from "../layout/shared";
import { SentIcon } from "./libraryIcons";
import { STUDIO_PATH } from "./types";

export type PostTargetName = "instagram" | "facebook" | "linkedin" | "x" | "tiktok" | "youtube";
type PostTarget = { name: PostTargetName; label: string; status: "connected" | "not_connected" | "coming_soon" };
type PostResult = { name: PostTargetName; status: "posted" | "already_posted" | "not_connected" | "coming_soon" | "failed"; message?: string };

export const POST_LABELS: Record<PostTargetName, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  x: "X",
  tiktok: "TikTok",
  youtube: "YouTube",
};

export function postedLabel(name: PostTargetName): string {
  return name === "tiktok" ? "Posted privately on TikTok (only you can see it)" : `Posted on ${POST_LABELS[name]}`;
}

const ORDER = Object.keys(POST_LABELS) as PostTargetName[];
const RETRY = "Nothing was posted. Try again in a minute.";

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

async function errorText(r: Response, fallback: string): Promise<string> {
  try {
    const body = (await r.json()) as { error?: { message?: unknown } };
    return typeof body?.error?.message === "string" && body.error.message ? body.error.message : fallback;
  } catch {
    return fallback;
  }
}

const LOAD_FAILED = "Your channels could not be loaded. Try again.";
let cachedTargets: PostTarget[] | null = null;
let pendingTargets: Promise<PostTarget[]> | null = null;

export function loadPostTargets(): Promise<PostTarget[]> {
  if (pendingTargets) return pendingTargets;
  const request: Promise<PostTarget[]> = apiFetch(`${STUDIO_PATH}/post-targets`)
    .then(async (r) => {
      if (!r.ok) throw new Error(await errorText(r, LOAD_FAILED));
      const body = (await r.json()) as { targets?: PostTarget[] };
      const list = Array.isArray(body.targets) ? body.targets : [];
      if (pendingTargets === request) cachedTargets = list;
      return list;
    })
    .finally(() => {
      if (pendingTargets === request) pendingTargets = null;
    });
  pendingTargets = request;
  return request;
}

export function forgetPostTargets(): void {
  cachedTargets = null;
  pendingTargets = null;
}

export function PostDialog({
  artifactId,
  title,
  posted,
  posting = [],
  check = [],
  failed = [],
  onPosted,
  onClose,
}: {
  artifactId: string;
  title: string;
  posted: PostTargetName[];
  posting?: PostTargetName[];
  check?: PostTargetName[];
  failed?: PostTargetName[];
  onPosted: (names: PostTargetName[]) => void;
  onClose: () => void;
}) {
  const [targets, setTargets] = useState<PostTarget[] | null>(() => cachedTargets);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PostTargetName[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const workspace = useWorkspaceOptional();
  const openIntegrations = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!workspace || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onClose();
    workspace.openTab({ kind: "brain", title: "Connectors", payload: { kind: "brain" }, dirty: false, pinned: false });
  };

  useEffect(() => {
    let live = true;
    const seeded = cachedTargets !== null;
    loadPostTargets()
      .then((list) => {
        if (live) setTargets(list);
      })
      .catch((e: Error) => {
        if (live && !seeded) setLoadError(e.message || LOAD_FAILED);
      });
    return () => {
      live = false;
    };
  }, []);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (!targets || targets.length === 0) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== closeRef.current) return;
    panelRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]:not([disabled])')?.focus();
  }, [targets]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (!sending.current) onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'),
      );
      if (focusable.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const inside = panel.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first || document.activeElement === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const locked = (name: PostTargetName) => posted.includes(name) || posting.includes(name);

  const toggle = (name: PostTargetName) => {
    if (locked(name)) return;
    setError(null);
    setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))));
  };

  const post = async () => {
    const channels = picked.filter((n) => !locked(n));
    if (sending.current || channels.length === 0) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch(`${STUDIO_PATH}/videos/${encodeURIComponent(artifactId)}/post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels, ...(channels.some((n) => check.includes(n)) ? { repost: channels.filter((n) => check.includes(n)) } : {}) }),
        idempotent: true,
      });
      if (!r.ok) {
        setError(await errorText(r, RETRY));
        return;
      }
      const body = (await r.json()) as { results?: PostResult[] };
      const results = Array.isArray(body.results) ? body.results : [];
      const done = results.filter((x) => x.status === "posted" || x.status === "already_posted").map((x) => x.name);
      const missed = results.filter((x) => x.status !== "posted" && x.status !== "already_posted");
      if (done.length > 0) onPosted(done);
      if (missed.length === 0 && done.length > 0) {
        onClose();
        return;
      }
      setPicked((p) => p.filter((n) => !done.includes(n)));
      setError(
        missed.length > 0
          ? missed.map((x) => `${POST_LABELS[x.name] ?? x.name}: ${x.message ?? "This post did not go out. Try again in a minute."}`).join(" ")
          : RETRY,
      );
    } catch {
      setError(RETRY);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const pickedLabels = picked.map((n) => POST_LABELS[n]);
  const noneConnected = targets !== null && !targets.some((t) => t.status === "connected");
  const allDone = !noneConnected && targets !== null && targets.every((t) => t.status !== "connected" || locked(t.name));

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="workspace-shell dialog-scrim fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Post "${title}"`}
      onClick={() => !sending.current && onClose()}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        data-testid="video-post-dialog"
        className="flex max-h-[calc(100dvh-32px)] w-full min-w-0 max-w-md flex-col gap-4 overflow-y-auto rounded-2xl border border-rule bg-cream p-5 text-ink shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-[18px] font-semibold leading-6 text-ink">Post &ldquo;{title}&rdquo;</h2>
            <p className="mt-1 text-[14px] leading-5 text-inkMuted">Pick one or more channels. Zavi posts it for you.</p>
          </div>
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            data-testid="video-post-close"
            className={cx("-mr-1.5 -mt-1 grid size-9 shrink-0 place-items-center rounded-full text-inkMuted hover:bg-creamDeep hover:text-ink disabled:opacity-50", FOCUS_RING)}
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {loadError ? (
          <p role="alert" className="text-[14px] text-coral">
            {loadError}
          </p>
        ) : targets === null ? (
          <p role="status" className="text-[14px] text-inkMuted">
            Loading your channels…
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {targets.map((t) => {
              const done = t.status === "connected" && locked(t.name);
              const off = t.status !== "connected" || done;
              const on = !off && picked.includes(t.name);
              const note = done
                ? posted.includes(t.name)
                  ? t.name === "tiktok"
                    ? "Posted privately"
                    : "Posted"
                  : "Posting…"
                : t.status === "coming_soon"
                  ? "Coming soon"
                  : "Not connected";
              const hint = t.status !== "connected" ? null : check.includes(t.name) ? `Not confirmed. Check ${t.label} first` : failed.includes(t.name) ? "Last post failed" : null;
              const name = <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{t.label}</span>;
              if (off) {
                return (
                  <li key={t.name}>
                    <div
                      data-testid={`video-post-row-${t.name}`}
                      aria-disabled="true"
                      data-done={done ? "true" : undefined}
                      className="flex min-h-14 min-w-0 cursor-not-allowed items-center gap-3 rounded-2xl border-2 border-rule px-3 py-2 text-ink opacity-50"
                    >
                      <PostMark name={t.name} />
                      {name}
                      <span className="shrink-0 text-[13px] text-inkMuted">{note}</span>
                    </div>
                  </li>
                );
              }
              return (
                <li key={t.name}>
                  <label
                    data-testid={`video-post-row-${t.name}`}
                    data-selected={on ? "true" : "false"}
                    className={cx(
                      "flex min-h-14 min-w-0 cursor-pointer items-center gap-3 rounded-2xl border-2 px-3 py-2 text-ink",
                      on ? "border-ink" : "border-rule hover:bg-creamDeep",
                      busy && "cursor-not-allowed",
                    )}
                  >
                    <PostMark name={t.name} />
                    {name}
                    {hint && (
                      <span data-testid={`video-post-hint-${t.name}`} className="shrink-0 text-[13px] text-inkMuted">
                        {hint}
                      </span>
                    )}
                    <input type="checkbox" checked={on} disabled={busy} onChange={() => toggle(t.name)} className="peer sr-only" />
                    <span
                      aria-hidden
                      data-testid={`video-post-box-${t.name}`}
                      className={cx(
                        "grid size-6 shrink-0 place-items-center rounded-md border-2 peer-focus-visible:ring-2 peer-focus-visible:ring-ink peer-focus-visible:ring-offset-2",
                        on ? "border-ink bg-ink text-cream" : "border-ink/30 bg-cream",
                      )}
                    >
                      {on && <Check className="h-4 w-4" strokeWidth={3} />}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p role="alert" data-testid="video-post-error" className="rounded-xl border border-coral/30 bg-coral/10 px-3 py-2 text-[14px] leading-5 text-coral">
            {error}
          </p>
        )}
        {targets !== null && !loadError && (
          <p data-testid="video-post-summary" className="text-[13px] leading-5 text-inkMuted">
            {noneConnected ? (
              <>
                No channel is connected yet.{" "}
                <Link href="/workspace#integrations" onClick={openIntegrations} data-testid="video-post-connect" className={cx("font-semibold text-ink underline", FOCUS_RING)}>
                  Connect a channel
                </Link>{" "}
                to post this video.
              </>
            ) : allDone ? (
              "This video is already on every channel you have connected."
            ) : picked.length > 0 ? (
              `Zavi posts it on ${joinNames(pickedLabels)}.`
            ) : (
              "Pick at least one channel."
            )}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={cx(
              "inline-flex h-10 items-center justify-center rounded-full border border-ink/20 bg-cream px-4 text-[14px] font-semibold text-ink hover:bg-creamDeep disabled:opacity-50",
              FOCUS_RING,
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void post()}
            disabled={targets === null || picked.length === 0 || busy}
            data-testid="video-post-submit"
            className={cx(
              "inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-ink px-4 text-[14px] font-semibold text-cream hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-50",
              FOCUS_RING,
            )}
          >
            <SentIcon className="h-4 w-4" />
            {busy ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const MARK_SLUG: Record<Exclude<PostTargetName, "facebook">, string> = {
  instagram: "instagram_organic",
  linkedin: "linkedin_organic",
  x: "x_organic",
  tiktok: "tiktok_organic",
  youtube: "youtube_organic",
};

function PostMark({ name }: { name: PostTargetName }) {
  if (name === "facebook") {
    return (
      <span aria-hidden data-testid="video-post-mark" className="grid size-9 shrink-0 place-items-center rounded-full bg-[#1877F2] text-white">
        <Facebook className="h-[18px] w-[18px]" fill="currentColor" strokeWidth={0} />
      </span>
    );
  }
  const mark = channelMark(MARK_SLUG[name]);
  return (
    <span aria-hidden data-testid="video-post-mark" className={cx("grid size-9 shrink-0 place-items-center overflow-hidden rounded-full", mark.bg)}>
      {mark.kind === "glyph" ? (
        <mark.Icon className={cx("h-[18px] w-[18px]", mark.fg)} />
      ) : (
        <span
          style={{ backgroundImage: `url(${mark.src})` }}
          className={cx("bg-center bg-no-repeat", mark.fit === "cover" ? "size-full bg-cover" : "size-[22px] bg-contain")}
        />
      )}
    </span>
  );
}
