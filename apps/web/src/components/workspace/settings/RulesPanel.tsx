"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Trash2, Check, X } from "lucide-react";
import { CHANNELS } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { agentDisplayName } from "@/lib/agentRegistry";
import { Switch } from "@/components/ui/Switch";
import { Skeleton } from "../Skeleton";
import { useWorkspace } from "../WorkspaceShell";
import { AdGuardSection } from "./AdGuardSection";
import { RulesCard } from "./RulesCard";

type ScopeKind = "all" | "agent" | "channel";
type Rule = {
  id: string;
  scope_kind: ScopeKind;
  scope_slug: string | null;
  text: string;
  status: "active" | "suggested";
  origin: string;
  created_by: string | null;
  approved_at: string | null;
  created_at: string;
  excerpt: string | null;
};
type RuleList = { role: string; suggestions_paused: boolean; rules: Rule[] };

const MAX = 280;
const CAP = 30;

const ORIGIN_LABEL: Record<string, string> = {
  chat_typed: "From a chat",
  slack_typed: "From Slack",
  cgo_email_reply: "From an email reply",
  cgo_slack_reply: "From a Slack reply",
  reject_reason: "From a rejected action",
  rules_page: "Added here",
  feedback_command: "From /feedback",
  imported_rules_tab: "From an agent's old Rules tab",
  moved_from_personalization: "Moved from Personalization",
};

function scopeKey(kind: ScopeKind, slug: string | null): string {
  return kind === "all" ? "all" : `${kind}:${slug}`;
}

function parseScope(key: string): { scope_kind: ScopeKind; scope_slug: string | null } {
  if (key === "all") return { scope_kind: "all", scope_slug: null };
  const i = key.indexOf(":");
  return { scope_kind: key.slice(0, i) as ScopeKind, scope_slug: key.slice(i + 1) };
}

function scopeLabel(r: { scope_kind: ScopeKind; scope_slug: string | null }): string {
  if (r.scope_kind === "all") return "All agents";
  if (r.scope_kind === "channel") {
    return CHANNELS.find((c) => c.slug === r.scope_slug)?.name ?? r.scope_slug ?? "";
  }
  return agentDisplayName(r.scope_slug ?? "");
}

function day(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

async function errorMessage(r: Response, fallback: string): Promise<string> {
  try {
    const j = (await r.json()) as { error?: { message?: string } };
    return j.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function RulesPanel() {
  const { role, treeAgents } = useWorkspace();
  const canManage = role === "owner" || role === "admin";
  const canSuggest = canManage || role === "member";

  const [data, setData] = useState<RuleList | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftScope, setDraftScope] = useState("all");
  const [editing, setEditing] = useState<{ id: string; text: string; scope: string } | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/rules");
      if (!r.ok) throw new Error(String(r.status));
      setData((await r.json()) as RuleList);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scopeOptions = useMemo(() => {
    const agents = (treeAgents ?? [])
      .map((a) => a.slug)
      .filter((s) => !CHANNELS.some((c) => c.slug === s))
      .map((s) => ({ key: `agent:${s}`, label: agentDisplayName(s) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const channels = CHANNELS.map((c) => ({ key: `channel:${c.slug}`, label: c.name }));
    return { agents, channels };
  }, [treeAgents]);

  const act = useCallback(
    async (path: string, init: RequestInit, fallback: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await apiFetch(path, {
          ...init,
          headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
        });
        if (!r.ok) {
          setError(await errorMessage(r, fallback));
          return false;
        }
        await load();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    const ok = await act(
      "/api/rules",
      { method: "POST", body: JSON.stringify({ text, ...parseScope(draftScope) }) },
      "Could not save the rule.",
    );
    if (ok) setDraft("");
  };

  const saveEdit = async () => {
    if (!editing) return;
    const ok = await act(
      `/api/rules/${editing.id}`,
      { method: "PATCH", body: JSON.stringify({ text: editing.text.trim(), ...parseScope(editing.scope) }) },
      "Could not save the change.",
    );
    if (ok) setEditing(null);
  };

  if (!data && !loadFailed) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full rounded-block" />
        <Skeleton className="h-40 w-full rounded-block" />
      </div>
    );
  }

  const active = data?.rules.filter((r) => r.status === "active") ?? [];
  const pending = data?.rules.filter((r) => r.status === "suggested") ?? [];

  const scopeSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={busy}
      className="rounded-xl border border-[#e8e8e8] bg-white px-2.5 py-2 text-[13px] text-[#0e0f11]"
    >
      <option value="all">All agents</option>
      {scopeOptions.agents.length > 0 && (
        <optgroup label="One agent">
          {scopeOptions.agents.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="One channel">
        {scopeOptions.channels.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </optgroup>
    </select>
  );

  return (
    <div className="space-y-4">
      {loadFailed && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-[#f9f9f9] px-3 py-2.5">
          <span className="text-[13px] text-[#595959]">Could not load your rules.</span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 rounded-cta px-2 py-1 text-[13px] font-medium text-[#0e0f11] hover:bg-white"
          >
            Retry
          </button>
        </div>
      )}

      {}
      <RulesCard>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[14px] font-semibold text-[#0e0f11]">Active rules</h3>
          <span className="text-[12px] text-[#8a8a8a]">
            {active.length} of {CAP}
          </span>
        </div>
        <p className="mt-1 text-[13px] leading-[1.6] text-[#595959]">
          Every agent a rule applies to follows it from its next run. A rule never approves a
          change or spends money on its own.
        </p>
        {active.length === 0 ? (
          <p className="mt-4 rounded-xl bg-[#f9f9f9] px-3 py-2.5 text-[13px] text-[#595959]">
            No rules yet. {canSuggest ? "Add one below, or type /feedback in any agent's chat." : ""}
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {active.map((r) =>
              editing?.id === r.id ? (
                <li key={r.id} className="rounded-xl bg-[#f9f9f9] px-3 py-2.5">
                  <textarea
                    aria-label="Edit rule"
                    value={editing.text}
                    maxLength={MAX}
                    rows={2}
                    onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                    className="w-full resize-none rounded-lg border border-[#e8e8e8] bg-white px-2.5 py-2 text-[13px]"
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {scopeSelect(editing.scope, (v) => setEditing({ ...editing, scope: v }), "Applies to")}
                    <button
                      type="button"
                      onClick={() => void saveEdit()}
                      disabled={busy || !editing.text.trim()}
                      className="rounded-cta bg-[#0e0f11] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="rounded-cta px-3 py-1.5 text-[13px] text-[#595959] hover:bg-white"
                    >
                      Cancel
                    </button>
                  </div>
                </li>
              ) : (
                <li key={r.id} className="flex items-start justify-between gap-3 rounded-xl bg-[#f9f9f9] px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-[#0e0f11]">{r.text}</p>
                    <p className="mt-0.5 text-[12px] text-[#8a8a8a]">
                      {scopeLabel(r)} · {ORIGIN_LABEL[r.origin] ?? "Saved"} · {day(r.approved_at ?? r.created_at)}
                    </p>
                    {r.excerpt && (
                      <p className="mt-1 text-[12px] italic text-[#8a8a8a]">&ldquo;{r.excerpt}&rdquo;</p>
                    )}
                  </div>
                  {canManage && (
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        aria-label={`Edit rule: ${r.text}`}
                        onClick={() => setEditing({ id: r.id, text: r.text, scope: scopeKey(r.scope_kind, r.scope_slug) })}
                        disabled={busy}
                        className="rounded-cta p-1 text-[#595959] hover:bg-white disabled:opacity-40"
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete rule: ${r.text}`}
                        onClick={() => void act(`/api/rules/${r.id}`, { method: "DELETE" }, "Could not delete the rule.")}
                        disabled={busy}
                        className="rounded-cta p-1 text-[#595959] hover:bg-white hover:text-[#cb2029] disabled:opacity-40"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                  )}
                </li>
              ),
            )}
          </ul>
        )}

        {canSuggest && (
          <div className="mt-4 border-t border-[#f6f6f6] pt-4">
            <label htmlFor="new-rule" className="text-[14px] font-medium text-[#0e0f11]">
              {canManage ? "Add a rule" : "Suggest a rule"}
            </label>
            <textarea
              id="new-rule"
              value={draft}
              maxLength={MAX}
              rows={2}
              placeholder="For example: Never post on weekends."
              onChange={(e) => setDraft(e.target.value)}
              className="mt-1.5 w-full resize-none rounded-xl border border-[#e8e8e8] bg-white px-3 py-2 text-[13px]"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {scopeSelect(draftScope, setDraftScope, "Applies to")}
              <button
                type="button"
                onClick={() => void add()}
                disabled={busy || !draft.trim()}
                className="rounded-cta bg-[#0e0f11] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40"
              >
                {canManage ? "Save rule" : "Suggest to your admin"}
              </button>
              <span className="text-[12px] text-[#8a8a8a]">
                {draft.length}/{MAX}
              </span>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-2 text-[12px] text-[#cb2029]">
            {error}
          </p>
        )}
      </RulesCard>

      {}
      <RulesCard>
        <h3 className="text-[14px] font-semibold text-[#0e0f11]">Waiting for approval</h3>
        <p className="mt-1 text-[13px] leading-[1.6] text-[#595959]">
          {canManage
            ? "Suggestions from your team and from what you told Zavi. Nothing here is followed until you save it."
            : "An owner or admin decides which of these become rules."}
        </p>
        {pending.length === 0 ? (
          <p className="mt-4 rounded-xl bg-[#f9f9f9] px-3 py-2.5 text-[13px] text-[#595959]">
            Nothing waiting.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {pending.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 rounded-xl bg-[#f9f9f9] px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-[#0e0f11]">{r.text}</p>
                  <p className="mt-0.5 text-[12px] text-[#8a8a8a]">
                    {scopeLabel(r)} · {ORIGIN_LABEL[r.origin] ?? "Suggested"} · {day(r.created_at)}
                  </p>
                  {r.excerpt && (
                    <p className="mt-1 text-[12px] italic text-[#8a8a8a]">&ldquo;{r.excerpt}&rdquo;</p>
                  )}
                </div>
                {canManage && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => void act(`/api/rules/${r.id}/activate`, { method: "POST" }, "Could not save the rule.")}
                      disabled={busy}
                      className="flex items-center gap-1 rounded-cta bg-[#0e0f11] px-2.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden /> Save rule
                    </button>
                    <button
                      type="button"
                      onClick={() => void act(`/api/rules/${r.id}/dismiss`, { method: "POST" }, "Could not dismiss it.")}
                      disabled={busy}
                      className="flex items-center gap-1 rounded-cta px-2.5 py-1.5 text-[12px] text-[#595959] hover:bg-white disabled:opacity-40"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden /> Not a rule
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </RulesCard>

      <AdGuardSection canManage={canManage} />

      {canManage && data && (
        <RulesCard>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[14px] font-semibold text-[#0e0f11]">Pause suggestions</h3>
              <p className="mt-1 text-[13px] text-[#595959]">
                Zavi stops offering to keep things you say as rules. Your saved rules still apply.
              </p>
            </div>
            <Switch
              checked={data.suggestions_paused}
              disabled={busy}
              label="Pause suggestions"
              onCheckedChange={(v) =>
                void act(
                  "/api/rules/settings",
                  { method: "PUT", body: JSON.stringify({ suggestions_paused: v }) },
                  "Could not change this.",
                )
              }
            />
          </div>
          <div className="mt-4 border-t border-[#f6f6f6] pt-4">
            {confirmDeleteAll ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-[#0e0f11]">
                  Delete every rule and suggestion? This cannot be undone.
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    await act("/api/rules", { method: "DELETE" }, "Could not delete your rules.");
                    setConfirmDeleteAll(false);
                  }}
                  disabled={busy}
                  className="rounded-cta bg-[#cb2029] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
                >
                  Delete all
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteAll(false)}
                  className="rounded-cta px-3 py-1.5 text-[13px] text-[#595959] hover:bg-[#f9f9f9]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDeleteAll(true)}
                disabled={busy || (data.rules.length === 0)}
                className="text-[13px] font-medium text-[#cb2029] disabled:opacity-40"
              >
                Delete all rules
              </button>
            )}
          </div>
        </RulesCard>
      )}

      {!canSuggest && (
        <p className="px-1 text-[12px] text-[#595959]">Viewers can read the rules but not add or change them.</p>
      )}
    </div>
  );
}
