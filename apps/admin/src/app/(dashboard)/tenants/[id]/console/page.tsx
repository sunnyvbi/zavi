"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { adminApiFetch } from "@/lib/api-admin";
import {
  TenantBackLink,
  TenantLabel,
  type TenantIdentity,
} from "@/components/admin/TenantIdentity";

type ThreadMsg = {
  id: string;
  sender_role: string;
  body: string;
  meta: Record<string, unknown> | null;
  agent_run_id: string | null;
  created_at: string;
};
type ThreadRun = {
  id: string;
  status: string;
  agent_slug: string;
  trigger: string;
  enqueued_at: string;
};
type Decision = {
  id: string;
  agent_run_id: string | null;
  decision_class: string | null;
  status: string;
  body: Record<string, unknown> | null;
  approved_by_source: string | null;
  emitted_at: string;
};
type ThreadResp = {
  thread: { id: string; title: string | null; created_at: string; last_message_at: string; deleted: boolean };
  messages: ThreadMsg[];
  runs: ThreadRun[];
  decisions: Decision[];
};

const TERMINAL_RUN = new Set([
  "success",
  "failed",
  "cancelled",
  "parse_failed",
  "dispatch_error",
  "paused_awaiting_approval",
  "paused_awaiting_child",
]);
const isTerminal = (s: string) => TERMINAL_RUN.has(s.toLowerCase());

const FAILED_RUN = new Set(["failed", "parse_failed", "dispatch_error"]);
const runFailureNote = (s: string): string | null => {
  const k = s.toLowerCase();
  if (!FAILED_RUN.has(k)) return null;
  if (k === "dispatch_error") return "The operator run could not be dispatched.";
  if (k === "parse_failed") return "The operator replied, but its response could not be parsed.";
  return "The operator run failed.";
};

const isRed = (d: Decision): boolean =>
  (d.body as { approval_class?: unknown } | null)?.approval_class === "ship_red";

const INTERNAL_CLASS_RE =
  /(^|[._])(note|notetaker|brain|memory|summary|summarize|draft|recommendation|advisory|advice)([._]|$)/i;
const EXTERNAL_BODY_RE =
  /(stripe|refund|payout|charge|invoice|amount|money|budget|spend|slack|email|gmail|\bmeta\b|ad[_ ]?set|campaign|publish|\bpost\b|\bsend\b|message|github|open_pr|webhook|sso|\brole\b|permission|token)/i;

function isDestructive(d: Decision): boolean {
  const cls = d.decision_class ?? "";
  if (!INTERNAL_CLASS_RE.test(cls)) return true;
  return EXTERNAL_BODY_RE.test(JSON.stringify(d.body ?? {}));
}

function classTag(d: Decision): { label: string; danger: boolean } {
  if (!isDestructive(d)) return { label: "internal", danger: false };
  const cls = d.decision_class ?? "";
  if (/refund|stripe|payout|charge|invoice|money|budget|spend/i.test(cls)) return { label: "money", danger: true };
  if (/auth|sso|\brole\b|permission|access/i.test(cls)) return { label: "auth", danger: true };
  return { label: "connector write", danger: true };
}

function reversibility(d: Decision): { label: string; tone: "good" | "warn" | "bad" } | null {
  const ev = (d.body as { decision_evidence?: { reversibility?: unknown } } | null)?.decision_evidence;
  const raw = typeof ev?.reversibility === "string" ? ev.reversibility.trim().toLowerCase() : "";
  if (!raw) return null;
  if (raw === "irreversible") return { label: "irreversible", tone: "bad" };
  if (raw === "reversible_with_cost") return { label: "reversible with cost", tone: "warn" };
  if (raw === "reversible") return { label: "reversible", tone: "good" };
  return { label: raw.replace(/_/g, " "), tone: "warn" };
}

function decisionTitle(d: Decision): string {
  const b = (d.body ?? {}) as Record<string, unknown>;
  for (const k of ["title", "summary", "headline", "description", "action"]) {
    const v = b[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return d.decision_class ?? "Proposed action";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isChatRun = (r: ThreadRun) => r.trigger === "chat";

class UnusableThreadError extends Error {}

function digest(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function chatErrorMessage(status: number, code?: string, msg?: string): string {
  switch (code) {
    case "slug_not_allowed":
      return "This console can only run the operator agent.";
    case "invalid_body":
      return "The message is empty or too long.";
    case "tenant_not_operable":
      return "The console operates on customer tenants only.";
    case "rate_limited":
      return "Too many messages. Slow down and retry.";
    case "budget_exceeded":
      return "This tenant is over its run budget right now.";
    case "insufficient_credits":
    case "build_credits_exhausted":
      return "This tenant is out of credits.";
    case "fleet_halted":
      return "The fleet is halted; chat is paused.";
    case "duplicate_dispatch":
    case "in_progress":
      return "That message is already being processed.";
    case "run_in_flight":
      return "The operator is still working on this thread. Wait for it to finish before sending again.";
    case "invalid_thread_id":
      return "That conversation link is malformed.";
    default:
      return msg || `Send failed (HTTP ${status}).`;
  }
}

export default function ConsolePage() {
  const params = useParams<{ id: string }>();
  const tenantId = params?.id ?? "";

  const [tenant, setTenant] = useState<TenantIdentity | null>(null);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadResp | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [working, setWorking] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSend, setPendingSend] = useState<string | null>(null);
  const [modalDecision, setModalDecision] = useState<Decision | null>(null);

  const pollToken = useRef(0);
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => void pollToken.current++, []);

  const startNewThread = useCallback(() => {
    pollToken.current++;
    setThreadId(null);
    setThread(null);
    setPendingSend(null);
    setWorking(false);
    setError(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("thread");
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const fromUrl = new URLSearchParams(window.location.search).get("thread");
    if (!fromUrl) return;
    if (UUID_RE.test(fromUrl)) {
      setThreadId(fromUrl);
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("thread");
    window.history.replaceState(null, "", url.toString());
    setError("That conversation link was malformed — started a new conversation instead.");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !threadId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("thread") === threadId) return;
    url.searchParams.set("thread", threadId);
    window.history.replaceState(null, "", url.toString());
  }, [threadId]);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/tenants/${tenantId}`);
        const b = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setTenantError(b?.error?.message || `Could not load this tenant (HTTP ${res.status}).`);
          return;
        }
        setTenant(b.tenant as TenantIdentity);
        setTenantError(null);
      } catch (e) {
        if (!cancelled) setTenantError((e as Error).message || "Could not load this tenant.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, working]);

  const fetchThread = useCallback(
    async (tid: string): Promise<ThreadResp> => {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/agents/operator/threads/${tid}`);
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (b?.error?.message as string) || `Could not load the conversation (HTTP ${res.status}).`;
        if (res.status === 400 || res.status === 403 || res.status === 404) {
          throw new UnusableThreadError(msg);
        }
        throw new Error(msg);
      }
      return b as ThreadResp;
    },
    [tenantId],
  );

  const pollThread = useCallback(
    async (tid: string, watchRunId?: string) => {
      const token = ++pollToken.current;
      const started = Date.now();
      const CEILING_MS = 15 * 60_000;
      let consecutiveErrors = 0;
      let delay = 1500;

      while (pollToken.current === token && Date.now() - started < CEILING_MS) {
        try {
          const resp = await fetchThread(tid);
          if (pollToken.current !== token) return;
          consecutiveErrors = 0;
          setThread(resp);
          setPendingSend(null);
          setError(null);

          const runs = (resp.runs ?? []).filter(isChatRun);
          const watched = watchRunId ? runs.find((r) => r.id === watchRunId) : runs[runs.length - 1];

          if (!watched) {
            if (watchRunId) {
              setWorking(true);
            } else {
              setWorking(false);
              return;
            }
          } else {
            const done = isTerminal(watched.status);
            setWorking(!done);
            if (done) {
              const note = runFailureNote(watched.status);
              if (note) setError(note);
              return;
            }
          }
        } catch (e) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= 3) {
            setError((e as Error).message);
            setWorking(false);
            return;
          }
        }
        await sleep(delay);
        delay = Math.min(delay * 1.25, 5000);
      }

      if (pollToken.current === token) {
        setWorking(false);
        setError("Stopped watching this run after 15 minutes. Reload to see where it landed.");
      }
    },
    [fetchThread],
  );

  useEffect(() => {
    if (!threadId || !tenantId) return;
    let cancelled = false;
    setLoadingThread(true);
    (async () => {
      try {
        const resp = await fetchThread(threadId);
        if (cancelled) return;
        setThread(resp);
        setError(null);
        const chatRuns = (resp.runs ?? []).filter(isChatRun);
        const last = chatRuns[chatRuns.length - 1];
        if (last && !isTerminal(last.status)) void pollThread(threadId, last.id);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof UnusableThreadError) {
          startNewThread();
          setError(`${e.message} Started a new conversation.`);
          return;
        }
        setError((e as Error).message);
      } finally {
        if (!cancelled) setLoadingThread(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, tenantId, fetchThread]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || working) return;
    setSending(true);
    setError(null);
    setPendingSend(text);
    setDraft("");
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/agents/operator/chat`, {
        method: "POST",
        headers: { "Idempotency-Key": `${threadId ?? "new"}:${digest(text)}` },
        body: JSON.stringify(threadId ? { message: text, thread_id: threadId } : { message: text }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 404 || res.status === 400 || res.status === 403) {
          startNewThread();
          setDraft(text);
          setError("That conversation is no longer available. Started a new one — send again.");
          return;
        }
        throw new Error(chatErrorMessage(res.status, b?.error?.code, b?.error?.message));
      }
      setThreadId(b.thread_id);
      setWorking(true);
      void pollThread(b.thread_id as string, b.run_id as string | undefined);
    } catch (e) {
      setPendingSend(null);
      setDraft((d) => (d.trim() ? d : text));
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const closeModal = useCallback(() => setModalDecision(null), []);

  const onExecuted = useCallback(() => {
    setModalDecision(null);
    if (threadId) void pollThread(threadId);
  }, [threadId, pollThread]);

  const messages = thread?.messages ?? [];
  const decisions = thread?.decisions ?? [];
  const decisionsByRun = new Map<string, Decision[]>();
  for (const d of decisions) {
    const k = d.agent_run_id ?? "__none__";
    (decisionsByRun.get(k) ?? decisionsByRun.set(k, []).get(k)!).push(d);
  }
  const rendered = new Set<string>();

  return (
    <div className="max-w-3xl mx-auto p-6">
      <TenantBackLink tenantId={tenantId} tenant={tenant} />
      <div className="mt-2 mb-4">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Agent console</h1>
        <p className="text-sm text-slate-500 mt-1">
          <TenantLabel tenantId={tenantId} tenant={tenant} /> · chatting the <strong>operator</strong> agent
        </p>
      </div>

      {}
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <a href={`/tenants/${tenantId}`} className="rounded px-2 py-0.5 bg-slate-100 text-slate-600 hover:bg-slate-200">
          Overview
        </a>
        <a href={`/tenants/${tenantId}/coverage`} className="rounded px-2 py-0.5 bg-slate-100 text-slate-600 hover:bg-slate-200">
          Coverage
        </a>
        <a href={`/tenants/${tenantId}/billing`} className="rounded px-2 py-0.5 bg-slate-100 text-slate-600 hover:bg-slate-200">
          Credits &amp; pricing
        </a>
        <span className="rounded px-2 py-0.5 bg-slate-900 text-white">Agent console</span>
        {threadId && (
          <button
            type="button"
            onClick={startNewThread}
            className="ml-auto rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            + New conversation
          </button>
        )}
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 mb-3">
        You are acting as staff on this customer&apos;s live data. Proposed writes auto-queue to the customer for
        approval. &ldquo;Execute directly&rdquo; runs the write now, on their behalf, and is WORM-audited.
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-3">
          {error}
        </div>
      )}

      {}
      {tenantError && (
        <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 mb-3">
          Could not load this tenant ({tenantError}). Chat still works; &ldquo;Execute directly&rdquo; is unavailable
          until it loads.
        </div>
      )}

      {}
      <div className="glass-card overflow-hidden">
        <div ref={threadRef} className="max-h-[52vh] overflow-y-auto px-4 py-4 space-y-3 bg-white/40">
          {}
          {messages.length === 0 && !pendingSend && !working && !loadingThread ? (
            <div className="py-10 text-center text-sm text-slate-400">
              Ask the operator anything about {tenant?.display_name ?? "this tenant"}, or point it at something to fix.
              <br />
              Proposed writes land in the customer&apos;s approval queue; you can override with Execute directly.
            </div>
          ) : (
            messages.map((m) => {
              const isStaff = m.sender_role === "user";
              const isSystem = m.sender_role === "system";
              const runDecisions = m.agent_run_id ? decisionsByRun.get(m.agent_run_id) ?? [] : [];
              const toShow = runDecisions.filter((d) => !rendered.has(d.id));
              toShow.forEach((d) => rendered.add(d.id));

              if (isSystem) {
                return (
                  <div key={m.id} className="text-center text-xs text-slate-400">
                    {m.body}
                  </div>
                );
              }
              return (
                <div key={m.id} className={isStaff ? "flex justify-end" : "flex justify-start"}>
                  <div className={isStaff ? "max-w-[85%]" : "max-w-[85%] w-full"}>
                    <div className={`text-xs mb-1 ${isStaff ? "text-right text-slate-400" : "text-slate-400"}`}>
                      {isStaff ? "you (staff)" : "operator"}
                    </div>
                    <div
                      className={
                        "rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words " +
                        (isStaff ? "bg-blue-600 text-white" : "bg-white border border-slate-200 text-slate-800")
                      }
                    >
                      {m.body}
                    </div>
                    {toShow.map((d) => (
                      <DecisionCard key={d.id} decision={d} onOverride={() => setModalDecision(d)} />
                    ))}
                  </div>
                </div>
              );
            })
          )}

          {}
          {decisions
            .filter((d) => !rendered.has(d.id))
            .map((d) => (
              <div key={d.id} className="flex justify-start">
                <div className="max-w-[85%] w-full">
                  <DecisionCard decision={d} onOverride={() => setModalDecision(d)} />
                </div>
              </div>
            ))}

          {}
          {pendingSend && (
            <div className="flex justify-end">
              <div className="max-w-[85%]">
                <div className="text-xs mb-1 text-right text-slate-400">you (staff)</div>
                <div className="rounded-lg bg-blue-600/80 px-3 py-2 text-sm text-white whitespace-pre-wrap break-words">
                  {pendingSend}
                </div>
              </div>
            </div>
          )}

          {working && (
            <div className="flex justify-start" aria-live="polite">
              <div className="rounded-lg bg-white border border-slate-200 px-3 py-2 text-sm text-slate-400">
                operator is working
                <span className="inline-flex ml-1 gap-0.5 align-middle">
                  <Dot /> <Dot /> <Dot />
                </span>
              </div>
            </div>
          )}
        </div>

        {}
        <div className="border-t border-slate-100 bg-white/60 p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={working}
              placeholder={working ? "Waiting for the operator to finish…" : "Message the operator…"}
              rows={2}
              maxLength={32000}
              className="flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || working || !draft.trim()}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-slate-400"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
          <div className="mt-1 text-xs text-slate-400">Enter to send · Shift+Enter for a new line</div>
        </div>
      </div>

      {modalDecision &&
        (tenant ? (
          <LaneBModal
            key={modalDecision.id}
            decision={modalDecision}
            tenantId={tenantId}
            tenantSlug={tenant.slug}
            onClose={closeModal}
            onExecuted={onExecuted}
          />
        ) : (
          <BlockedOverrideNotice onClose={closeModal} error={tenantError} />
        ))}
    </div>
  );
}

function Dot() {
  return <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-300 animate-pulse" />;
}

function BlockedOverrideNotice({ onClose, error }: { onClose: () => void; error: string | null }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="presentation">
      <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl bg-white p-4 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-900">Can&apos;t execute right now</h3>
        <p className="mt-2 text-sm text-slate-600">
          Executing directly requires confirming this tenant&apos;s slug, and the tenant record didn&apos;t load
          {error ? ` (${error})` : ""}. Reload the page and try again.
        </p>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function DecisionCard({ decision, onOverride }: { decision: Decision; onOverride: () => void }) {
  const tag = classTag(decision);
  const red = isRed(decision);
  const title = decisionTitle(decision);
  const status = decision.status;
  const rev = reversibility(decision);

  if (status === "approved") {
    const byStaff = decision.approved_by_source === "staff";
    return (
      <ResolvedCard tone="good">
        <strong>{byStaff ? "Executed directly by staff" : "Approved by the customer"}</strong>
        <div className="text-slate-500 mt-0.5">{title}</div>
      </ResolvedCard>
    );
  }
  if (status === "rejected") {
    return (
      <ResolvedCard tone="rose">
        <strong>Rejected by the customer</strong>
        <div className="text-slate-500 mt-0.5">{title}</div>
      </ResolvedCard>
    );
  }
  if (status !== "proposed") {
    return (
      <ResolvedCard tone="slate">
        <strong>{status}</strong>
        <div className="text-slate-500 mt-0.5">{title}</div>
      </ResolvedCard>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-slate-300 bg-white overflow-hidden">
      <div className="px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span aria-hidden className="mt-0.5">⚙️</span>
          <span className="text-sm font-medium text-slate-900">{title}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {red && (
            <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide bg-rose-100 text-rose-800">
              RED · provably broken
            </span>
          )}
          <span
            className={
              "rounded px-1.5 py-0.5 text-[11px] font-medium " +
              (tag.danger ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600")
            }
          >
            {tag.label}
          </span>
          {rev && (
            <span
              className={
                "rounded px-1.5 py-0.5 text-[11px] font-medium " +
                (rev.tone === "good"
                  ? "bg-emerald-50 text-emerald-700"
                  : rev.tone === "warn"
                    ? "bg-amber-50 text-amber-700"
                    : "bg-rose-50 text-rose-700")
              }
            >
              {rev.label}
            </span>
          )}
          {decision.decision_class && (
            <span className="rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-400">{decision.decision_class}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50 px-3 py-2">
        <span className="flex-1 text-xs text-amber-700">◷ In the customer&apos;s approval queue</span>
        <button
          type="button"
          onClick={onOverride}
          className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-rose-400"
        >
          Execute directly{tag.danger || red ? " ⚠" : ""}
        </button>
      </div>
    </div>
  );
}

function ResolvedCard({ tone, children }: { tone: "good" | "rose" | "slate"; children: ReactNode }) {
  const cls =
    tone === "good"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "rose"
        ? "border-rose-200 bg-rose-50 text-rose-800"
        : "border-slate-200 bg-slate-50 text-slate-700";
  return <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${cls}`}>{children}</div>;
}

function LaneBModal({
  decision,
  tenantId,
  tenantSlug,
  onClose,
  onExecuted,
}: {
  decision: Decision;
  tenantId: string;
  tenantSlug: string;
  onClose: () => void;
  onExecuted: () => void;
}) {
  const destructive = isDestructive(decision);
  const [reason, setReason] = useState("");
  const [slugInput, setSlugInput] = useState("");
  const [redRequired, setRedRequired] = useState(isRed(decision));
  const [overrideRed, setOverrideRed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const modalRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  const slugOk = !destructive || slugInput.trim() === tenantSlug;
  const redOk = !redRequired || overrideRed;
  const canExecute = reason.trim().length > 0 && slugOk && redOk && !busy;

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement | null;
    firstFieldRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prevFocus.current?.focus?.();
    };
  }, [onClose]);

  async function confirmExec() {
    if (!canExecute) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await adminApiFetch(`/api/admin/tenants/${tenantId}/decisions/${decision.id}/execute`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ reason: reason.trim(), ...(redRequired ? { override_red: overrideRed } : {}) }),
      });
      const b = await res.json().catch(() => ({}));
      const code: string | undefined = b?.error?.code;
      if (!res.ok) {
        if (res.status === 409 && code === "red_override_required") {
          setRedRequired(true);
          setOverrideRed(false);
          setErr("This action is flagged RED (provably broken). Confirm the RED override below, then execute again.");
          return;
        }
        throw new Error(executeErrorMessage(res.status, code, b?.error?.message));
      }
      onExecuted();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const title = decisionTitle(decision);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="laneb-title"
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-slate-100 px-4 py-3">
          <span aria-hidden className="text-lg">{destructive ? "⚠️" : "📝"}</span>
          <div className="min-w-0">
            <h3 id="laneb-title" className="text-base font-semibold text-slate-900">
              {destructive ? "Execute directly — no customer consent" : "Execute directly"}
            </h3>
            <p className="mt-0.5 text-sm text-slate-500 break-words">{title}</p>
          </div>
        </div>

        <div className="space-y-3 px-4 py-4">
          <div
            className={
              "rounded-lg px-3 py-2 text-sm " +
              (destructive ? "bg-rose-50 text-rose-800" : "bg-slate-50 text-slate-600")
            }
          >
            {destructive ? (
              <>
                Runs <strong>immediately</strong> on {tenantSlug}&apos;s live data. The customer is <strong>not</strong>{" "}
                asked. You act as staff on their behalf, and this is written to the WORM audit log with your identity.
              </>
            ) : (
              <>Internal action, no external side effect. Still logged to the WORM audit with your identity.</>
            )}
          </div>

          {redRequired && (
            <label className="flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              <input
                type="checkbox"
                checked={overrideRed}
                onChange={(e) => setOverrideRed(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                I understand this action is flagged <strong>RED</strong> (provably broken) and I am overriding it anyway.
              </span>
            </label>
          )}

          {destructive && (
            <div>
              <label htmlFor="laneb-slug" className="block text-sm font-medium text-slate-700">
                Type the tenant slug to confirm <span className="text-rose-600">*</span>
              </label>
              <input
                id="laneb-slug"
                ref={(el) => {
                  if (destructive) firstFieldRef.current = el;
                }}
                value={slugInput}
                onChange={(e) => setSlugInput(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={tenantSlug}
                className={
                  "mt-1 w-full rounded-md border px-2.5 py-1.5 font-mono text-sm focus:outline-none focus-visible:ring-2 " +
                  (slugInput.trim() === tenantSlug
                    ? "border-emerald-400 focus-visible:ring-emerald-200"
                    : "border-slate-300 focus-visible:ring-blue-200")
                }
              />
              <div className="mt-1 text-xs text-slate-400">
                Proves you meant this tenant. Expected: <span className="font-mono">{tenantSlug}</span>
              </div>
            </div>
          )}

          <div>
            <label htmlFor="laneb-reason" className="block text-sm font-medium text-slate-700">
              Reason <span className="text-rose-600">*</span>
            </label>
            <textarea
              id="laneb-reason"
              ref={(el) => {
                if (!destructive) firstFieldRef.current = el;
              }}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="e.g. customer asked via support ticket #4821 — refund pre-approved on the call"
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
            />
            <div className="mt-1 text-xs text-slate-400">Written to the WORM audit log with your identity. Required.</div>
          </div>

          {err && <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-slate-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirmExec()}
            disabled={!canExecute}
            className={
              "rounded-md px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
              (destructive ? "bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-400" : "bg-blue-600 hover:bg-blue-700 focus-visible:ring-blue-400")
            }
          >
            {busy ? "Executing…" : destructive ? "Execute as customer" : "Execute"}
          </button>
        </div>
      </div>
    </div>
  );
}

function executeErrorMessage(status: number, code?: string, msg?: string): string {
  switch (code) {
    case "reason_required":
      return "A reason is required.";
    case "reason_too_long":
      return "The reason is too long (2000 char max).";
    case "tenant_mismatch":
      return "This decision does not belong to this tenant.";
    case "tenant_not_operable":
      return "The console operates on customer tenants only.";
    case "not_proposed":
      return "This action was already decided; nothing to execute.";
    case "rate_limited":
      return "Too many override actions. Slow down and retry.";
    case "in_progress":
      return "An identical override is still being processed.";
    case "audit_write_failed":
      return "WORM audit failed, nothing was executed. Try again.";
    default:
      return msg || `Execute failed (HTTP ${status}).`;
  }
}
