
import { EventType, type BaseEvent } from "@ag-ui/core";
import { UI_TOOL_NAMES } from "./ui-tools";

export function bareUiToolName(name: string): { name: string; isFrontend: boolean } {
  const bare = name.startsWith("mcp__ui__") ? name.slice(9) : name.startsWith("ui__") ? name.slice(4) : null;
  if (bare === null) return { name, isFrontend: false };
  return { name: bare, isFrontend: (UI_TOOL_NAMES as readonly string[]).includes(bare) };
}

export type ThreadEventRow = {
  id: number | string;
  kind: string;
  body: Record<string, unknown> | null;
  created_at?: string;
};

export type TranslateCtx = {
  threadId: string;
  runId: string;
};

export const MAX_FORWARDED_TOOL_CALLS = 200;

export type Translator = {
  push: (row: ThreadEventRow) => BaseEvent[];
  finished: () => boolean;
};

const s = (v: unknown, max = 8000): string => (typeof v === "string" ? v.slice(0, max) : "");

export function createTranslator(ctx: TranslateCtx): Translator {
  let started = false;
  let finished = false;
  let toolCalls = 0;
  let truncated = false;
  let assistantText = false;
  let msgSeq = 0;
  const open = new Map<string, { toolCallId: string; isFrontend: boolean }>();
  const nextId = (p: string) => `${p}-${ctx.runId}-${++msgSeq}`;

  const start = (): BaseEvent[] => {
    if (started) return [];
    started = true;
    return [
      { type: EventType.RUN_STARTED, threadId: ctx.threadId, runId: ctx.runId } as BaseEvent,
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { zavi: { thread_id: ctx.threadId, run_id: ctx.runId, status: "running", pending_decisions: [] } },
      } as BaseEvent,
    ];
  };

  return {
    finished: () => finished,
    push(row) {
      if (finished) return [];
      const b = row.body ?? {};
      const out: BaseEvent[] = [];

      switch (row.kind) {
        case "run_start":
          out.push(...start());
          break;

        case "plan":
          out.push(...start(), { type: EventType.STEP_STARTED, stepName: s(b.title ?? b.summary ?? "plan", 200) || "plan" } as BaseEvent);
          break;

        case "reasoning":
          out.push(...start(), { type: EventType.CUSTOM, name: "zavi.reasoning", value: { text: s(b.text ?? b.summary, 2000) } } as BaseEvent);
          break;

        case "tool_call": {
          out.push(...start());
          const raw = s(b.tool_name, 64) || "tool";
          const { name, isFrontend } = bareUiToolName(raw);
          const pending = open.get(raw);
          if (pending) {
            open.delete(raw);
            if (!isFrontend) {
              out.push({
                type: EventType.TOOL_CALL_RESULT,
                messageId: nextId("tr"),
                toolCallId: pending.toolCallId,
                content: s(b.output_preview, 200) || (b.code === "err" ? `error: ${s(b.error_message, 200)}` : "ok"),
                role: "tool",
              } as BaseEvent);
            }
            break;
          }
          if (truncated) break;
          if (toolCalls >= MAX_FORWARDED_TOOL_CALLS) {
            truncated = true;
            out.push({ type: EventType.CUSTOM, name: "zavi.tool_calls_truncated", value: { after: MAX_FORWARDED_TOOL_CALLS } } as BaseEvent);
            break;
          }
          toolCalls += 1;
          const toolCallId = `tc-${ctx.runId}-${row.id}`;
          const target = s(b.target, 256);
          const args = looksJson(target) ? target : JSON.stringify({ target });
          open.set(raw, { toolCallId, isFrontend });
          out.push(
            { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name } as BaseEvent,
            { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: args } as BaseEvent,
            { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent,
          );
          break;
        }

        case "decision":
          out.push(...start(), {
            type: EventType.STATE_DELTA,
            delta: [{ op: "add", path: "/zavi/pending_decisions/-", value: { decision_id: s(b.decision_id, 64), decision_class: s(b.decision_class, 64) } }],
          } as BaseEvent);
          break;

        case "chat_assistant": {
          out.push(...start());
          const txt = s(b.text);
          if (!txt) break;
          assistantText = true;
          const messageId = nextId("msg");
          out.push(
            { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent,
            { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: txt } as BaseEvent,
            { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent,
          );
          break;
        }

        case "run_end": {
          out.push(...start());
          finished = true;
          const status = s(b.status, 32) || "unknown";
          const failed = status === "failed" || status === "error";
          out.push({
            type: EventType.STATE_DELTA,
            delta: [{ op: "replace", path: "/zavi/status", value: status }],
          } as BaseEvent);
          if (failed && !assistantText) {
            out.push({ type: EventType.RUN_ERROR, message: s(b.error ?? b.error_message, 500) || "run failed", code: status } as BaseEvent);
          } else {
            out.push({ type: EventType.RUN_FINISHED, threadId: ctx.threadId, runId: ctx.runId } as BaseEvent);
          }
          break;
        }

        default:
          break;
      }
      return out;
    },
  };
}

function looksJson(v: string): boolean {
  if (!v.startsWith("{")) return false;
  try {
    JSON.parse(v);
    return true;
  } catch {
    return false;
  }
}

export function encodeSse(event: BaseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
