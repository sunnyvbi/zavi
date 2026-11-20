"use client";

import { useState } from "react";
import type {
  GithubReposState,
  SetDefaultResult,
} from "@/lib/workspace/useGithubRepos";
import { NextChevron } from "@/components/ui/NextChevron";

function humanError(message: string): string {
  if (/selected repositories/i.test(message)) {
    return "That repo is outside your repo scope. Add it under 'Choose which repos Zavi can use' first.";
  }
  return message.replace(/^[a-z_]+:\s*/i, "");
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 6.5L5 9L9.5 3.5" />
    </svg>
  );
}

export function RepoPickerPanel({
  state,
  pending,
  canEdit,
  setDefault,
  onPicked,
  onManage,
}: {
  state: Extract<GithubReposState, { status: "ok" }>;
  pending: boolean;
  canEdit: boolean;
  setDefault: (repo: string) => Promise<SetDefaultResult>;
  onPicked: () => void;
  onManage: () => void;
}) {
  const [query, setQuery] = useState("");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const filtered =
    state.repos.length > 5 && query.trim()
      ? state.repos.filter((r) =>
          r.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : state.repos;

  return (
    <>
      {state.repos.length > 5 && (
        <div className="border-b border-rule p-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search repos…"
            className="w-full rounded-full border border-rule bg-cream px-3 py-1.5 text-[13px] text-ink outline-none transition-colors placeholder:text-inkLight focus:border-ink/30"
          />
        </div>
      )}

      <div className="max-h-[260px] overflow-y-auto py-1.5">
        {filtered.length === 0 && (
          <div className="px-3.5 py-2 text-[13px] text-inkMuted">
            No match.
          </div>
        )}
        {filtered.map((repo) => {
          const isDefault = repo === state.default;
          const rowDisabled = !canEdit || pending;
          return (
            <button
              key={repo}
              type="button"
              role="option"
              aria-selected={isDefault}
              aria-disabled={rowDisabled}
              disabled={rowDisabled}
              onClick={
                canEdit && !pending
                  ? async () => {
                      if (isDefault) {
                        onPicked();
                        return;
                      }
                      const r = await setDefault(repo);
                      if (r.ok) onPicked();
                      else setErrMsg(humanError(r.message));
                    }
                  : undefined
              }
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] leading-[18px] transition-colors ${
                canEdit && !pending
                  ? "cursor-pointer hover:bg-creamDeep/60"
                  : "cursor-default opacity-70"
              } ${isDefault ? "font-medium text-ink" : "font-normal text-inkSoft"}`}
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {isDefault ? <CheckIcon /> : null}
              </span>
              <span className="truncate">{repo}</span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-rule px-3.5 py-2 text-[12px] leading-[1.5]">
        {errMsg ? (
          <span className="text-coral">{errMsg}</span>
        ) : state.hiddenByScope > 0 ? (
          <button
            type="button"
            onClick={onManage}
            className="text-inkMuted hover:text-ink"
          >
            {state.hiddenByScope} repo{state.hiddenByScope === 1 ? "" : "s"}{" "}
            hidden by your repo scope. Manage <NextChevron />
          </button>
        ) : canEdit ? (
          <button
            type="button"
            onClick={onManage}
            className="text-inkMuted hover:text-ink"
          >
            Manage repos <NextChevron />
          </button>
        ) : (
          <span className="text-inkMuted">
            Only admins can change the default repo.
          </span>
        )}
      </div>
    </>
  );
}
