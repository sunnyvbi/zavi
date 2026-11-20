"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { ComposerIconButton } from "../ModeComposer";
import { RepoPickerPanel } from "../RepoPickerPanel";
import { ChannelPickerPanel, channelConnectHref } from "../ChannelPicker";
import { useGithubRepos } from "@/lib/workspace/useGithubRepos";
import { useBuildSessions } from "@/lib/workspace/useBuildSessions";
import { resolveRepoChip } from "@/lib/workspace/siteRepoChip";
import {
  attachBuildFigmaFrame,
  clearBuildFigmaFrame,
  dismissBuildFigmaNote,
  useBuildFigmaFrame,
  useFigmaConnection,
} from "@/lib/workspace/buildFigmaFrame";

const SURFACE =
  "absolute bottom-full left-0 z-30 mb-2 w-[340px] max-w-[80vw] overflow-hidden rounded-2xl border border-rule bg-white shadow-elevMd";
const ROW =
  "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-normal leading-[18px] text-ink hover:bg-creamDeep/60";
const LABEL = "px-3.5 pb-1 pt-1.5 text-[11px] font-normal text-inkMuted";

type View = "root" | "repos" | "channels" | "figma";

function GhIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={className} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function FigmaIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <path d="M5.5 1.5h2.5v4.3H5.5a2.15 2.15 0 0 1 0-4.3zM8 1.5h2.5a2.15 2.15 0 0 1 0 4.3H8zM5.5 5.8H8v4.3H5.5a2.15 2.15 0 0 1 0-4.3zM5.5 10.1H8v2.15a2.15 2.15 0 1 1-2.5-2.15z" />
      <circle cx="10.4" cy="7.95" r="2.15" />
    </svg>
  );
}

function Chevron({ className, dir = "right" }: { className?: string; dir?: "right" | "left" }) {
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

export function BuildComposerMenu({
  selectedChannels,
  onToggleChannel,
  role,
  onManageConnectors,
  sessionId = null,
}: {
  selectedChannels: string[];
  onToggleChannel: (slug: string) => void;
  role: "owner" | "admin" | "member" | "viewer" | null;
  onManageConnectors: () => void;
  sessionId?: string | null;
}) {
  const repos = useGithubRepos();
  const buildSessions = useBuildSessions();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("root");
  const [figmaLink, setFigmaLink] = useState("");
  const [figmaError, setFigmaError] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const figmaHandoff = buildSessions.uiFlags?.figmaHandoff === true && !sessionId;
  const figma = useBuildFigmaFrame();
  const figmaConnection = useFigmaConnection(open && figmaHandoff);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
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

  const close = () => {
    setOpen(false);
    setView("root");
  };

  const { state, pending, setDefault } = repos;
  const canEdit = role === "owner" || role === "admin";
  const ok = state.status === "ok" ? state : null;
  const chip = resolveRepoChip({ kind: "build", sessionId }, buildSessions, ok?.connected ? ok.default : null);
  const activeRepo = chip.repo;
  const hasRepos = !!ok?.connected && (ok?.repos.length ?? 0) > 0;
  const goManage = () => {
    close();
    onManageConnectors();
  };
  const openFigma = () => {
    if (figmaConnection === "not_connected") {
      goManage();
      return;
    }
    setFigmaLink(figma.frame?.link ?? "");
    setFigmaError(false);
    setView("figma");
  };
  const attachFigma = () => {
    if (!attachBuildFigmaFrame(figmaLink)) {
      setFigmaError(true);
      return;
    }
    close();
  };

  return (
    <div ref={wrapRef} className="relative flex items-center">
      <ComposerIconButton
        onClick={() => {
          setView("root");
          setOpen((o) => !o);
        }}
        ariaLabel="Add to this build"
        title="Pick channels, the GitHub repo or a Figma frame"
      >
        <Plus className="h-4 w-4" aria-hidden />
        {figmaHandoff && figma.frame && (
          <span
            data-figma-attached
            aria-hidden
            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-ink"
          />
        )}
      </ComposerIconButton>

      {!open && figma.note && (
        <div
          role="status"
          data-figma-note
          className="absolute bottom-full left-0 z-30 mb-2 flex w-[320px] max-w-[80vw] items-start gap-2 rounded-[12px] border border-rule bg-cream px-3 py-2 text-[12px] leading-[16px] text-ink shadow-elevMd"
        >
          <FigmaIcon className="mt-px h-3.5 w-3.5 shrink-0 text-inkMuted" />
          <span className="min-w-0 flex-1">{figma.note}</span>
          <button
            type="button"
            onClick={dismissBuildFigmaNote}
            className="shrink-0 text-[11px] text-inkMuted hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      )}

      {open && (
        <div className={SURFACE} role="menu">
          {view === "root" && (
            <div className="py-1.5">
              <div className={LABEL}>Add to this build</div>
              <button
                type="button"
                role="menuitem"
                className={ROW}
                onClick={() => setView("channels")}
              >
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  className="h-3.5 w-3.5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" />
                  <circle cx="5" cy="19" r="1.5" />
                </svg>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>Socials &amp; Ads</span>
                  <span className="truncate text-[12px] leading-[16px] text-inkMuted">
                    {selectedChannels.length > 0
                      ? `${selectedChannels.length} selected`
                      : "None selected"}
                  </span>
                </span>
                <Chevron className="ml-auto h-3 w-3 shrink-0 opacity-60" />
              </button>
              {chip.site ? (
                <div role="menuitem" aria-disabled="true" data-site-repo-chip={activeRepo ?? ""} className={ROW}>
                  <GhIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>GitHub repo</span>
                    <span className="truncate text-[12px] leading-[16px] text-inkMuted">
                      {activeRepo ?? "Each site has its own repo"}
                    </span>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className={ROW}
                  onClick={() => (hasRepos ? setView("repos") : goManage())}
                >
                  <GhIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>GitHub repo</span>
                    <span className="truncate text-[12px] leading-[16px] text-inkMuted">
                      {state.status === "loading"
                        ? "Loading…"
                        : state.status === "error"
                          ? "Couldn’t load repos"
                          : !ok?.connected
                            ? "Not connected"
                            : (activeRepo ?? "No repo selected")}
                    </span>
                  </span>
                  <Chevron className="ml-auto h-3 w-3 shrink-0 opacity-60" />
                </button>
              )}
              {figmaHandoff && (
                <button
                  type="button"
                  role="menuitem"
                  data-figma-row
                  className={ROW}
                  onClick={openFigma}
                >
                  <FigmaIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>Figma frame</span>
                    <span className="truncate text-[12px] leading-[16px] text-inkMuted">
                      {figma.frame
                        ? `Frame ${figma.frame.ref.node_id} attached`
                        : figmaConnection === "loading"
                          ? "Loading…"
                          : figmaConnection === "not_connected"
                            ? "Not connected"
                            : "Build from a design link"}
                    </span>
                  </span>
                  <Chevron className="ml-auto h-3 w-3 shrink-0 opacity-60" />
                </button>
              )}
            </div>
          )}

          {view === "figma" && (
            <>
              <button
                type="button"
                onClick={() => setView("root")}
                className="flex w-full items-center gap-2 border-b border-rule px-3.5 py-2 text-left text-[11px] font-normal text-inkMuted transition-colors hover:text-ink"
              >
                <Chevron className="h-3 w-3" dir="left" />
                Build from a Figma frame
              </button>
              <form
                className="flex flex-col gap-2 px-3.5 py-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  attachFigma();
                }}
              >
                <label htmlFor="build-figma-link" className="text-[12px] leading-[16px] text-inkMuted">
                  Paste a figma.com link to a frame. In Figma, right-click the frame and copy its link.
                </label>
                <input
                  id="build-figma-link"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  value={figmaLink}
                  onChange={(e) => {
                    setFigmaLink(e.target.value);
                    setFigmaError(false);
                  }}
                  placeholder="https://www.figma.com/design/…?node-id=…"
                  aria-invalid={figmaError}
                  className="w-full rounded-[12px] border border-rule bg-cream px-3 py-2 text-[13px] leading-[18px] text-ink placeholder:text-inkMuted focus:border-ink focus:outline-none"
                />
                {figmaError && (
                  <p role="alert" className="text-[12px] leading-[16px] text-ink">
                    That is not a figma.com frame link. It needs node-id in it.
                  </p>
                )}
                <div className="flex items-center justify-end gap-2">
                  {figma.frame && (
                    <button
                      type="button"
                      onClick={() => {
                        clearBuildFigmaFrame();
                        close();
                      }}
                      className="rounded-[12px] px-3 py-1.5 text-[12px] text-inkMuted hover:text-ink"
                    >
                      Remove
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={!figmaLink.trim()}
                    className="rounded-[12px] bg-ink px-3 py-1.5 text-[12px] text-cream disabled:opacity-40"
                  >
                    Attach frame
                  </button>
                </div>
              </form>
            </>
          )}

          {view === "channels" && (
            <>
              <button
                type="button"
                onClick={() => setView("root")}
                className="flex w-full items-center gap-2 border-b border-rule px-3.5 py-2 text-left text-[11px] font-normal text-inkMuted transition-colors hover:text-ink"
              >
                <Chevron className="h-3 w-3" dir="left" />
                Channels this build is for
              </button>
              <ChannelPickerPanel
                selected={selectedChannels}
                onToggle={onToggleChannel}
                onConnect={(option) => {
                  close();
                  window.open(
                    channelConnectHref(option),
                    "_blank",
                    "noopener,noreferrer",
                  );
                }}
              />
            </>
          )}

          {view === "repos" && (
            <>
              <button
                type="button"
                onClick={() => setView("root")}
                className="flex w-full items-center gap-2 border-b border-rule px-3.5 py-2 text-left text-[11px] font-normal text-inkMuted transition-colors hover:text-ink"
              >
                <Chevron className="h-3 w-3" dir="left" />
                Agents work in this repo
              </button>
              {ok && hasRepos ? (
                <RepoPickerPanel
                  state={ok}
                  pending={pending}
                  canEdit={canEdit}
                  setDefault={setDefault}
                  onPicked={close}
                  onManage={goManage}
                />
              ) : (
                <button type="button" onClick={goManage} className={ROW}>
                  <GhIcon className="h-3.5 w-3.5 shrink-0" />
                  {ok?.connected ? "Manage GitHub repos" : "Connect GitHub"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
