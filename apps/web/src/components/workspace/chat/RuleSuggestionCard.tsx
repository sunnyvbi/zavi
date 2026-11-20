"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { agentDisplayName } from "@/lib/agentRegistry";
import type { RuleSuggestion } from "@/lib/workspace/ruleSuggestion";
import { useWorkspace } from "../WorkspaceShell";
import { useOpenStatic } from "../layout/shared";

type Phase = "pending" | "busy" | "saved" | "dismissed" | "gone" | "failed";

export function RuleSuggestionCard({ card }: { card: RuleSuggestion }) {
  const { role } = useWorkspace();
  const openStatic = useOpenStatic();
  const canManage = role === "owner" || role === "admin";
  const [phase, setPhase] = useState<Phase>("pending");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(card.text);
  const [scope, setScope] = useState<"all" | "agent">(card.scope_kind === "agent" ? "agent" : "all");
  const thisAgent = card.agent_slug;

  const call = async (path: string, init: RequestInit, done: Phase) => {
    setPhase("busy");
    setError(null);
    try {
      const res = await apiFetch(path, { ...init, headers: { "Content-Type": "application/json" } });
      const body = (await res.json().catch(() => ({}))) as { status?: string; error?: { message?: string } };
      if (res.status === 404) return setPhase("gone");
      if (!res.ok) {
        setError(body.error?.message ?? "Something went wrong. Try again.");
        return setPhase("failed");
      }
      if (body.status === "not_pending" || body.status === "source_edited") return setPhase("gone");
      setPhase(done);
    } catch {
      setError("Something went wrong. Try again.");
      setPhase("failed");
    }
  };

  const save = () => {
    const changed = text.trim() !== card.text || (scope === "agent") !== (card.scope_kind === "agent");
    if (!changed) return call(`/api/rules/${card.rule_id}/activate`, { method: "POST" }, "saved");
    return call(
      `/api/rules/${card.rule_id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          text: text.trim(),
          scope_kind: scope,
          scope_slug: scope === "agent" ? thisAgent : null,
        }),
      },
      "saved",
    );
  };

  const shell = "mt-2 rounded-xl border border-ink/10 bg-white px-4 py-3 text-[13px]";

  if (phase === "saved" || phase === "dismissed" || phase === "gone") {
    return (
      <div className={shell}>
        <p className="text-inkMuted">
          {phase === "saved"
            ? "Saved as a rule. Your agents follow it from their next run."
            : phase === "dismissed"
              ? "Okay, not a rule."
              : "This suggestion was already handled."}{" "}
          <button
            type="button"
            onClick={() => openStatic("settings", { section: "rules" })}
            className="font-medium text-ink underline underline-offset-2"
          >
            See rules
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className={shell}>
      <p className="text-[12px] font-medium text-inkMuted">Keep this as a rule?</p>
      {editing ? (
        <textarea
          aria-label="Rule text"
          value={text}
          maxLength={280}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          className="mt-1.5 w-full resize-none rounded-lg border border-ink/10 px-2.5 py-2 text-[13px]"
        />
      ) : (
        <p className="mt-1 text-ink">&ldquo;{text}&rdquo;</p>
      )}

      {canManage ? (
        <>
          {thisAgent && (
            <div className="mt-2 flex items-center gap-2 text-[12px] text-inkMuted">
              <span>For:</span>
              <select
                aria-label="Applies to"
                value={scope}
                onChange={(e) => setScope(e.target.value as "all" | "agent")}
                disabled={phase === "busy"}
                className="rounded-lg border border-ink/10 bg-white px-2 py-1 text-[12px] text-ink"
              >
                <option value="all">All agents</option>
                <option value="agent">{agentDisplayName(thisAgent)} only</option>
              </select>
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={phase === "busy" || !text.trim()}
              className="rounded-cta bg-ink px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
            >
              Save rule
            </button>
            {!editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                disabled={phase === "busy"}
                className="rounded-cta px-3 py-1.5 text-[12px] text-ink hover:bg-bone"
              >
                Edit
              </button>
            )}
            <button
              type="button"
              onClick={() => void call(`/api/rules/${card.rule_id}/dismiss`, { method: "POST" }, "dismissed")}
              disabled={phase === "busy"}
              className="rounded-cta px-3 py-1.5 text-[12px] text-inkMuted hover:bg-bone"
            >
              Not a rule
            </button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-[12px] text-inkMuted">
          Sent to your admin. An owner or admin can turn it on in Settings → Rules.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}
