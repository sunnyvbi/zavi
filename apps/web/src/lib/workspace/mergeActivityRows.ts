
import type { ChatRow, ThreadEventRow } from "./useChatThread";

const ACTIVITY_KINDS = new Set([
  "plan",
  "reasoning",
  "tool_call",
  "file_read",
  "file_edit",
  "file_create",
]);

function whitelistBody(
  kind: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (kind) {
    case "plan":
      if (typeof body.summary === "string") out.summary = body.summary;
      if (Array.isArray(body.steps)) {
        out.steps = (body.steps as unknown[]).filter(
          (s): s is string => typeof s === "string",
        );
      }
      break;
    case "reasoning":
      if (typeof body.text === "string") out.text = body.text;
      break;
    case "tool_call":
      if (typeof body.tool_name === "string") out.tool_name = body.tool_name;
      if (typeof body.target === "string") out.target = body.target;
      if (typeof body.output_preview === "string") out.output_preview = body.output_preview;
      if (typeof body.error_message === "string") out.error_message = body.error_message;
      if (typeof body.code === "string") out.code = body.code;
      if (typeof body.ms === "number") out.ms = body.ms;
      if (typeof body.call_id === "string") out.call_id = body.call_id;
      break;
    case "file_read":
    case "file_edit":
    case "file_create":
      if (typeof body.path === "string") out.path = body.path;
      break;
    default:
      break;
  }
  out.teKind = kind;
  return out;
}

export function mergeActivityRows(
  agentSlug: string,
  teRows: ThreadEventRow[],
  activeRunId: string | null,
  finishedRunIds: Set<string>,
): ChatRow[] {
  void agentSlug;
  if (!activeRunId || finishedRunIds.has(activeRunId)) return [];
  const out: ChatRow[] = [];
  for (const r of teRows) {
    if (r.agent_run_id !== activeRunId) continue;
    if (!ACTIVITY_KINDS.has(r.kind)) continue;
    out.push({
      id: `te:${r.id}`,
      kind: "chat_activity",
      agent_run_id: r.agent_run_id,
      body: whitelistBody(r.kind, r.body),
      citations: [],
      created_at: r.created_at,
    });
  }
  return out;
}

export function detailedActivityByRun(
  teRows: ThreadEventRow[],
  runIds: Set<string>,
): Map<string, ChatRow[]> {
  const out = new Map<string, ChatRow[]>();
  for (const r of teRows) {
    if (!r.agent_run_id || !runIds.has(r.agent_run_id)) continue;
    if (!ACTIVITY_KINDS.has(r.kind)) continue;
    const list = out.get(r.agent_run_id) ?? [];
    list.push({
      id: `te:${r.id}`,
      kind: "chat_activity",
      agent_run_id: r.agent_run_id,
      body: whitelistBody(r.kind, r.body),
      citations: [],
      created_at: r.created_at,
    });
    out.set(r.agent_run_id, list);
  }
  return out;
}
