
import type {
  EngineEvent,
  EngineResumeHandle,
  NormalizedUsage,
} from "./types";

export type OnEventWriterCtx = {
  agent_run_id: string;
  agent_slug: string;
  tenant_id: string;
  thread_id: string | null;
};

export type SafeEmitThreadEvent = (args: {
  agent_run_id: string;
  agent_slug: string;
  tenant_id: string;
  thread_id: string | null;
  kind: "tool_call";
  body: {
    tool_name: string;
    target: string;
    ms: number;
    code: string;
    output_preview: string;
  };
}) => Promise<void>;

export type OnEventWriterDeps = {
  emitProgress: (
    stage:
      | "tool_use_started"
      | "tool_use_completed"
      | "tool_use_errored"
      | "steer_drained",
    meta?: { tool_name?: string; ms?: number; code?: string; iter?: number },
  ) => Promise<void>;
  safeEmitThreadEvent: SafeEmitThreadEvent;
  ctx: OnEventWriterCtx;
  onUsage?: (usage: NormalizedUsage) => void;
  onTerminal?: (resume: EngineResumeHandle | null, usage: NormalizedUsage) => void;
};

export type OnEventHandler = (e: EngineEvent) => void;

export function makeOnEventHandler(deps: OnEventWriterDeps): OnEventHandler {
  const { emitProgress, safeEmitThreadEvent, ctx } = deps;

  return function onEvent(e: EngineEvent): void {
    switch (e.type) {
      case "tool_call": {
        const evt = e as unknown as {
          name?: unknown;
          ms?: unknown;
          code?: unknown;
          iter?: unknown;
        };
        const tool_name = typeof evt.name === "string" ? evt.name : "";
        const ms = typeof evt.ms === "number" ? evt.ms : 0;
        const code = typeof evt.code === "string" ? evt.code : "ok";
        const iter = typeof evt.iter === "number" ? evt.iter : 0;

        const isErr = code !== "ok";
        void emitProgress(isErr ? "tool_use_errored" : "tool_use_completed", {
          tool_name,
          ms,
          code,
          iter,
        });
        void safeEmitThreadEvent({
          agent_run_id: ctx.agent_run_id,
          agent_slug: ctx.agent_slug,
          tenant_id: ctx.tenant_id,
          thread_id: ctx.thread_id,
          kind: "tool_call",
          body: {
            tool_name: tool_name.slice(0, 64),
            target: "",
            ms,
            code: isErr ? "err" : "ok",
            output_preview: "",
          },
        });
        return;
      }
      case "usage": {
        deps.onUsage?.(e.usage);
        return;
      }
      case "terminal": {
        deps.onTerminal?.(e.resume, e.usage);
        return;
      }
      case "steer_drained": {
        if (e.count > 0) {
          void emitProgress("steer_drained", { iter: e.iter });
        }
        return;
      }
      case "text_delta":
      default:
        return;
    }
  };
}
