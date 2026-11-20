
export type InflightRow = {
  kind: string;
  agent_run_id: string | null;
};

export type InflightInput = {
  activeRunId: string | null;
  activeTrigger: string | null;
  pendingRunId: string | null;
  rows: InflightRow[];
  terminalRunIds?: ReadonlySet<string>;
};

function hasAssistantReply(rows: InflightRow[], runId: string): boolean {
  return rows.some(
    (r) => r.kind === "chat_assistant" && r.agent_run_id === runId,
  );
}

export function resolveInflight(input: InflightInput): {
  show: boolean;
  runId: string | null;
} {
  const { activeRunId, activeTrigger, pendingRunId, rows } = input;
  const terminal = input.terminalRunIds ?? new Set<string>();

  if (activeRunId) {
    const t = activeTrigger ?? "manual";
    const triggerOk = t === "chat" || t === "manual";
    if (
      triggerOk &&
      !terminal.has(activeRunId) &&
      !hasAssistantReply(rows, activeRunId)
    ) {
      return { show: true, runId: activeRunId };
    }
  }

  if (pendingRunId && pendingRunId !== activeRunId) {
    if (
      !terminal.has(pendingRunId) &&
      !hasAssistantReply(rows, pendingRunId)
    ) {
      return { show: true, runId: pendingRunId };
    }
  }

  return { show: false, runId: null };
}

export function isStreamDraftLive(input: {
  runId: string | null;
  status: string;
  rows: InflightRow[];
}): boolean {
  if (!input.runId) return false;
  if (input.status !== "streaming" && input.status !== "complete") return false;
  return !hasAssistantReply(input.rows, input.runId);
}
