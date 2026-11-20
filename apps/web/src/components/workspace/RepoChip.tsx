"use client";

import { useEffect, useRef, useState } from "react";
import { useGithubRepos } from "@/lib/workspace/useGithubRepos";
import { useBuildSessions } from "@/lib/workspace/useBuildSessions";
import { HOME_SCOPE, ownGithubRepo, resolveRepoChip, type RepoChipScope } from "@/lib/workspace/siteRepoChip";
import { useWorkspace } from "./WorkspaceShell";
import { RepoPickerPanel } from "./RepoPickerPanel";
import { GithubMark } from "./GithubMark";

function truncate(s: string, n = 32): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function RepoChip({
  role,
  scope = HOME_SCOPE,
}: {
  role: "owner" | "admin" | "member" | "viewer" | null;
  scope?: RepoChipScope;
}) {
  const { state, pending, setDefault } = useGithubRepos();
  const buildSessions = useBuildSessions();
  const { openTab } = useWorkspace();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const canEdit = role === "owner" || role === "admin";
  const goSettings = () => {
    if (typeof window !== "undefined") {
      window.location.hash = "integration";
    }
    openTab({
      kind: "settings",
      title: "Settings",
      payload: { kind: "settings", section: "integration" },
      dirty: false,
      pinned: false,
    });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (scope.kind === "home" && state.status === "loading") {
    return <div className="mb-1.5 h-7 w-40 animate-pulse rounded-full bg-ink/5" />;
  }

  const siteChip = resolveRepoChip(scope, buildSessions, null, !!ownGithubRepo(state));
  if (siteChip.site) return null;
  if (state.status === "ok" && state.connected && state.default && !ownGithubRepo(state)) return null;

  if (state.status === "loading") {
    return (
      <div className="mb-1.5 h-7 w-40 animate-pulse rounded-full bg-ink/5" />
    );
  }

  if (state.status === "error") {
    return (
      <div className="mb-1.5 text-[13px] text-inkMuted">
        Couldn’t load repos.
      </div>
    );
  }

  if (!state.connected || state.repos.length === 0) {
    const label = !state.connected ? "Connect GitHub" : "Manage GitHub repos";
    return (
      <button
        type="button"
        onClick={goSettings}
        className="mb-1.5 inline-flex h-8 items-center gap-2 rounded-full border border-[#ebecef] bg-white px-3 text-[13px] font-medium text-inkMuted transition-colors hover:border-ink/30 hover:text-ink"
      >
        <GithubMark className="h-3.5 w-3.5" />
        {label}
      </button>
    );
  }

  const defaultInList = !!state.default && state.repos.includes(state.default);
  const pillLabel = defaultInList
    ? truncate(state.default!)
    : state.default
      ? "Default unavailable"
      : "Pick a repo";
  const pillIsWarn = !defaultInList;

  return (
    <div ref={wrapRef} className="relative mb-1.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setOpen((o) => !o);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex h-8 max-w-full items-center gap-2 rounded-full border bg-white px-3 text-[13px] font-medium transition-colors hover:border-ink/30 disabled:opacity-60 ${
          pillIsWarn
            ? "border-coral/40 text-coral"
            : "border-[#ebecef] text-ink"
        }`}
        title={
          defaultInList
            ? state.default!
            : state.default
              ? `Default "${state.default}" is no longer a connected repo`
              : "No default repo set"
        }
      >
        <GithubMark className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{pillLabel}</span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="h-3 w-3 shrink-0 opacity-60"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-9 left-0 z-20 w-[340px] max-w-[80vw] overflow-hidden rounded-2xl border border-rule bg-white shadow-elevMd"
        >
          <RepoPickerPanel
            state={state}
            pending={pending}
            canEdit={canEdit}
            setDefault={setDefault}
            onPicked={() => setOpen(false)}
            onManage={goSettings}
          />
        </div>
      )}
    </div>
  );
}
