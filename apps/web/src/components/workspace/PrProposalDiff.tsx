"use client";

import { useState } from "react";

type FileChange = {
  path: string;
  action: "create" | "modify" | "delete" | string;
  diff?: string;
  content?: string;
};

type PendingEnvelope = {
  pending_pr_proposal?: boolean;
  files?: FileChange[];
  base_branch?: string;
  base_branches?: string[];
  head_branch?: string;
  risk_class?: string;
};

const ACTION_STYLE: Record<string, string> = {
  create: "bg-emerald-100 text-emerald-800",
  modify: "bg-amber-100 text-amber-800",
  delete: "bg-rose-100 text-rose-800",
};

function DiffLines({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="overflow-x-auto rounded-md bg-ink/[0.03] p-2 text-[12px] leading-[1.5]">
      {lines.map((ln, i) => {
        const isAdd = ln.startsWith("+") && !ln.startsWith("+++");
        const isDel = ln.startsWith("-") && !ln.startsWith("---");
        const isHdr =
          ln.startsWith("@@") || ln.startsWith("+++") || ln.startsWith("---");
        const cls = isAdd
          ? "text-emerald-700 bg-emerald-50"
          : isDel
            ? "text-rose-700 bg-rose-50"
            : isHdr
              ? "text-inkMuted"
              : "text-ink";
        return (
          <code key={i} className={`block whitespace-pre ${cls}`}>
            {ln || " "}
          </code>
        );
      })}
    </pre>
  );
}

export function PrProposalDiff({ envelope }: { envelope: unknown }) {
  const env = (envelope ?? {}) as PendingEnvelope;
  const [open, setOpen] = useState(false);
  if (env.pending_pr_proposal !== true) return null;
  const files = Array.isArray(env.files) ? env.files : [];
  if (files.length === 0) return null;

  const totalChanged = files.reduce((n, f) => {
    if (!f.diff) return n;
    for (const ln of f.diff.split("\n")) {
      if ((ln.startsWith("+") && !ln.startsWith("+++")) ||
          (ln.startsWith("-") && !ln.startsWith("---"))) n += 1;
    }
    return n;
  }, 0);

  return (
    <div className="mt-2 rounded-2xl border border-ink/10 bg-creamDeep/40 p-3 text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="font-medium text-ink">
          {open ? "▾" : "▸"} Review diff: {files.length} file
          {files.length === 1 ? "" : "s"}
          {totalChanged > 0 ? `, ${totalChanged} lines` : ""}
        </span>
        <span className="text-[12px] text-inkMuted">
          {Array.isArray(env.base_branches) && env.base_branches.length > 1
            ? `${env.base_branches.length} PRs → ${env.base_branches.join(", ")}`
            : env.head_branch && env.base_branch
              ? `${env.head_branch} → ${env.base_branch}`
              : ""}
          {env.risk_class ? ` · ${env.risk_class}` : ""}
        </span>
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-3">
          {files.map((f) => (
            <div key={f.path}>
              <div className="mb-1 flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase ${
                    ACTION_STYLE[f.action] ?? "bg-ink/10 text-inkMuted"
                  }`}
                >
                  {f.action}
                </span>
                <span className="font-mono text-[12px] text-ink break-all">
                  {f.path}
                </span>
              </div>
              {f.diff ? (
                <DiffLines diff={f.diff} />
              ) : (
                <p className="text-[12px] italic text-inkMuted">
                  (no preview: {f.action === "delete" ? "file removed" : "full content only"})
                </p>
              )}
            </div>
          ))}
          <p className="text-[12px] italic text-inkMuted">
            Reply <span className="font-medium not-italic">yes</span> in the chat
            to open this PR, or tell the agent what to adjust.
          </p>
        </div>
      )}
    </div>
  );
}
