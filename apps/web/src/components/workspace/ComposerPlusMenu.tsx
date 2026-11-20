"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { ComposerIconButton } from "./ModeComposer";
import { RepoPickerPanel } from "./RepoPickerPanel";
import { ArtifactAttachPanel } from "./ArtifactAttachPanel";
import { useGithubRepos } from "@/lib/workspace/useGithubRepos";
import { useBuildSessions } from "@/lib/workspace/useBuildSessions";
import { HOME_SCOPE, ownGithubRepo, resolveRepoChip, type RepoChipScope } from "@/lib/workspace/siteRepoChip";

function GhIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={className}
      fill="currentColor"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function Chevron({
  className,
  dir = "right",
}: {
  className?: string;
  dir?: "right" | "left";
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={dir === "right" ? "M4.5 3L7.5 6L4.5 9" : "M7.5 3L4.5 6L7.5 9"} />
    </svg>
  );
}

const SURFACE =
  "absolute bottom-full left-0 z-30 mb-2 w-[340px] max-w-[80vw] overflow-hidden rounded-2xl border border-rule bg-white shadow-menu compact:max-w-[88vw]";
const ROW =
  "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[14px] font-medium leading-5 text-ink hover:bg-creamDeep/60 compact:gap-3 compact:px-3.5 compact:py-2.5 compact:text-[16px] compact:leading-[20px]";
const LABEL = "px-3.5 pb-1 pt-1.5 text-[11px] font-normal text-inkMuted compact:pb-1.5 compact:text-[13px]";

type View = "root" | "repos" | "artifacts";

function MenuBody({
  view,
  setView,
  role,
  repos,
  onAttach,
  onPickArtifact,
  attaching,
  onClose,
  onManageRepos,
}: {
  view: View;
  setView: (v: View) => void;
  role: "owner" | "admin" | "member" | "viewer" | null;
  repos: ReturnType<typeof useGithubRepos> | null;
  onAttach: () => void;
  onPickArtifact?: (artifactId: string, filename: string) => void;
  attaching?: string | null;
  onClose: () => void;
  onManageRepos: () => void;
}) {
  const state = repos?.state;
  const canEdit = role === "owner" || role === "admin";
  const ok = state?.status === "ok" ? state : null;
  const activeRepo = ok?.default ?? null;
  const hasRepos = !!ok?.connected && (ok?.repos.length ?? 0) > 0;

  const goManage = () => {
    onClose();
    onManageRepos();
  };

  if (view === "root") {
    return (
      <div className="py-1.5">
        <button
          type="button"
          role="menuitem"
          className={ROW}
          onClick={() => {
            onClose();
            onAttach();
          }}
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5 shrink-0 compact:h-[18px] compact:w-[18px]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21.44 11.05l-8.49 8.49a5 5 0 01-7.07-7.07l8.49-8.49a3 3 0 014.24 4.24l-8.49 8.49a1 1 0 01-1.41-1.41l7.78-7.78" />
          </svg>
          <span className="flex-1">Attach a file</span>
          <Chevron className="ml-auto h-3 w-3 shrink-0 opacity-60" />
        </button>
        {}
        {onPickArtifact && (
          <button
            type="button"
            role="menuitem"
            className={ROW}
            onClick={() => setView("artifacts")}
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5 shrink-0 compact:h-[18px] compact:w-[18px]"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
              <path d="M14 3v5h5" />
            </svg>
            <span className="flex min-w-0 flex-1 flex-col">
              <span>Attach from Artifacts</span>
              <span className="truncate text-[12px] font-normal leading-[16px] text-inkMuted compact:text-[13px] compact:leading-[18px]">
                A file Zavi already has
              </span>
            </span>
            <Chevron className="ml-auto h-3 w-3 shrink-0 opacity-60 compact:h-4 compact:w-4" />
          </button>
        )}
        {repos && <button
          type="button"
          role="menuitem"
          className={ROW}
          onClick={() => (hasRepos ? setView("repos") : goManage())}
        >
          <GhIcon className="h-3.5 w-3.5 shrink-0 compact:h-[18px] compact:w-[18px]" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span>GitHub repo</span>
            <span className="truncate text-[12px] font-normal leading-[16px] text-inkMuted compact:text-[13px] compact:leading-[18px]">
              {state?.status === "loading"
                ? "Loading…"
                : state?.status === "error"
                  ? "Couldn’t load repos"
                  : !ok?.connected
                    ? "Not connected"
                    : activeRepo
                      ? activeRepo
                      : "No repo selected"}
            </span>
          </span>
          <Chevron className="ml-auto h-3 w-3 shrink-0 opacity-60 compact:h-4 compact:w-4" />
        </button>}
      </div>
    );
  }

  if (view === "artifacts") {
    return (
      <>
        <button
          type="button"
          onClick={() => setView("root")}
          className="flex w-full items-center gap-2 border-b border-rule px-3.5 py-2 text-left text-[11px] font-normal text-inkMuted transition-colors hover:text-ink"
        >
          <Chevron className="h-3 w-3" dir="left" />
          Attach a file Zavi already has
        </button>
        <ArtifactAttachPanel
          busy={attaching ?? null}
          onPick={(a) => {
            onPickArtifact?.(a.id, a.filename);
            onClose();
          }}
        />
      </>
    );
  }

  if (!repos) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setView("root")}
        className="flex w-full items-center gap-2 border-b border-rule px-3.5 py-2 text-left text-[11px] font-normal text-inkMuted transition-colors hover:text-ink"
      >
        <Chevron className="h-3 w-3" dir="left" />
        Agents work in this repo
      </button>
      {state?.status === "loading" && (
        <div className="px-3.5 py-3 text-[13px] text-inkMuted">
          Loading repos…
        </div>
      )}
      {state?.status === "error" && (
        <div className="px-3.5 py-3 text-[13px] text-inkMuted">
          Couldn’t load repos.
        </div>
      )}
      {ok && !hasRepos && (
        <button type="button" onClick={goManage} className={ROW}>
          <GhIcon className="h-3.5 w-3.5 shrink-0 compact:h-[18px] compact:w-[18px]" />
          {ok.connected ? "Manage GitHub repos" : "Connect GitHub"}
        </button>
      )}
      {ok && hasRepos && (
        <RepoPickerPanel
          state={ok}
          pending={repos.pending}
          canEdit={canEdit}
          setDefault={repos.setDefault}
          onPicked={onClose}
          onManage={goManage}
        />
      )}
    </>
  );
}

export function ComposerPlusMenu({
  onAttach,
  onPickArtifact,
  attaching,
  repoEnabled,
  role,
  onManageRepos,
  repoChipScope = HOME_SCOPE,
}: {
  onAttach: () => void;
  onPickArtifact?: (artifactId: string, filename: string) => void;
  attaching?: string | null;
  repoEnabled: boolean;
  role: "owner" | "admin" | "member" | "viewer" | null;
  onManageRepos: () => void;
  repoChipScope?: RepoChipScope;
}) {
  if (!repoEnabled) {
    if (onPickArtifact) {
      return <PlusMenu onAttach={onAttach} onPickArtifact={onPickArtifact} attaching={attaching}
        role={role} onManageRepos={onManageRepos} repos={null} />;
    }
    return (
      <ComposerIconButton
        onClick={onAttach}
        ariaLabel="Attach image"
        title="Attach image (you can also paste or drop)"
      >
        <Plus className="h-4 w-4 compact:h-[22px] compact:w-[22px]" aria-hidden />
      </ComposerIconButton>
    );
  }
  return (
    <PlusMenuWithRepo
      onAttach={onAttach}
      onPickArtifact={onPickArtifact}
      attaching={attaching}
      role={role}
      onManageRepos={onManageRepos}
      repoChipScope={repoChipScope}
    />
  );
}

function PlusMenuWithRepo({
  onAttach,
  onPickArtifact,
  attaching,
  role,
  onManageRepos,
  repoChipScope,
}: {
  onAttach: () => void;
  onPickArtifact?: (artifactId: string, filename: string) => void;
  attaching?: string | null;
  role: "owner" | "admin" | "member" | "viewer" | null;
  onManageRepos: () => void;
  repoChipScope: RepoChipScope;
}) {
  const repos = useGithubRepos();
  const buildSessions = useBuildSessions();
  const repoState = repos.state;
  const chip = resolveRepoChip(
    repoChipScope,
    buildSessions,
    repoState.status === "ok" && repoState.connected ? repoState.default : null,
    !!ownGithubRepo(repoState),
  );
  const repoUnknown = repoChipScope.kind === "home" && repoState.status === "loading";
  const chipLabel = chip.repo && !repoUnknown && !chip.site && chip.repo === ownGithubRepo(repoState) ? chip.repo.split("/").slice(-1)[0] : null;
  return <PlusMenu onAttach={onAttach} onPickArtifact={onPickArtifact} attaching={attaching}
    role={role} onManageRepos={onManageRepos} repos={repos} chip={chip} chipLabel={chipLabel} />;
}

function PlusMenu({ onAttach, onPickArtifact, attaching, role, onManageRepos, repos, chip, chipLabel }: {
  onAttach: () => void;
  onPickArtifact?: (artifactId: string, filename: string) => void;
  attaching?: string | null;
  role: "owner" | "admin" | "member" | "viewer" | null;
  onManageRepos: () => void;
  repos: ReturnType<typeof useGithubRepos> | null;
  chip?: ReturnType<typeof resolveRepoChip>;
  chipLabel?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("root");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setView("root");
  };

  return (
    <div ref={wrapRef} className="relative flex min-w-0 max-w-full items-center">
      <ComposerIconButton
        onClick={() => {
          setView("root");
          setOpen((o) => !o);
        }}
        ariaLabel="Add to this message"
        title={repos ? "Attach a file or pick the GitHub repo" : "Attach a file or reuse an artifact"}
      >
        <Plus className="h-4 w-4 compact:h-[22px] compact:w-[22px]" aria-hidden />
      </ComposerIconButton>

      {chipLabel && chip && !chip.site && (
        <span className="ml-0.5 inline-flex h-7 min-w-0 max-w-[220px] items-center rounded-full bg-ink/[0.06] px-2.5 text-[13px] font-normal text-inkMuted transition-colors hover:bg-ink/[0.1]">
          <button
            type="button"
            onClick={() => {
              setView("repos");
              setOpen(true);
            }}
            title={`Agents work in ${chipLabel}. Click to change.`}
            className="inline-flex min-w-0 items-center gap-2 hover:text-ink"
          >
            <GhIcon className="h-3.5 w-3.5 shrink-0 compact:h-[18px] compact:w-[18px]" />
            <span className="truncate">{chipLabel}</span>
          </button>
        </span>
      )}

      {open && (
        <div className={SURFACE} role={view === "repos" ? "listbox" : "menu"}>
          <MenuBody
            view={view}
            setView={setView}
            role={role}
            repos={repos}
            onAttach={onAttach}
            onPickArtifact={onPickArtifact}
            attaching={attaching}
            onClose={close}
            onManageRepos={onManageRepos}
          />
        </div>
      )}
    </div>
  );
}
