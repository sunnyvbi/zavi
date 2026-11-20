"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { isMember } from "@/lib/members";
import { openBillingSettings } from "@/lib/workspace/openBilling";
import { plainRunText, runStatus } from "@/lib/workspace/agentBuilder";
import {
  deliverLabel,
  draftFromServerAgent,
  triggerLabel,
  type ServerCustomAgent,
  TERMINAL_RUN_STATUSES,
  CUSTOM_AGENT_HONEST_LINE,
  TEST_RUN_CONFIRM,
  type CustomAgentCardData,
  type CustomAgentDraft,
} from "@/lib/workspace/customAgentCard";

type Saved = { id: string; status: string };

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) return body.error.message;
  } catch {
  }
  return "Something went wrong. Try again.";
}

export function CustomAgentDraftCard({
  card,
  originRunId,
}: {
  card: CustomAgentCardData;
  originRunId?: string | null;
}) {
  const ws = useWorkspaceOptional();
  if (card.kind === "refusal") {
    const canManageBilling = ws ? !isMember(ws.role) : true;
    return (
      <div data-testid="custom-agent-card" role="alert" className="mt-2 rounded-xl border border-ink/10 bg-white p-4 shadow-sm">
        <p className="text-[14px] leading-[1.55] text-ink">{card.refusal.message}</p>
        {card.refusal.code !== "plan_upgrade_required" ? null : canManageBilling ? (
          <button
            type="button"
            onClick={() => (ws ? openBillingSettings(ws.openTab) : (window.location.href = "/workspace?tab=settings#billing"))}
            className="mt-3 rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white"
          >
            Upgrade plan
          </button>
        ) : (
          <p className="mt-1 text-[13px] text-inkMuted">Ask your workspace owner to upgrade.</p>
        )}
      </div>
    );
  }
  return <DraftCard initial={card.draft} originRunId={originRunId ?? null} />;
}

function DraftCard({ initial, originRunId }: { initial: CustomAgentDraft; originRunId: string | null }) {
  const [name, setName] = useState(initial.name);
  const [role, setRole] = useState(initial.role);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [triggers, setTriggers] = useState(initial.triggers);
  const [deliver, setDeliver] = useState(initial.deliver);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | "create" | "test">(null);
  const [error, setError] = useState<string | null>(null);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [confirmingTest, setConfirmingTest] = useState(false);
  const pollRef = useRef<number | null>(null);
  const testStartRef = useRef(false);

  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!originRunId) {
      setChecked(true);
      return;
    }
    let stopped = false;
    void (async () => {
      try {
        const res = await apiFetch(`/api/custom-agents?origin_run_id=${encodeURIComponent(originRunId)}`);
        if (res.ok) {
          const { agents } = (await res.json()) as { agents?: ServerCustomAgent[] };
          const hit = agents?.[0];
          if (hit && !stopped) {
            setSaved({ id: hit.id, status: hit.status });
            const restored = draftFromServerAgent(hit, initial);
            setName(restored.name);
            setRole(restored.role);
            setInstructions(restored.instructions);
            setTriggers(restored.triggers);
            setDeliver(restored.deliver);
          }
        }
      } catch {
      }
      if (!stopped) setChecked(true);
    })();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originRunId]);

  const created = saved?.status === "active" || saved?.status === "paused";
  const deleted = saved?.status === "archived";

  useEffect(() => {
    if (!testRunId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await apiFetch(`/api/agents/runs/${encodeURIComponent(testRunId)}`);
        if (res.ok) {
          const body = (await res.json()) as { run?: { status?: string; output_text?: string | null } };
          const status = body.run?.status ?? null;
          if (!stopped) setTestStatus(status);
          if (status && TERMINAL_RUN_STATUSES.has(status)) {
            if (!stopped) setTestOutput(body.run?.output_text ?? "");
            return;
          }
        }
      } catch {
      }
      if (!stopped) pollRef.current = window.setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      stopped = true;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [testRunId]);

  const body = (status: "draft" | "active") => ({
    name,
    role,
    instructions,
    tools: initial.tools,
    triggers,
    deliver,
    status,
    ...(originRunId ? { origin_run_id: originRunId } : {}),
  });

  const ensureSaved = async (status: "draft" | "active"): Promise<Saved | null> => {
    if (!saved) {
      const res = await apiFetch("/api/custom-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body(status)),
      });
      if (!res.ok) {
        setError(await errorMessage(res));
        return null;
      }
      const { agent } = (await res.json()) as { agent: Saved };
      setSaved(agent);
      setDirty(false);
      return agent;
    }
    if (dirty) {
      const res = await apiFetch(`/api/custom-agents/${encodeURIComponent(saved.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, role, instructions }),
      });
      if (!res.ok) {
        setError(await errorMessage(res));
        return null;
      }
      setDirty(false);
    }
    return saved;
  };

  const onCreate = async () => {
    setBusy("create");
    setError(null);
    try {
      const agent = await ensureSaved("active");
      if (!agent) return;
      if (agent.status !== "active") {
        const res = await apiFetch(`/api/custom-agents/${encodeURIComponent(agent.id)}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "active" }),
        });
        if (!res.ok) {
          setError(await errorMessage(res));
          return;
        }
        setSaved({ id: agent.id, status: "active" });
      }
      window.dispatchEvent(new CustomEvent("zavi:workspace-tree-refresh"));
      setEditing(false);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const onTest = async () => {
    if (testStartRef.current) return;
    testStartRef.current = true;
    setConfirmingTest(false);
    setBusy("test");
    setError(null);
    setTestOutput(null);
    setTestStatus(null);
    try {
      const agent = await ensureSaved("draft");
      if (!agent) return;
      const res = await apiFetch(`/api/custom-agents/${encodeURIComponent(agent.id)}/test`, {
        method: "POST",
        retryOnNetworkError: false,
      });
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
      setBusy(null);
    }
  };

  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDirty(true);
  };

  const testing = !!testRunId && !(testStatus && TERMINAL_RUN_STATUSES.has(testStatus));

  return (
    <div data-testid="custom-agent-card" className="mt-2 rounded-xl border border-ink/10 bg-white p-4 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-inkMuted">
        {deleted ? "Agent archived" : created ? "Agent created" : "New agent"}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <label className="text-[14px] font-medium text-inkMuted">
            Name
            <input
              value={name}
              maxLength={60}
              onChange={(e) => edit(setName)(e.target.value)}
              className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-[14px] text-ink"
            />
          </label>
          <label className="text-[14px] font-medium text-inkMuted">
            Role
            <input
              value={role}
              maxLength={500}
              onChange={(e) => edit(setRole)(e.target.value)}
              className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-[14px] text-ink"
            />
          </label>
          <label className="text-[14px] font-medium text-inkMuted">
            Instructions
            <textarea
              value={instructions}
              maxLength={20000}
              rows={6}
              onChange={(e) => edit(setInstructions)(e.target.value)}
              className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-[13px] leading-[1.5] text-ink"
            />
          </label>
        </div>
      ) : (
        <>
          <div className="mt-1 text-[16px] font-semibold text-ink">{name}</div>
          {role ? <p className="mt-0.5 text-[13px] text-inkMuted">{role}</p> : null}
          <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[13px] leading-[1.55] text-ink">{instructions}</p>
        </>
      )}

      <dl className="mt-3 grid grid-cols-1 gap-1 text-[13px] text-inkMuted">
        <div>
          <dt className="inline font-medium text-ink">When it runs: </dt>
          <dd className="inline">
            {triggers.length > 0 ? triggers.map(triggerLabel).join("; ") : "Only when you run it"}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-ink">Sends results to: </dt>
          <dd className="inline">{deliverLabel(deliver)}</dd>
        </div>
      </dl>

      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-coral">
          {error}
        </p>
      ) : null}

      {deleted ? (
        <p className="mt-3 text-[13px] text-inkMuted">This agent was archived.</p>
      ) : (
      <>
      <p data-testid="custom-agent-warning" className="mt-3 rounded-md border border-ink/10 bg-bone px-3 py-2 text-[13px] leading-[1.5] text-ink">
        {CUSTOM_AGENT_HONEST_LINE}
      </p>
      {confirmingTest ? (
        <div data-testid="custom-agent-test-confirm" className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-ink">{TEST_RUN_CONFIRM}</span>
          <button
            type="button"
            onClick={() => void onTest()}
            disabled={busy !== null}
            className="rounded-cta border border-transparent bg-ink px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            Run test
          </button>
          <button
            type="button"
            onClick={() => setConfirmingTest(false)}
            className="rounded-cta border border-ink/15 bg-white px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-bone"
          >
            Cancel
          </button>
        </div>
      ) : (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!created && (
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={!checked || busy !== null || !name.trim() || !instructions.trim()}
            className="rounded-cta border border-transparent bg-ink px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            {busy === "create" ? "Creating…" : "Create"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setConfirmingTest(true)}
          disabled={!checked || busy !== null || testing || !name.trim() || !instructions.trim()}
          className="rounded-cta border border-ink/15 bg-white px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-bone disabled:opacity-50"
        >
          {busy === "test" ? "Starting…" : testing ? "Testing…" : "Test run"}
        </button>
        {!created && (
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            disabled={!checked || busy !== null}
            className="rounded-cta border border-transparent px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-bone disabled:opacity-50"
          >
            {editing ? "Done editing" : "Edit"}
          </button>
        )}
      </div>
      )}
      </>
      )}

      {created ? (
        <p className="mt-2 text-[13px] text-inkMuted">
          {saved?.status === "paused" ? "It’s paused." : "It’s active."}
        </p>
      ) : null}

      {testRunId ? (
        <div className="mt-3 rounded-lg border border-ink/10 bg-bone/40 p-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-inkMuted">
            Test run{testStatus ? ` · ${runStatus({ status: testStatus, test: true }).label}` : ""}
          </div>
          <p className="mt-1 text-[12px] text-inkMuted">
            {testOutput !== null ? "This was a real run. The result is shown here only." : "Testing… the result will show here."}
          </p>
          {testOutput !== null ? (
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap font-sans text-[13px] leading-[1.55] text-ink">
              {testOutput ? plainRunText(testOutput) : "The run finished without any output."}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
