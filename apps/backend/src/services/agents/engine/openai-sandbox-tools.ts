
import {
  SANDBOX_TOOL_NAMES,
  sandboxToolRegistry,
  type SandboxToolName,
  type SandboxToolDeps,
} from "@/services/sandbox/tool-registry";
import { appVerifyInputSchema } from "@/services/tools/sandbox/app-verify";
import { zodToJsonSchema } from "@/services/tools/registry";
import { inspectShellCommand } from "@/services/agents/sandbox-egress-parser";
import {
  isSecretPath,
  secretReadDenyReason,
} from "@/services/agents/sandbox-secret-denylist";
import type { EngineToolSpec, EngineToolResult } from "./types";
import { z } from "zod";
import {
  SITE_IMAGES_TOOL_DESCRIPTION,
  SITE_IMAGES_TOOL_NAME,
  siteImagesToolInput,
} from "@/services/site-images/sandbox-tool";

export const SANDBOX_SERVER_ID = "sandbox";

export function toCanonicalSandboxName(verb: SandboxToolName): string {
  return `${SANDBOX_SERVER_ID}__${verb}`;
}

export function isCanonicalSandboxTool(
  server_id: string | undefined,
  bare_tool_name: string | undefined,
): bare_tool_name is SandboxToolName {
  return (
    server_id === SANDBOX_SERVER_ID &&
    !!bare_tool_name &&
    (SANDBOX_TOOL_NAMES as readonly string[]).includes(bare_tool_name)
  );
}

export const LIVE_SITE_IMAGES_VERB = SITE_IMAGES_TOOL_NAME;
export type LiveSandboxVerb = SandboxToolName | typeof LIVE_SITE_IMAGES_VERB;

export function isLiveSandboxTool(
  server_id: string | undefined,
  bare_tool_name: string | undefined,
): bare_tool_name is LiveSandboxVerb {
  return (
    isCanonicalSandboxTool(server_id, bare_tool_name) ||
    (server_id === SANDBOX_SERVER_ID && bare_tool_name === LIVE_SITE_IMAGES_VERB)
  );
}

export const SANDBOX_WRITE_NOTICE_VERBS: ReadonlySet<string> = new Set([
  "write_file",
  "run_bash",
  "str_replace",
  "create",
  "insert",
]);

export type LiveSandboxHooks = {
  notifyWrite: (toolName: string, path?: string) => Promise<void>;
  runSiteImages?: (args: unknown) => Promise<unknown>;
};

export function shouldDropSandboxToolFromOpenAi(
  server_id: string | undefined,
  bare_tool_name: string | undefined,
): boolean {
  return (
    server_id === SANDBOX_SERVER_ID &&
    !!bare_tool_name &&
    (SANDBOX_TOOL_NAMES as readonly string[]).includes(bare_tool_name)
  );
}

export const SHADOW_EXCLUDED_SANDBOX_TOOLS: ReadonlySet<SandboxToolName> = new Set([
  "emit_artifact",
  "stage_preview",
]);

type ShadowSandboxToolName = Exclude<
  SandboxToolName,
  "emit_artifact" | "stage_preview"
>;
export const SHADOW_SANDBOX_TOOL_NAMES: readonly ShadowSandboxToolName[] =
  SANDBOX_TOOL_NAMES.filter(
    (n): n is ShadowSandboxToolName =>
      !SHADOW_EXCLUDED_SANDBOX_TOOLS.has(n),
  );

const SHADOW_SHELL_EXEC_VERBS: ReadonlySet<SandboxToolName> = new Set([
  "run_bash",
  "run_tests",
  "app_verify",
]);
const SHADOW_RAW_READ_VERBS: ReadonlySet<SandboxToolName> = new Set([
  "read_file",
  "view",
]);
const LIVE_RAW_READ_VERBS: ReadonlySet<SandboxToolName> = new Set([
  ...SHADOW_RAW_READ_VERBS,
  "emit_artifact",
]);

export type SandboxExecutorMode = "shadow" | "live";

export const CANONICAL_SANDBOX_TOOL_PREFIX = `${SANDBOX_SERVER_ID}__`;
export const CANONICAL_SANDBOX_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  toCanonicalSandboxName("read_file"),
  toCanonicalSandboxName("view"),
  toCanonicalSandboxName("git_diff"),
  toCanonicalSandboxName("git_status"),
]);

type JsonSchema = { type: "object"; [k: string]: unknown };

const SANDBOX_TOOL_DEFS: Record<SandboxToolName, { description: string; jsonSchema: JsonSchema }> = {
  write_file: {
    description:
      "Write a file in the sandbox at the given path (relative to /home/user/repo). Creates parent dirs if needed. Replaces file content if it already exists.",
    jsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  read_file: {
    description:
      "Read a file from the sandbox. Response capped at 8KB; longer files truncated with [truncated N bytes] marker. Limited to 24 reads per agent_run; further reads return read_cap_exceeded so you summarize and emit your envelope.",
    jsonSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
    },
  },
  run_bash: {
    description:
      "Run an arbitrary shell command in the sandbox at /home/user/repo. Returns {stdout, stderr, exit_code}. Timeout default 60s, max 120s.",
    jsonSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 120 },
      },
      required: ["command"],
    },
  },
  run_tests: {
    description:
      "Convenience wrapper around the test command (default `npm test`). Returns {stdout, stderr, exit_code}.",
    jsonSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 300 },
      },
      required: [],
    },
  },
  git_diff: {
    description:
      "Show the unified diff of all current uncommitted changes in the sandbox vs HEAD (the tree the run started from — exactly what your write_file/str_replace calls produced, and what the PR will ship). Optionally pass {path} (repo-relative, no '..' or leading '/') to diff a single file. When output caps are on, a large diff returns a STRUCTURED payload {summary, files:[{path,status,truncated,diff}], omitted:[{path,approx_bytes}]}: complete per-file diffs in order until the byte budget fills, the rest listed in `omitted` (never silently dropped) — re-call git_diff({path}) to see an omitted or truncated file in full.",
    jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: [] },
  },
  git_status: {
    description:
      "Show files changed in the sandbox (added / modified / deleted).",
    jsonSchema: { type: "object", properties: {}, required: [] },
  },
  view: {
    description:
      "View a file in the sandbox at a repo-relative path (e.g. 'apps/web/src/page.tsx'). Returns content with 1-indexed line numbers. Optional view_range narrows to [start_line, end_line] inclusive. Capped at 8KB; longer files are truncated. Limited to 24 views per agent_run.",
    jsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        view_range: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          minItems: 2,
          maxItems: 2,
        },
      },
      required: ["path"],
    },
  },
  str_replace: {
    description:
      "Replace an exact-match string in a file. `old_str` MUST appear EXACTLY ONCE in the file — if it appears zero times OR more than once, the tool fails loud (no silent partial replace). Include 2-3 lines of surrounding context in old_str to make matches unique. path is repo-relative.",
    jsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        old_str: { type: "string", minLength: 1 },
        new_str: { type: "string" },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  create: {
    description:
      "Create a new file at a repo-relative path. Fails with `already_exists` if the file is already present — use `str_replace` to modify existing files. Creates parent directories as needed.",
    jsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        file_text: { type: "string" },
      },
      required: ["path", "file_text"],
    },
  },
  insert: {
    description:
      "Insert text after the given 1-indexed line number. `insert_line=0` inserts at the very beginning. Path is repo-relative.",
    jsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        insert_line: { type: "integer", minimum: 0 },
        new_str: { type: "string" },
      },
      required: ["path", "insert_line", "new_str"],
    },
  },
  app_verify: {
    description:
      "Boot the app inside the sandbox, wait for it to be ready, send ONE HTTP request to a localhost path, and assert the response status (optionally that the body contains a substring), then tear the app down. Use this AFTER run_tests when you changed an HTTP route/handler, to confirm the running app actually serves the expected response. Binds to localhost only.",
    jsonSchema: { type: "object", ...zodToJsonSchema(appVerifyInputSchema) },
  },
  run_typecheck: {
    description:
      "Run the repo's TypeScript typecheck. No arguments: the platform picks the command (the changed package's `typecheck`/`type-check` npm script, else the installed tsc with its tsconfig). Returns {status: passed|failed|couldnt_run, command, error_count, errors, truncated}.",
    jsonSchema: { type: "object", properties: {}, required: [] },
  },
  stage_preview: {
    description:
      "Stage a static Engineer design preview in private server-managed storage. The backend validates size, sanitizes active and network-capable content, re-derives run ownership, and permits at most one retry. On success, copy the returned small metadata object into the final <html_preview> block; never place HTML in that block.",
    jsonSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        summary: { type: "string", maxLength: 4000 },
        html: { type: "string", minLength: 1 },
        design_spec: {
          type: "object",
          properties: {
            components: { type: "array", items: { type: "string", maxLength: 160 }, maxItems: 24 },
            native_controls: { type: "array", items: { type: "string", maxLength: 160 }, maxItems: 24 },
            palette: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 16 },
            spacing: { type: "string", maxLength: 240 },
            cta_states: { type: "string", maxLength: 400 },
          },
        },
      },
      required: ["title", "summary", "html"],
    },
  },
  emit_artifact: {
    description:
      "Deliver a file you wrote in the sandbox (PDF, CSV, XLSX, PPTX slide deck, or PNG image) to the user as a downloadable artifact. `path` is repo-relative (e.g. 'out/report.pdf'); `filename` is the name the user sees (extension must be .pdf/.csv/.xlsx/.pptx/.png). Optionally pass `channel_id` + `thread_ts` (from a prior slack tool) to also drop the file into that Slack thread. Returns {artifact_id, slack_ok}. Generate the file first (e.g. with run_bash + python/node — for .pptx use the python-pptx library, for a .png render an HTML page and screenshot it with headless chromium/playwright), THEN call this.",
    jsonSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        filename: { type: "string", minLength: 1 },
        title: { type: "string" },
        channel_id: { type: "string" },
        thread_ts: { type: "string" },
      },
      required: ["path", "filename"],
    },
  },
};

export function synthesizeSandboxEngineTools(
  declaredSandboxVerbs: readonly string[],
  mode: SandboxExecutorMode,
  opts: { siteImages?: boolean } = {},
): EngineToolSpec[] {
  const declared = new Set(declaredSandboxVerbs);
  const verbs: readonly SandboxToolName[] = mode === "shadow" ? SHADOW_SANDBOX_TOOL_NAMES : SANDBOX_TOOL_NAMES;
  const out: EngineToolSpec[] = [];
  for (const verb of verbs) {
    if (!declared.has(verb)) continue;
    const def = SANDBOX_TOOL_DEFS[verb];
    if (!def) continue;
    out.push({
      name: toCanonicalSandboxName(verb),
      description: def.description,
      jsonSchema: def.jsonSchema,
    });
  }
  if (mode === "live" && opts.siteImages) {
    out.push({
      name: `${SANDBOX_SERVER_ID}__${LIVE_SITE_IMAGES_VERB}`,
      description: SITE_IMAGES_TOOL_DESCRIPTION,
      jsonSchema: { type: "object", ...zodToJsonSchema(z.object(siteImagesToolInput)) },
    });
  }
  return out;
}

export function synthesizeShadowSandboxEngineTools(
  declaredSandboxVerbs: readonly string[],
): EngineToolSpec[] {
  return synthesizeSandboxEngineTools(declaredSandboxVerbs, "shadow");
}

export function makeSandboxExecutor(
  deps: SandboxToolDeps,
  mode: SandboxExecutorMode,
  hooks?: LiveSandboxHooks,
) {
  const rawReadVerbs = mode === "live" ? LIVE_RAW_READ_VERBS : SHADOW_RAW_READ_VERBS;
  const liveHooks = mode === "live" ? hooks : undefined;
  return async function executeSandboxTool(
    verb: LiveSandboxVerb,
    args: unknown,
  ): Promise<EngineToolResult> {
    if (verb === LIVE_SITE_IMAGES_VERB) {
      if (!liveHooks?.runSiteImages) {
        return {
          is_error: true,
          content: JSON.stringify({ error: "tool_not_available", message: "add_site_images is only available on website builds and edits." }),
          ms: 0,
          code: "tool_not_available",
          denied: true,
        };
      }
      const started = Date.now();
      try {
        const out = await liveHooks.runSiteImages(args);
        void liveHooks.notifyWrite(LIVE_SITE_IMAGES_VERB, "public/images");
        return { is_error: false, content: JSON.stringify(out), ms: Date.now() - started, denied: false };
      } catch (e) {
        return {
          is_error: true,
          content: JSON.stringify({ error: "site_images_failed", message: (e as Error).message.slice(0, 300) }),
          ms: Date.now() - started,
          code: "site_images_failed",
          denied: false,
        };
      }
    }
    if (mode === "shadow" && SHADOW_EXCLUDED_SANDBOX_TOOLS.has(verb)) {
      return {
        is_error: true,
        content: JSON.stringify({
          error: "shadow_emit_artifact_disabled",
          message:
            "emit_artifact is disabled in shadow mode (it has live Slack/storage side effects). Summarize what the artifact would contain in your envelope instead.",
        }),
        ms: 0,
        code: "shadow_emit_artifact_disabled",
        denied: true,
      };
    }

    const a = (args ?? {}) as Record<string, unknown>;
    if (SHADOW_SHELL_EXEC_VERBS.has(verb)) {
      const cmd =
        typeof a.command === "string"
          ? a.command
          : typeof a.start_cmd === "string"
            ? a.start_cmd
            : "";
      if (cmd) {
        let verdict: ReturnType<typeof inspectShellCommand>;
        try {
          verdict = inspectShellCommand(cmd);
        } catch {
          verdict = {
            deny: true,
            reason: "Blocked: shell-command inspection errored; failing closed (the command was not executed).",
          };
        }
        if (verdict.deny) {
          return {
            is_error: true,
            content: JSON.stringify({
              error: "sandbox_egress_blocked",
              message: verdict.reason,
            }),
            ms: 0,
            code: "sandbox_egress_blocked",
            denied: true,
          };
        }
      }
    } else if (rawReadVerbs.has(verb)) {
      const path = typeof a.path === "string" ? a.path : "";
      if (path && isSecretPath(path)) {
        return {
          is_error: true,
          content: JSON.stringify({
            error: "sandbox_secret_read_blocked",
            message: secretReadDenyReason(path),
          }),
          ms: 0,
          code: "sandbox_secret_read_blocked",
          denied: true,
        };
      }
    }

    const started = Date.now();
    const fn = sandboxToolRegistry[verb];
    const result = await (fn as (
      d: SandboxToolDeps,
      a: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>)(
      deps,
      args,
    );
    if (liveHooks && SANDBOX_WRITE_NOTICE_VERBS.has(verb)) {
      void liveHooks.notifyWrite(verb, verb === "run_bash" ? undefined : typeof a.path === "string" ? a.path : undefined);
    }
    const text = result.content?.[0]?.text ?? "";
    let code: string | undefined;
    if (result.isError) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string") code = parsed.error;
      } catch {
      }
    }
    return {
      is_error: result.isError === true,
      content: text,
      ms: Date.now() - started,
      code,
      denied: false,
    };
  };
}

export const makeShadowSandboxExecutor = (deps: SandboxToolDeps) => makeSandboxExecutor(deps, "shadow");

export type SandboxExecutor = ReturnType<typeof makeSandboxExecutor>;
export type ShadowSandboxExecutor = SandboxExecutor;
