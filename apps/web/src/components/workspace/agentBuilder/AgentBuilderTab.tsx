"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bot, LoaderCircle, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { isMember } from "@/lib/members";
import { openBillingSettings } from "@/lib/workspace/openBilling";
import { CUSTOM_AGENT_HONEST_LINE, TERMINAL_RUN_STATUSES, TEST_RUN_CONFIRM } from "@/lib/workspace/customAgentCard";
import {
  PAUSED_AFTER_FAILS,
  findBuilderAgent,
  nextRun,
  pastWhen,
  pausedLine,
  plainRunText,
  receiptLine,
  runResultMarkdown,
  runStatus,
  savedWhen,
  sendsResultsLine,
  sendsResultsTo,
  whenItRuns,
  type BuilderAgent,
  type BuilderNote,
  type BuilderReceipt,
  type BuilderRefusal,
  type BuilderRun,
  type RunTone,
} from "@/lib/workspace/agentBuilder";
import { useWorkspace } from "../WorkspaceShell";
import { Markdown } from "../Markdown";
import { useModalFocusTrap, useOpenStatic } from "../layout/shared";
import { ModeComposer, SendCircle } from "../ModeComposer";

const OPERATOR_SLUG = "operator";

const BTN_PRIMARY =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-cta bg-ink px-4 text-[14px] font-semibold text-white transition-colors hover:bg-inkSoft disabled:cursor-default disabled:bg-ink/10 disabled:text-inkMuted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30";
const BTN_SECONDARY =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-cta border border-ink/15 bg-white px-4 text-[14px] font-semibold text-ink transition-colors hover:bg-bone disabled:cursor-default disabled:text-inkMuted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30";
const BTN_DANGER =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-cta border border-ink/15 bg-white px-4 text-[14px] font-semibold text-danger transition-colors hover:bg-dangerBg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30";
const CARD = "rounded-2xl border border-ink/10 bg-white p-4";

const TONE: Record<RunTone, string> = {
  done: "text-success",
  failed: "text-danger",
  muted: "text-inkMuted",
  running: "text-ink",
};

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) return body.error.message;
  } catch {
  }
  return "Something went wrong. Try again.";
}

type ListState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; agents: BuilderAgent[]; refusal: BuilderRefusal | null };

function useAgents() {
  const [state, setState] = useState<ListState>({ phase: "loading" });
  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/custom-agents");
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { agents?: BuilderAgent[]; refusal?: BuilderRefusal | null };
      const agents = (body.agents ?? []).filter((a) => a.status === "active" || a.status === "paused");
      setState({ phase: "ready", agents, refusal: body.refusal ?? null });
    } catch {
      setState({ phase: "error" });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, reload: load, setState };
}

export function AgentBuilderTab({ agentId, runId = null }: { agentId: string | null; runId?: string | null }) {
  const { state, reload, setState } = useAgents();
  const openStatic = useOpenStatic();
  const [deletedName, setDeletedName] = useState<string | null>(null);

  const openAgent = (id: string | null) => openStatic("agent-builder", { agentId: id });
  const openRun = (id: string, run: string) => openStatic("agent-builder", { agentId: id, runId: run });

  const patchAgent = (next: BuilderAgent) =>
    setState((s) =>
      s.phase === "ready" ? { ...s, agents: s.agents.map((a) => (a.id === next.id ? { ...a, ...next } : a)) } : s,
    );

  let body: ReactNode;
  if (agentId) {
    const agent = state.phase === "ready" ? findBuilderAgent(state.agents, agentId) : null;
    body =
      state.phase === "loading" ? (
        <>
          <BackLink onClick={() => openAgent(null)} />
          <Loading />
        </>
      ) : state.phase === "error" ? (
        <>
          <BackLink onClick={() => openAgent(null)} />
          <LoadError onRetry={() => void reload()} />
        </>
      ) : agent && runId ? (
        <AgentRunResults
          key={agent.id}
          agent={agent}
          runId={runId}
          onSettings={() => openAgent(agent.id)}
          onPick={(run) => openRun(agent.id, run)}
        />
      ) : agent ? (
        <AgentDetail
          onOpenResults={(run) => openRun(agent.id, run)}
          key={agent.id}
          agent={agent}
          onBack={() => openAgent(null)}
          onChanged={patchAgent}
          onDeleted={(name) => {
            setDeletedName(name);
            openAgent(null);
            void reload();
          }}
        />
      ) : (
        <>
          <BackLink onClick={() => openAgent(null)} />
          <p className="mt-6 text-[14px] text-inkMuted">This agent was not found. It may have been archived.</p>
        </>
      );
  } else {
    body = (
      <AgentList
        state={state}
        deletedName={deletedName}
        onRetry={() => void reload()}
        onOpen={(id) => {
          setDeletedName(null);
          openAgent(id);
        }}
        onChanged={patchAgent}
        onRestored={() => {
          setDeletedName(null);
          void reload();
        }}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="agent-builder">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">{body}</div>
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 text-[14px] font-medium text-inkMuted hover:text-ink"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      All agents
    </button>
  );
}

function Loading() {
  return (
    <p role="status" className="mt-6 flex items-center gap-2 text-[14px] text-inkMuted">
      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
      Loading…
    </p>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="mt-6 flex flex-wrap items-center gap-3 text-[14px] text-inkMuted">
      Couldn’t load your agents.
      <button type="button" onClick={onRetry} className={BTN_SECONDARY}>
        Retry
      </button>
    </div>
  );
}

function StatusPill({ paused }: { paused: boolean }) {
  return paused ? (
    <span className="inline-flex items-center gap-2 rounded-full bg-bone px-2 py-0.5 text-[13px] font-semibold text-inkMuted">
      <span className="size-1.5 rounded-full bg-inkMuted" aria-hidden />
      Paused
    </span>
  ) : (
    <span className="inline-flex items-center gap-2 rounded-full bg-successBg px-2 py-0.5 text-[13px] font-semibold text-success">
      <span className="size-1.5 rounded-full bg-success" aria-hidden />
      Active
    </span>
  );
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-[16px] font-semibold text-ink">{children}</h2>
      {aside ? <div className="ml-auto flex items-center gap-2">{aside}</div> : null}
    </div>
  );
}

function AddChip({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-8 items-center gap-1 rounded-cta border border-dashed border-ink/20 bg-white px-3 text-[14px] font-medium text-inkMuted transition-colors hover:border-ink/40 hover:text-ink"
    >
      + {children}
    </button>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-[14px] text-inkMuted">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{children}</dd>
    </div>
  );
}

async function setAgentStatus(
  id: string,
  status: "active" | "paused" | "archived",
): Promise<{ agent: BuilderAgent } | { error: string }> {
  try {
    const res = await apiFetch(`/api/custom-agents/${encodeURIComponent(id)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) return { error: await errorMessage(res) };
    const { agent } = (await res.json()) as { agent: BuilderAgent };
    window.dispatchEvent(new CustomEvent("zavi:workspace-tree-refresh"));
    return { agent };
  } catch {
    return { error: "Something went wrong. Try again." };
  }
}

function AgentList({
  state,
  deletedName,
  onRetry,
  onOpen,
  onChanged,
  onRestored,
}: {
  state: ListState;
  deletedName: string | null;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onChanged: (a: BuilderAgent) => void;
  onRestored: () => void;
}) {
  const { role, openTab, seedComposer } = useWorkspace();
  const member = isMember(role);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const [ask, setAsk] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refusal = state.phase === "ready" ? state.refusal : null;
  const agents = state.phase === "ready" ? state.agents : [];

  const archived = useArchived();
  const [showArchived, setShowArchived] = useState(false);

  const unarchive = async (a: BuilderAgent) => {
    setBusyId(a.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/custom-agents/${encodeURIComponent(a.id)}/unarchive`, { method: "POST" });
      if (!res.ok) {
        setError(await errorMessage(res));
        return;
      }
      window.dispatchEvent(new CustomEvent("zavi:workspace-tree-refresh"));
      void archived.reload();
      onRestored();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusyId(null);
    }
  };

  const toggle = async (a: BuilderAgent) => {
    setBusyId(a.id);
    setError(null);
    const out = await setAgentStatus(a.id, a.status === "paused" ? "active" : "paused");
    if ("error" in out) setError(out.error);
    else onChanged(out.agent);
    setBusyId(null);
  };

  const submitAsk = () => {
    const text = ask.trim();
    if (!text || refusal) return;
    seedComposer({ agentSlug: OPERATOR_SLUG, text, thread: "new", autoSend: true });
    setAsk("");
  };

  return (
    <>
      <h1 className="text-[30px] font-bold tracking-tight text-ink">Agent Builder</h1>
      <p className="mt-1 text-[14px] text-inkMuted">Agents you built. Each one runs on its own and reports back.</p>

      {deletedName ? (
        <div role="status" className={`${CARD} mt-6`}>
          <p className="text-[16px] font-semibold text-ink">Agent archived</p>
          <p className="mt-1 text-[14px] text-inkMuted">
            &quot;{deletedName}&quot; stopped and moved to Archived. Its run history and receipts are kept.
          </p>
        </div>
      ) : null}

      {}
      <div className="mt-6">
        <label htmlFor="agent-ask" className="text-[16px] font-semibold text-ink">
          What should your agent do?
        </label>
        <div className="mt-2">
          <ModeComposer
            value={ask}
            onChange={(v) => setAsk(v)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              submitAsk();
            }}
            textareaRef={boxRef}
            textareaProps={{ id: "agent-ask" }}
            ariaLabel="What should your agent do?"
            placeholder="Every weekday at 9am, send me a standup of what you did"
            trailing={
              refusal && !member ? (
                <button type="button" onClick={() => openBillingSettings(openTab)} className={BTN_PRIMARY}>
                  Upgrade plan
                </button>
              ) : (
                <SendCircle onClick={submitAsk} disabled={!!refusal || !ask.trim()} ariaLabel="Draft agent" />
              )
            }
          />
        </div>
        {refusal ? (
          <p className="mt-2 text-[14px] text-ink">
            {refusal.message}
            {member ? " Ask your workspace owner to upgrade." : ""}
          </p>
        ) : (
          <p className="mt-2 text-[14px] text-inkMuted">Zavi drafts the agent in chat. You check it, then create it.</p>
        )}
      </div>

      <div className="mt-8">
        <SectionTitle
          aside={
            state.phase === "ready" ? (
              <span className="text-[14px] tabular-nums text-inkMuted">
                {agents.length} {agents.length === 1 ? "agent" : "agents"}
              </span>
            ) : null
          }
        >
          Your agents
        </SectionTitle>
        {error ? (
          <p role="alert" className="mt-2 text-[14px] text-danger">
            {error}
          </p>
        ) : null}
        {state.phase === "error" ? <LoadError onRetry={onRetry} /> : null}
        <div className="mt-3 overflow-x-auto rounded-2xl border border-ink/10 bg-white">
          <table className="w-full min-w-[860px] text-left text-[14px]">
            <thead className="bg-bone text-[13px] text-inkMuted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Agent</th>
                <th className="px-4 py-2.5 font-medium">When it runs</th>
                <th className="px-4 py-2.5 font-medium">Sends results to</th>
                <th className="px-4 py-2.5 font-medium">Last run</th>
                <th className="px-4 py-2.5 font-medium">Next run</th>
                <th className="px-4 py-2.5 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {state.phase === "loading" ? (
                <tr>
                  <td colSpan={6} className="px-4 py-3.5">
                    <p role="status" className="flex items-center gap-2 text-inkMuted">
                      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                      Loading…
                    </p>
                  </td>
                </tr>
              ) : null}
              {agents.map((a) => {
                const paused = a.status === "paused";
                const run = a.last_run ?? null;
                const rs = run ? runStatus(run) : null;
                return (
                  <tr key={a.id} className="align-top" data-testid="agent-row">
                    <td className="px-4 py-3.5">
                      <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
                        {a.name}
                        <StatusPill paused={paused} />
                      </p>
                      {a.role ? <p className="mt-0.5 text-inkMuted">{a.role}</p> : null}
                      {paused && pausedLine(a) ? (
                        <p className="mt-1 text-[13px] text-inkMuted">{pausedLine(a)}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3.5 text-ink">{whenItRuns(a.triggers)}</td>
                    <td className="px-4 py-3.5 text-ink">{sendsResultsTo(a.deliver)}</td>
                    <td className="px-4 py-3.5">
                      {run && rs ? (
                        <>
                          <p className={`font-medium ${TONE[rs.tone]}`}>
                            {rs.label}
                            {run.test ? <span className="ml-1.5 whitespace-nowrap text-[12px] font-medium text-inkMuted">· Test run</span> : null}
                          </p>
                          <p className="text-inkMuted">{pastWhen(run.finished_at ?? run.enqueued_at)}</p>
                        </>
                      ) : (
                        <p className="text-inkMuted">Not run yet</p>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-ink">{nextRun(a)}</td>
                    <td className="px-4 py-3.5">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={busyId === a.id || (paused && !!refusal)}
                          onClick={() => void toggle(a)}
                          className={BTN_SECONDARY}
                        >
                          {paused ? "Resume" : "Pause"}
                        </button>
                        <button type="button" onClick={() => onOpen(a.id)} className={BTN_SECONDARY}>
                          Open
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {state.phase === "ready" && agents.length === 0 ? (
                <tr className="align-top" data-testid="agent-row-empty">
                  <td className="px-4 py-3.5">
                    <p className="text-[14px] font-semibold text-inkMuted">No agents yet</p>
                    <div className="mt-2">
                      <AddChip onClick={() => boxRef.current?.focus()}>Add an agent</AddChip>
                    </div>
                  </td>
                  <td className="px-4 py-3.5 text-inkMuted">Not set</td>
                  <td className="px-4 py-3.5 text-inkMuted">Not set</td>
                  <td className="px-4 py-3.5 text-inkMuted">Not run yet</td>
                  <td className="px-4 py-3.5 text-inkMuted">Not scheduled</td>
                  <td className="px-4 py-3.5" />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="mt-4">
          <button
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            className="text-[14px] font-semibold text-inkMuted hover:text-ink"
          >
            {archived.state.phase === "ready" ? `Archived (${archived.state.data.length})` : "Archived"}
          </button>
          {showArchived ? (
            <ul className="mt-2 divide-y divide-ink/5 rounded-2xl border border-ink/10 bg-white" data-testid="archived-list">
              {archived.state.phase === "loading" ? (
                <li className="px-4 py-3">
                  <Loading />
                </li>
              ) : null}
              {archived.state.phase === "error" ? (
                <li className="px-4 py-3">
                  <LoadError onRetry={() => void archived.reload()} />
                </li>
              ) : null}
              {archived.state.phase === "ready"
                ? archived.state.data.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 px-4 py-3" data-testid="archived-row">
                      <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink">{a.name}</span>
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => void unarchive(a)}
                        className={BTN_SECONDARY}
                      >
                        Unarchive
                      </button>
                    </li>
                  ))
                : null}
              {archived.state.phase === "ready" && archived.state.data.length === 0 ? (
                <li className="px-4 py-3 text-[14px] text-inkMuted">No archived agents</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      </div>
    </>
  );
}

function useArchived() {
  const [state, setState] = useState<Loaded<BuilderAgent[]>>({ phase: "loading" });
  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/custom-agents?status=archived");
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { agents?: BuilderAgent[] };
      setState({ phase: "ready", data: (body.agents ?? []).filter((a) => a.status === "archived") });
    } catch {
      setState({ phase: "error" });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, reload: load };
}

type Loaded<T> = { phase: "loading" } | { phase: "error" } | { phase: "ready"; data: T };

function useLoad<T>(path: string, pick: (body: unknown) => T) {
  const [state, setState] = useState<Loaded<T>>({ phase: "loading" });
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const load = useCallback(async () => {
    try {
      const res = await apiFetch(path);
      if (!res.ok) throw new Error(String(res.status));
      setState({ phase: "ready", data: pickRef.current(await res.json()) });
    } catch {
      setState({ phase: "error" });
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, reload: load, setState };
}

function AgentDetail({
  agent,
  onBack,
  onChanged,
  onDeleted,
  onOpenResults,
}: {
  agent: BuilderAgent;
  onOpenResults: (runId: string) => void;
  onBack: () => void;
  onChanged: (a: BuilderAgent) => void;
  onDeleted: (name: string) => void;
}) {
  const { openAgentTab } = useWorkspace();
  const base = `/api/custom-agents/${encodeURIComponent(agent.id)}`;
  const runs = useLoad(`${base}/runs`, (b) => ((b as { runs?: BuilderRun[] }).runs ?? []));
  const [actingRuns, setActingRuns] = useState<ReadonlySet<string>>(() => new Set());
  const onReceipts = useCallback((runId: string, count: number) => {
    setActingRuns((prev) => {
      if ((count > 0) === prev.has(runId)) return prev;
      const next = new Set(prev);
      if (count > 0) next.add(runId);
      else next.delete(runId);
      return next;
    });
  }, []);
  const notes = useLoad(`${base}/notes`, (b) => ((b as { notes?: BuilderNote[] }).notes ?? []));

  const paused = agent.status === "paused";
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [confirmTest, setConfirmTest] = useState(false);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const testStartRef = useRef(false);
  const scheduleTriggers = agent.triggers.filter((t) => t.kind === "schedule");
  const [scheduleText, setScheduleText] = useState("");
  const schedule = useSchedulePreview(editing ? scheduleText : "");

  const reloadRuns = runs.reload;
  const reloadNotes = notes.reload;
  useEffect(() => {
    if (!testRunId) return;
    let stopped = false;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const res = await apiFetch(`/api/agents/runs/${encodeURIComponent(testRunId)}`);
        if (res.ok) {
          const body = (await res.json()) as { run?: { status?: string; output_text?: string | null } };
          const status = body.run?.status ?? null;
          if (!stopped) setTestStatus(status);
          if (status && TERMINAL_RUN_STATUSES.has(status)) {
            if (!stopped) {
              setTestOutput(body.run?.output_text ?? "");
              void reloadRuns();
              void reloadNotes();
            }
            return;
          }
        }
      } catch {
      }
      if (!stopped) timer = window.setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [testRunId, reloadRuns, reloadNotes]);

  const testing = starting || (!!testRunId && !(testStatus && TERMINAL_RUN_STATUSES.has(testStatus)));

  const runTest = async () => {
    if (testStartRef.current) return;
    testStartRef.current = true;
    setConfirmTest(false);
    setStarting(true);
    setError(null);
    setTestOutput(null);
    setTestStatus(null);
    try {
      const res = await apiFetch(`${base}/test`, { method: "POST" });
      if (!res.ok) {
        setError(await errorMessage(res));
        return;
      }
      const { run_id } = (await res.json()) as { run_id: string };
      setTestRunId(run_id || null);
      setTestStatus("queued");
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      testStartRef.current = false;
      setStarting(false);
    }
  };

  const togglePause = async () => {
    setBusy(true);
    setError(null);
    const out = await setAgentStatus(agent.id, paused ? "active" : "paused");
    if ("error" in out) setError(out.error);
    else onChanged(out.agent);
    setBusy(false);
  };

  const typedSchedule = scheduleText.trim();
  const instructionsChanged = !!instructions.trim() && instructions !== agent.instructions;
  const scheduleReady = schedule.phase === "ok";
  const canSave =
    !saving &&
    !!instructions.trim() &&
    (!typedSchedule || scheduleReady) &&
    (instructionsChanged || (!!typedSchedule && scheduleReady));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(instructions !== agent.instructions ? { instructions } : {}),
          ...(typedSchedule && schedule.phase === "ok" ? { schedule_cron: schedule.cron } : {}),
        }),
      });
      if (!res.ok) {
        setError(await errorMessage(res));
        return;
      }
      const { agent: next } = (await res.json()) as { agent: BuilderAgent };
      onChanged(next);
      setScheduleText("");
      setEditing(false);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const out = await setAgentStatus(agent.id, "archived");
    setBusy(false);
    if ("error" in out) {
      setDialog(false);
      setError(out.error);
      return;
    }
    setDialog(false);
    onDeleted(agent.name);
  };

  const deleteNote = async (id: string) => {
    setError(null);
    try {
      const res = await apiFetch(`${base}/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        setError(await errorMessage(res));
        return;
      }
      notes.setState((s) => (s.phase === "ready" ? { ...s, data: s.data.filter((n) => n.id !== id) } : s));
    } catch {
      setError("Something went wrong. Try again.");
    }
  };

  const acts = actingRuns.size > 0;

  return (
    <>
      <BackLink onClick={onBack} />
      <header className="mt-4 flex flex-wrap items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink text-white" aria-hidden>
          <Bot className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-[26px] font-bold tracking-tight text-ink">
            {agent.name}
            <StatusPill paused={paused} />
          </h1>
          {agent.role ? <p className="text-[14px] text-inkMuted">{agent.role}</p> : null}
          {paused && pausedLine(agent) ? (
            <p className="mt-1 text-[14px] font-medium text-ink">{pausedLine(agent)}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setConfirmTest(true)} disabled={testing || paused} className={BTN_PRIMARY}>
            {starting ? "Starting…" : testing ? "Testing…" : "Test run"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (editing) {
                setInstructions(agent.instructions);
                setScheduleText("");
              }
              setEditing((v) => !v);
            }}
            className={BTN_SECONDARY}
          >
            {editing ? "Done editing" : "Edit"}
          </button>
          <button type="button" onClick={() => void togglePause()} disabled={busy} className={BTN_SECONDARY}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" onClick={() => setDialog(true)} disabled={busy} className={BTN_DANGER}>
            Archive
          </button>
        </div>
      </header>
      <p className="mt-4 rounded-lg border border-ink/10 bg-bone px-3 py-2 text-[14px] text-ink">{CUSTOM_AGENT_HONEST_LINE}</p>
      {confirmTest ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-ink/10 bg-bone px-3 py-2">
          <span className="text-[14px] font-medium text-ink">{TEST_RUN_CONFIRM}</span>
          <button type="button" onClick={() => void runTest()} className={BTN_PRIMARY}>
            Run test
          </button>
          <button type="button" onClick={() => setConfirmTest(false)} className={BTN_SECONDARY}>
            Cancel
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-[14px] text-danger">
          {error}
        </p>
      ) : null}
      {paused && agent.paused_reason === PAUSED_AFTER_FAILS ? (
        <p className="mt-4 rounded-xl border border-ink/10 bg-bone px-4 py-3 text-[14px] text-ink">
          Resume starts the count again. If the next 3 runs do not finish, it pauses again and sends one notice.
        </p>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <section className={CARD}>
            <SectionTitle>Setup</SectionTitle>
            <dl className="mt-2 divide-y divide-ink/5">
              <FieldRow label="Instructions">
                {editing ? (
                  <>
                    <textarea
                      aria-label="Instructions"
                      rows={5}
                      maxLength={20000}
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      className="w-full resize-y rounded-lg border border-ink/15 bg-white px-3 py-2 text-[14px] text-ink focus:border-ink/40 focus:outline-none"
                    />
                  </>
                ) : (
                  agent.instructions
                )}
              </FieldRow>
              <FieldRow label="When it runs:">
                {editing && scheduleTriggers.length > 0 ? (
                  <ScheduleBox
                    current={whenItRuns(scheduleTriggers)}
                    value={scheduleText}
                    onChange={setScheduleText}
                    preview={schedule}
                  />
                ) : (
                  whenItRuns(agent.triggers)
                )}
              </FieldRow>
              <FieldRow label="Sends results to:">{sendsResultsLine(agent.deliver)}</FieldRow>
              <FieldRow label="Next run">{nextRun(agent)}</FieldRow>
            </dl>
            {editing ? (
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => void save()} disabled={!canSave} className={BTN_PRIMARY}>
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            ) : null}
          </section>

          <section className={CARD}>
            <SectionTitle
              aside={acts ? <span className="text-[13px] text-inkMuted">Acts on its own. Every action is listed here.</span> : null}
            >
              Run history
            </SectionTitle>

            {testRunId || starting ? (
              <div className="mt-3 rounded-xl border border-ink/10 bg-bone p-4">
                {testOutput !== null ? (
                  <>
                    <p className="text-[14px] font-medium text-inkMuted">This was a real run. The result is shown here only.</p>
                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink">
                      {testOutput ? plainRunText(testOutput) : "The run finished without any output."}
                    </pre>
                  </>
                ) : (
                  <p role="status" className="flex items-center gap-2 text-[14px] text-inkMuted">
                    <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                    {starting ? "Starting…" : "Testing…"}
                  </p>
                )}
              </div>
            ) : null}

            <ul className="mt-3 divide-y divide-ink/5">
              {runs.state.phase === "loading" ? (
                <li className="py-3">
                  <Loading />
                </li>
              ) : null}
              {runs.state.phase === "error" ? (
                <li className="py-3">
                  <LoadError onRetry={() => void runs.reload()} />
                </li>
              ) : null}
              {runs.state.phase === "ready"
                ? runs.state.data.map((r) => (
                    <RunRow key={r.id} base={base} run={r} onReceipts={onReceipts} onOpenResults={onOpenResults} />
                  ))
                : null}
              {runs.state.phase === "ready" && runs.state.data.length === 0 ? (
                <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-[14px] text-inkMuted">
                  <span className="w-36 shrink-0">Not run yet</span>
                  <span className="flex-1">Runs show here with their result.</span>
                  {!paused ? <AddChip onClick={() => setConfirmTest(true)}>Test run</AddChip> : null}
                </li>
              ) : null}
            </ul>
          </section>
        </div>

        <aside className="space-y-6">
          <section className={CARD}>
            <SectionTitle>Saved to the brain</SectionTitle>
            <p className="mt-1 text-[13px] text-inkMuted">Findings this agent saved. Each run starts from its last result.</p>
            <ul className="mt-3 space-y-2">
              {notes.state.phase === "loading" ? (
                <li>
                  <Loading />
                </li>
              ) : null}
              {notes.state.phase === "error" ? (
                <li>
                  <LoadError onRetry={() => void notes.reload()} />
                </li>
              ) : null}
              {notes.state.phase === "ready"
                ? notes.state.data.map((n) => (
                    <li key={n.id} className="rounded-xl border border-ink/10 p-3" data-testid="note-row">
                      <p className="text-[14px] text-ink">{n.text}</p>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-[13px] text-inkMuted">Saved {savedWhen(n.created_at)}</span>
                        <button
                          type="button"
                          onClick={() => void deleteNote(n.id)}
                          className="rounded-cta px-2 py-1 text-[13px] font-semibold text-danger hover:bg-dangerBg"
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ))
                : null}
              {notes.state.phase === "ready" && notes.state.data.length === 0 ? (
                <li className="rounded-xl border border-dashed border-ink/20 p-3 text-[14px] text-inkMuted">No notes saved yet</li>
              ) : null}
            </ul>
          </section>

          <section className={CARD}>
            <SectionTitle>Chat with this agent</SectionTitle>
            <p className="mt-1 text-[13px] text-inkMuted">
              Ask it anything in its own thread, or type @{agent.name} in any chat, Slack or WhatsApp.
            </p>
            <button
              type="button"
              onClick={() => void openAgentTab(agent.slug, { push: true })}
              className={`${BTN_SECONDARY} mt-3 w-full`}
            >
              Chat with {agent.name}
            </button>
          </section>
        </aside>
      </div>

      {dialog ? (
        <ArchiveDialog name={agent.name} busy={busy} onCancel={() => setDialog(false)} onConfirm={() => void remove()} />
      ) : null}
    </>
  );
}

type RunDetail = { status: string; output: string; done: boolean };

function AgentRunResults({
  agent,
  runId,
  onSettings,
  onPick,
}: {
  agent: BuilderAgent;
  runId: string;
  onSettings: () => void;
  onPick: (runId: string) => void;
}) {
  const { openAgentTab } = useWorkspace();
  const base = `/api/custom-agents/${encodeURIComponent(agent.id)}`;
  const runs = useLoad(`${base}/runs`, (b) => ((b as { runs?: BuilderRun[] }).runs ?? []));
  const [detail, setDetail] = useState<Loaded<RunDetail | null>>({ phase: "loading" });

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    setDetail({ phase: "loading" });
    const tick = async () => {
      try {
        const res = await apiFetch(`/api/agents/runs/${encodeURIComponent(runId)}`);
        if (res.status === 404) {
          if (!stopped) setDetail({ phase: "ready", data: null });
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as {
          run?: { status?: string; output_text?: string | null; agent_slug?: string };
        };
        if (stopped) return;
        if (!body.run || body.run.agent_slug !== agent.slug) {
          setDetail({ phase: "ready", data: null });
          return;
        }
        const status = body.run.status ?? "";
        const done = TERMINAL_RUN_STATUSES.has(status);
        setDetail({ phase: "ready", data: { status, output: body.run.output_text ?? "", done } });
        if (!done) timer = window.setTimeout(tick, 3000);
      } catch {
        if (!stopped) setDetail({ phase: "error" });
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [runId, agent.slug]);

  const listed = runs.state.phase === "ready" ? runs.state.data.find((r) => r.id === runId) ?? null : null;
  const run = detail.phase === "ready" ? detail.data : null;
  const rs = run ? runStatus({ status: run.status, test: listed?.test ?? false }) : null;
  const markdown = run && run.done ? runResultMarkdown(run.output) : "";

  return (
    <>
      <button
        type="button"
        onClick={onSettings}
        className="inline-flex items-center gap-2 text-[14px] font-medium text-inkMuted hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {agent.name}
      </button>
      <header className="mt-4 flex flex-wrap items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink text-white" aria-hidden>
          <Bot className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] text-inkMuted">Results</p>
          <h1 className="text-[26px] font-bold tracking-tight text-ink">{agent.name}</h1>
          {rs ? (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[14px]" data-testid="run-results-status">
              <span className={`font-semibold ${TONE[rs.tone]}`}>{rs.label}</span>
              {listed?.test ? (
                <span className="rounded-md bg-bone px-1.5 py-0.5 text-[12px] font-medium text-inkMuted">Test run</span>
              ) : null}
              {listed ? <span className="text-inkMuted">{pastWhen(listed.finished_at ?? listed.enqueued_at)}</span> : null}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void openAgentTab(agent.slug, { push: true })} className={BTN_PRIMARY}>
            Chat with this agent
          </button>
          <button type="button" onClick={onSettings} className={BTN_SECONDARY}>
            Agent settings
          </button>
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className={`${CARD} min-w-0`} data-testid="run-results">
          <SectionTitle>Result</SectionTitle>
          <div className="mt-3">
            {detail.phase === "loading" ? (
              <Loading />
            ) : detail.phase === "error" ? (
              <div role="alert" className="flex flex-wrap items-center gap-3 text-[14px] text-inkMuted">
                Couldn’t load this result.
              </div>
            ) : !run ? (
              <p className="rounded-xl border border-dashed border-ink/20 p-4 text-[14px] text-inkMuted">
                Couldn’t find this run for {agent.name}. Pick one from Earlier runs.
              </p>
            ) : !run.done ? (
              <p role="status" className="flex items-center gap-2 rounded-xl border border-dashed border-ink/20 p-4 text-[14px] text-inkMuted">
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                Still running. The result shows here when it finishes.
              </p>
            ) : rs?.tone === "failed" ? (
              <p className="rounded-xl border border-dashed border-ink/20 p-4 text-[14px] text-inkMuted">
                {listed?.failure ?? "This run stopped before it finished, so there is no result."}
              </p>
            ) : markdown ? (
              <Markdown source={markdown} breaks />
            ) : (
              <p className="rounded-xl border border-dashed border-ink/20 p-4 text-[14px] text-inkMuted">
                The run finished without any output.
              </p>
            )}
          </div>
        </section>

        <aside className="space-y-6">
          <section className={CARD}>
            <SectionTitle>Earlier runs</SectionTitle>
            <ul className="mt-3 space-y-2">
              {runs.state.phase === "loading" ? (
                <li>
                  <Loading />
                </li>
              ) : null}
              {runs.state.phase === "error" ? (
                <li>
                  <LoadError onRetry={() => void runs.reload()} />
                </li>
              ) : null}
              {runs.state.phase === "ready"
                ? runs.state.data.map((r) => {
                    const on = r.id === runId;
                    const s = runStatus(r);
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          aria-current={on ? "true" : undefined}
                          onClick={() => onPick(r.id)}
                          data-testid="earlier-run"
                          className={`w-full rounded-cta border px-3 py-2 text-left transition-colors ${
                            on ? "border-ink bg-bone" : "border-ink/10 hover:bg-bone"
                          }`}
                        >
                          <span className="block text-[14px] font-semibold text-ink">
                            {pastWhen(r.finished_at ?? r.enqueued_at)}
                          </span>
                          <span className={`block text-[13px] ${TONE[s.tone]}`}>
                            {s.label}
                            {r.test ? " · Test run" : ""}
                          </span>
                          {r.summary ? (
                            <span className="mt-0.5 line-clamp-2 block text-[13px] text-inkMuted">{plainRunText(r.summary)}</span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })
                : null}
              {runs.state.phase === "ready" && runs.state.data.length === 0 ? (
                <li className="rounded-xl border border-dashed border-ink/20 p-3 text-[14px] text-inkMuted">No runs yet</li>
              ) : null}
            </ul>
          </section>

          <section className={CARD}>
            <SectionTitle>Schedule</SectionTitle>
            <dl className="mt-2 space-y-2 text-[14px]">
              <div>
                <dt className="text-inkMuted">When it runs</dt>
                <dd className="text-ink">{whenItRuns(agent.triggers)}</dd>
              </div>
              <div>
                <dt className="text-inkMuted">Next run</dt>
                <dd className="text-ink">{nextRun(agent)}</dd>
              </div>
              <div>
                <dt className="text-inkMuted">Sends results to</dt>
                <dd className="text-ink">{sendsResultsLine(agent.deliver)}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}

async function loadRunReceipts(base: string, runId: string): Promise<BuilderReceipt[]> {
  const out: BuilderReceipt[] = [];
  let before: string | null = null;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ run_id: runId, limit: "200" });
    if (before) qs.set("before", before);
    const res = await apiFetch(`${base}/receipts?${qs.toString()}`);
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { receipts?: BuilderReceipt[]; next_cursor?: string | null };
    out.push(...(body.receipts ?? []));
    before = body.next_cursor ?? null;
    if (!before) break;
  }
  return out;
}

function RunRow({
  base,
  run,
  onReceipts,
  onOpenResults,
}: {
  base: string;
  run: BuilderRun;
  onReceipts: (runId: string, count: number) => void;
  onOpenResults: (runId: string) => void;
}) {
  const rs = runStatus(run);
  const [receipts, setReceipts] = useState<BuilderReceipt[]>([]);
  const [receiptsFailed, setReceiptsFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Loaded<{ output: string; done: boolean }>>({ phase: "loading" });

  useEffect(() => {
    let stopped = false;
    void loadRunReceipts(base, run.id)
      .then((list) => {
        if (stopped) return;
        setReceipts(list);
        onReceipts(run.id, list.length);
      })
      .catch(() => {
        if (!stopped) setReceiptsFailed(true);
      });
    return () => {
      stopped = true;
    };
  }, [base, run.id, onReceipts]);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const res = await apiFetch(`/api/agents/runs/${encodeURIComponent(run.id)}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { run?: { status?: string; output_text?: string | null } };
        const done = !!body.run?.status && TERMINAL_RUN_STATUSES.has(body.run.status);
        if (stopped) return;
        setResult({ phase: "ready", data: { output: body.run?.output_text ?? "", done } });
        if (!done) timer = window.setTimeout(tick, 3000);
      } catch {
        if (!stopped) setResult({ phase: "error" });
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [open, run.id]);

  const toggleResult = () => {
    if (!open) setResult({ phase: "loading" });
    setOpen((v) => !v);
  };

  return (
    <li className="py-3" data-testid="run-row">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
        <span className="w-36 shrink-0 text-[14px] text-inkMuted">{pastWhen(run.finished_at ?? run.enqueued_at)}</span>
        <div className="min-w-0 flex-1">
          <p className={`flex flex-wrap items-center gap-2 text-[14px] font-semibold ${TONE[rs.tone]}`}>
            {rs.label}
            {run.test ? (
              <span className="rounded-md bg-bone px-1.5 py-0.5 text-[12px] font-medium text-inkMuted">Test run</span>
            ) : null}
          </p>
          {run.failure ? <p className="text-[14px] text-inkMuted">{run.failure}</p> : null}
          {run.summary ? <p className="text-[14px] text-ink">{run.summary}</p> : null}
          {receiptsFailed ? (
            <p className="mt-1.5 text-[14px] text-inkMuted">Couldn’t load this run’s actions.</p>
          ) : receipts.length > 0 ? (
            <ul className="mt-1.5 space-y-1">
              {receipts.map((x) => (
                <li key={x.id} className="flex items-start gap-2 rounded-lg bg-bone px-2.5 py-1.5 text-[14px] text-ink">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ink" aria-hidden />
                  {receiptLine(x)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={toggleResult}
          className="shrink-0 text-[14px] font-semibold text-ink underline underline-offset-4"
        >
          {open ? "Hide result" : "Open result"}
        </button>
        <button
          type="button"
          onClick={() => onOpenResults(run.id)}
          className="shrink-0 text-[14px] font-semibold text-ink underline underline-offset-4"
        >
          Open results page
        </button>
      </div>
      {open ? (
        <div className="mt-2 rounded-xl border border-ink/10 bg-bone p-3" data-testid="run-result">
          {result.phase === "loading" ? (
            <Loading />
          ) : result.phase === "error" ? (
            <p role="alert" className="text-[14px] text-inkMuted">
              Couldn’t load the result.
            </p>
          ) : result.data.output ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink">
              {plainRunText(result.data.output)}
            </pre>
          ) : (
            <p className="text-[14px] text-inkMuted">
              {result.data.done ? "The run finished without any output." : "Still running."}
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function ArchiveDialog({
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocusTrap(ref, onCancel, busy);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" onClick={onCancel} className="absolute inset-0 cursor-default bg-ink/40" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Archive this agent"
        tabIndex={-1}
        className="relative z-10 w-full max-w-md rounded-2xl border border-ink/10 bg-white p-4 shadow-xl"
      >
        <div className="flex items-start justify-between">
          <h3 className="text-[20px] font-bold tracking-tight text-ink">Archive &quot;{name}&quot;?</h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-cta text-inkMuted transition-colors hover:bg-bone hover:text-ink"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-3 text-[14px] leading-relaxed text-inkMuted">
          It stops running. Its run history and receipts are kept, and you can unarchive it.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className={BTN_SECONDARY}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex min-h-9 items-center justify-center rounded-cta bg-danger px-4 text-[14px] font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Archive agent
          </button>
        </div>
      </div>
    </div>
  );
}

type SchedulePreview =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ok"; cron: string; tz: string; label: string; next: string[] }
  | { phase: "bad"; message: string }
  | { phase: "error" };

function useSchedulePreview(text: string): SchedulePreview {
  const [preview, setPreview] = useState<SchedulePreview>({ phase: "idle" });
  const seqRef = useRef(0);
  useEffect(() => {
    const typed = text.trim();
    const seq = ++seqRef.current;
    if (!typed) {
      setPreview({ phase: "idle" });
      return;
    }
    setPreview({ phase: "loading" });
    const timer = window.setTimeout(async () => {
      try {
        const res = await apiFetch("/api/custom-agents/schedule-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: typed }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as
          | { ok: true; cron: string; tz: string; label: string; next: string[] }
          | { ok: false; message: string };
        if (seq !== seqRef.current) return;
        setPreview(body.ok ? { phase: "ok", cron: body.cron, tz: body.tz, label: body.label, next: body.next } : { phase: "bad", message: body.message });
      } catch {
        if (seq === seqRef.current) setPreview({ phase: "error" });
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [text]);
  return preview;
}

function fireTime(iso: string, tz: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", opts).format(d);
  }
}

function ScheduleBox({
  current,
  value,
  onChange,
  preview,
}: {
  current: string;
  value: string;
  onChange: (v: string) => void;
  preview: SchedulePreview;
}) {
  return (
    <>
      <p className="text-[14px] text-inkMuted">Now: {current}</p>
      <input
        aria-label="When it runs"
        value={value}
        maxLength={200}
        onChange={(e) => onChange(e.target.value)}
        placeholder="weekdays at 10am"
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-[14px] text-ink focus:border-ink/40 focus:outline-none"
      />
      <div className="mt-1.5 text-[14px]" aria-live="polite" data-testid="schedule-preview">
        {preview.phase === "loading" ? <span className="text-inkMuted">Reading…</span> : null}
        {preview.phase === "bad" ? <span className="text-ink">{preview.message}</span> : null}
        {preview.phase === "error" ? <span className="text-ink">Couldn’t read that. Try again.</span> : null}
        {preview.phase === "ok" ? (
          <>
            <p className="font-medium text-ink">{preview.label}</p>
            {preview.next.length > 0 ? (
              <p className="text-inkMuted">Next: {preview.next.map((iso) => fireTime(iso, preview.tz)).join(" · ")}</p>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
