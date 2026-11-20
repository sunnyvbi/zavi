
export const OPERATOR_HANDOFF_ACK_SENTINEL = "skipped:operator-handoff-ack";

const DELEGATING_AGENTS = new Set(["operator"]);

const MAX_ACK_LEN = 800;

const HANDOFF_TOOL_RE = /praxis__(handoff(_parallel)?|ask_agent)$/;

const HANDOFF_OK_RE = /"ok"\s*:\s*true|"run_id"|"run_ids"|"batch_id"/;

type ToolCallSummary = {
  name?: unknown;
  status?: unknown;
  output_preview?: unknown;
};

function isConfirmedSuccessfulHandoff(tc: unknown): boolean {
  if (!tc || typeof tc !== "object") return false;
  const { name, status, output_preview } = tc as ToolCallSummary;
  if (typeof name !== "string" || !HANDOFF_TOOL_RE.test(name)) return false;
  if (status !== "ok") return false;
  if (typeof output_preview !== "string" || output_preview.length === 0) return false;
  return HANDOFF_OK_RE.test(output_preview.replace(/\\/g, ""));
}

export function isOperatorHandoffAck(
  agentSlug: string,
  toolCalls: unknown,
  outputText: string | null,
): boolean {
  if (!DELEGATING_AGENTS.has(agentSlug)) return false;
  if (typeof outputText !== "string") return false;
  if (outputText.trim().length === 0 || outputText.length > MAX_ACK_LEN) return false;
  if (!Array.isArray(toolCalls)) return false;
  return toolCalls.some(isConfirmedSuccessfulHandoff);
}
