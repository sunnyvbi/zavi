
import type {
  PreToolUseHookInput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { isEgressTool } from "@/services/mcp/egress-policy";
import { evaluateToolCallPolicy } from "./tool-call-policy";
import { shouldDenyPmOperatorDb } from "@/agents/pm/operator-db-flag";
import { isDraftDeniedTool } from "./best-of-n";
import { isPreviewAllowedTool, PREVIEW_TOOL_DENIED_REASON } from "@/services/growth/preview-tools";
import { DONE_FOR_YOU_TOOL_DENIED_REASON, isDoneForYouAllowedTool } from "@/services/growth/done-for-you-tools";
import { inspectShellCommand } from "./sandbox-egress-parser";
import { isSecretPath, secretReadDenyReason } from "./sandbox-secret-denylist";
import { isShadowReadAllowedByName } from "./engine/shadow-tool-policy";
import { isLabDeniedTool, LAB_DENY_CODE, LAB_DENY_REASON } from "./variants-lab/lab-gate";
import {
  benchSdkToolDecision,
  BENCH_TOOL_DENY_BODY,
} from "@/services/eval/model-bench/modes";

type PreToolUseHookResult = SyncHookJSONOutput;

export const FAIL_CLOSED = true as const;
export function failClosed<T>(label: string, fn: () => T, onThrow: T): T {
  try {
    return fn();
  } catch (e) {
    console.warn(
      `[pre-tool-use-policy] fail-closed: ${label} threw, denying: ${
        (e as Error).message
      }`,
    );
    return onThrow;
  }
}

type EmitThreadEvent = (args: {
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

export type PreToolUsePolicyCtx = {
  tenant_id: string;
  agent: { slug: string };
  runId: string;
  thread_id: string | null;
  killed: { value: boolean };
  iter: { value: number };
  run_mode?: "delivery" | "strategy_memo";
  webSearchCounter?: { n: number };
  pm_operator_db_enabled?: boolean;
  cto_chat_intent?: "info" | "ship" | "ambiguous";
  recall_policy?: "always" | "live_state_aware";
  is_live_state_question?: boolean;
  resolved_tool_names?: readonly string[];
  research_scoped?: boolean;
  untrusted_inbound?: boolean;
  private_data_touched?: { value: boolean };
  draft_mode?: boolean;
  preview_dry?: boolean;
  preview_keep_cards?: boolean;
  done_for_you?: boolean;
  variants_lab?: boolean;
  degraded_mode?: boolean;
  bench_shadow?: { allowSandbox: boolean };
};

const SANDBOX_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "mcp__sandbox__read_file",
  "mcp__sandbox__view",
  "mcp__sandbox__git_diff",
  "mcp__sandbox__git_status",
]);

const SANDBOX_TOOL_PREFIX = "mcp__sandbox__";

const SANDBOX_COMMAND_TOOLS: ReadonlySet<string> = new Set([
  "mcp__sandbox__run_bash",
  "mcp__sandbox__run_tests",
  "mcp__sandbox__app_verify",
]);

const SANDBOX_RAW_READ_TOOLS: ReadonlySet<string> = new Set([
  "mcp__sandbox__read_file",
  "mcp__sandbox__view",
  "mcp__sandbox__emit_artifact",
]);

function normalizeEgressToolName(raw: string): string {
  let name = raw.startsWith("mcp__") ? raw.slice("mcp__".length) : raw;
  if (isEgressTool(name)) return name;
  const sep = name.indexOf("__");
  if (sep > 0) {
    const tail = name.slice(sep + 2);
    if (isEgressTool(tail)) return tail;
  }
  return name;
}

export type PreToolUsePolicyDeps = {
  isAgentKilled: (tenant_id: string, agent_slug: string) => Promise<boolean>;
  isRunStopRequested?: (run_id: string) => Promise<boolean>;
  isToolAllowed?: (
    tenant_id: string,
    agent_slug: string,
    tool_name: string,
  ) => Promise<
    | { allowed: true }
    | { allowed: false; reason: string }
  >;
  emitThreadEvent: EmitThreadEvent;
  ctx: PreToolUsePolicyCtx;
  hookInput: PreToolUseHookInput;
};

export async function preToolUsePolicyHook(
  deps: PreToolUsePolicyDeps,
): Promise<PreToolUseHookResult> {
  const { isToolAllowed, ctx, hookInput } = deps;
  const stop = await killOrStopResult(deps);
  if (stop) return stop;
  if (ctx.bench_shadow) {
    const decision = failClosed(
      "benchSdkToolDecision",
      () =>
        benchSdkToolDecision(String(hookInput.tool_name), {
          allowSandbox: ctx.bench_shadow!.allowSandbox,
          isShadowRead: (bare) => isShadowReadAllowedByName(bare),
        }),
      { allow: false, reason: "bench_decision_error" } as const,
    );
    if (!decision.allow) {
      return {
        reason: decision.reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: BENCH_TOOL_DENY_BODY,
        },
      };
    }
  }
  if (ctx.variants_lab === true && isLabDeniedTool(String(hookInput.tool_name))) {
    return {
      reason: LAB_DENY_CODE,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: LAB_DENY_REASON,
      },
    };
  }
  try {
    if (isToolAllowed) {
      const decision = await isToolAllowed(
        ctx.tenant_id,
        ctx.agent.slug,
        String(hookInput.tool_name),
      );
      if (!decision.allowed) {
        return {
          reason: "tenant_tool_deny",
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: decision.reason,
          },
        };
      }
    }

    if (
      ctx.preview_dry === true &&
      failClosed(
        "isPreviewAllowedTool",
        () => !isPreviewAllowedTool(String(hookInput.tool_name), { keepCards: ctx.preview_keep_cards === true }),
        true,
      )
    ) {
      return {
        reason: "preview_readonly",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: PREVIEW_TOOL_DENIED_REASON,
        },
      };
    }

    if (
      ctx.done_for_you === true &&
      failClosed("isDoneForYouAllowedTool", () => !isDoneForYouAllowedTool(String(hookInput.tool_name)), true)
    ) {
      return {
        reason: "done_for_you_readonly",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: DONE_FOR_YOU_TOOL_DENIED_REASON,
        },
      };
    }

    if (
      ctx.draft_mode === true &&
      ctx.variants_lab !== true &&
      failClosed(
        "isDraftDeniedTool",
        () => isDraftDeniedTool(String(hookInput.tool_name)),
        true,
      )
    ) {
      return {
        reason: "best_of_n_draft_readonly",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "draft candidate: side-effecting tools are disabled while comparing candidates. This call was not executed. Summarize what you WOULD do instead.",
        },
      };
    }

    if (
      ctx.degraded_mode === true &&
      failClosed(
        "isDraftDeniedTool",
        () => isDraftDeniedTool(String(hookInput.tool_name)),
        true,
      )
    ) {
      return {
        reason: "connector_wall_chat_degrade_readonly",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "degraded mode: required connectors are not set up for this workspace. " +
            "Side-effecting tools are disabled — I can answer your question from " +
            "first principles but cannot take live actions until the connectors are connected.",
        },
      };
    }

    if (
      String(hookInput.tool_name) === "memory__search" &&
      ctx.recall_policy === "live_state_aware" &&
      ctx.is_live_state_question === true
    ) {
      return {
        reason: "memory_grounding_policy",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "memory__search denied: the user is asking about CURRENT state. Memory may be stale — use a live tool (e.g. *__list_* / *__get_*) to fetch the present value. See _core/live-state-grounding.md.",
        },
      };
    }

    if (
      ctx.agent.slug === "pm" &&
      String(hookInput.tool_name) === "web_search__search"
    ) {
      const mode = ctx.run_mode ?? "delivery";
      const denyReason =
        mode !== "strategy_memo"
          ? `web_search denied: pm is in '${mode}' mode (strategy-only tool).`
          : (ctx.webSearchCounter?.n ?? 0) >= 3
            ? "web_search denied: pm strategy cap of 3 calls/run reached."
            : null;
      if (denyReason) {
        return {
          reason: "web_search_policy",
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: denyReason,
          },
        };
      }
      if (ctx.webSearchCounter) ctx.webSearchCounter.n += 1;
    }

    if (ctx.agent.slug === "pm") {
      if (
        failClosed(
          "shouldDenyPmOperatorDb",
          () =>
            shouldDenyPmOperatorDb({
              agentSlug: ctx.agent.slug,
              toolName: String(hookInput.tool_name),
              flagEnabled: ctx.pm_operator_db_enabled,
            }),
          true,
        )
      ) {
        return {
          reason: "pm_operator_db_policy",
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "operator_db denied: pm's access to the customer business DB is not enabled for this workspace. Proceed using the internal corpus (recent runs, decisions, memory).",
          },
        };
      }
    }

    if (
      ctx.agent.slug === "engineer" &&
      ctx.cto_chat_intent === "info"
    ) {
      const toolName = String(hookInput.tool_name);
      if (
        toolName.startsWith(SANDBOX_TOOL_PREFIX) &&
        !SANDBOX_READ_ONLY_TOOLS.has(toolName)
      ) {
        return {
          reason: "cto_info_readonly",
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "read-only mode: this is an informational question, so I can't edit files or run mutating commands. Ask me to make a specific change if you want a PR.",
          },
        };
      }
    }

    {
      const sandboxToolName = String(hookInput.tool_name);
      const ti = (hookInput.tool_input ?? {}) as Record<string, unknown>;
      if (SANDBOX_COMMAND_TOOLS.has(sandboxToolName)) {
        const cmd =
          typeof ti.command === "string"
            ? ti.command
            : typeof ti.start_cmd === "string"
              ? ti.start_cmd
              : "";
        if (cmd) {
          const verdict = failClosed(
            "inspectShellCommand",
            () => inspectShellCommand(cmd),
            {
              deny: true,
              reason:
                "Blocked: shell-command inspection errored; failing closed (the command was not executed).",
            },
          );
          if (verdict.deny) {
            return {
              reason: "sandbox_egress_blocked",
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: verdict.reason,
              },
            };
          }
        }
      } else if (SANDBOX_RAW_READ_TOOLS.has(sandboxToolName)) {
        const path = typeof ti.path === "string" ? ti.path : "";
        if (path && failClosed("isSecretPath", () => isSecretPath(path), true)) {
          return {
            reason: "sandbox_secret_read_blocked",
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: secretReadDenyReason(path),
            },
          };
        }
      }
    }

    if (ctx.resolved_tool_names) {
      const normalized = normalizeEgressToolName(String(hookInput.tool_name));
      const resolvedNames = ctx.resolved_tool_names;
      const egress = failClosed(
        "evaluateToolCallPolicy",
        () =>
          evaluateToolCallPolicy({
            tool_name: normalized,
            resolved_tool_names: resolvedNames,
            research_scoped: ctx.research_scoped === true,
            agent_slug: ctx.agent.slug,
            untrusted_inbound: ctx.untrusted_inbound === true,
            private_data_touched: ctx.private_data_touched?.value === true,
            tenant_id: ctx.tenant_id,
          }),
        {
          allow: false as const,
          reason: "egress_fail_closed",
          synthetic_tool_result:
            "EGRESS DENIED: the tool-call policy evaluation errored; failing closed (the call was not executed).",
        },
      );
      if (!egress.allow) {
        return {
          reason: egress.reason,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: egress.synthetic_tool_result,
          },
        };
      }
    }

    return { continue: true };
  } catch (e) {
    console.warn(
      `[pre-tool-use-policy] unexpected error, falling open: ${
        (e as Error).message
      }`,
    );
    return { continue: true };
  }
}

async function killOrStopResult(
  deps: PreToolUsePolicyDeps,
): Promise<PreToolUseHookResult | null> {
  const { isAgentKilled, isRunStopRequested, emitThreadEvent, ctx, hookInput } = deps;
  let killed = false;
  let stopped = false;
  try {
    killed = await isAgentKilled(ctx.tenant_id, ctx.agent.slug);
    stopped = !killed && isRunStopRequested ? await isRunStopRequested(ctx.runId) : false;
  } catch (e) {
    console.warn(
      `[pre-tool-use-policy] kill/stop read failed, falling open: ${(e as Error).message}`,
    );
    return null;
  }
  if (!killed && !stopped) return null;
  {
    const reason = killed ? "kill_switch" : "run_cancelled";

    try {
      await emitThreadEvent({
        agent_run_id: ctx.runId,
        agent_slug: ctx.agent.slug,
        tenant_id: ctx.tenant_id,
        thread_id: ctx.thread_id,
        kind: "tool_call",
        body: {
          tool_name: String(hookInput.tool_name).slice(0, 64),
          target: "",
          ms: 0,
          code: reason,
          output_preview: `${reason} — blocked by PreToolUse hook`,
        },
      });
    } catch (e) {
      console.warn(
        `[pre-tool-use-policy] thread_event emit failed during ${reason} block: ${
          (e as Error).message
        }`,
      );
    }

    ctx.killed.value = true;

    return {
      continue: false,
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }
}
