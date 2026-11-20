
import { z } from "zod";
import type { AnyZodRawShape } from "@anthropic-ai/claude-agent-sdk";

type ToolRawShape = Record<string, z.ZodType>;
type SdkTool = typeof import("@anthropic-ai/claude-agent-sdk")["tool"];
function makeTool(sdkTool: SdkTool) {
  return function tool<S extends ToolRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (
      args: { [K in keyof S]: z.infer<S[K]> },
      extra: unknown,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>,
    alwaysLoad?: boolean,
  ) {
    return sdkTool(
      name,
      description,
      inputSchema as unknown as AnyZodRawShape,
      handler as never,
      alwaysLoad ? { alwaysLoad: true } : undefined,
    );
  };
}
import { getSandboxIdForRun } from "@/services/sandbox/lifecycle";
import type { LiveSandboxHooks } from "../engine/openai-sandbox-tools";
import {
  runSiteImagesTool,
  SITE_IMAGES_TOOL_DESCRIPTION,
  SITE_IMAGES_TOOL_NAME,
  siteImagesToolInput,
} from "@/services/site-images/sandbox-tool";
import {
  appVerifyInputSchema,
  type AppVerifyInput,
} from "@/services/tools/sandbox/app-verify";
import {
  sandboxToolRegistry,
  SANDBOX_TOOL_NAMES,
  SANDBOX_REPO_ROOT,
  type SandboxToolDeps,
} from "@/services/sandbox/tool-registry";

export { SANDBOX_TOOL_NAMES };
export {
  ARTIFACT_BUCKET,
  ARTIFACT_MAX_BYTES,
  sanitizeArtifactFilename,
  artifactMimeForFilename,
  artifactBytesMatchMime,
} from "@/services/sandbox/tool-registry";

const REPO_ROOT = SANDBOX_REPO_ROOT;

const readCounter = new Map<string, number>();
const viewCounter = new Map<string, number>();

export function bumpReadCounter(run_id: string): number {
  const next = (readCounter.get(run_id) ?? 0) + 1;
  readCounter.set(run_id, next);
  return next;
}

export function clearSandboxReadCounter(run_id: string): void {
  readCounter.delete(run_id);
  viewCounter.delete(run_id);
}

const CD_ABS_RE = /\bcd\s+\//;
const ABS_PATH_RE = /(?<![A-Za-z0-9_/\]-])\/[A-Za-z0-9_][A-Za-z0-9._/-]*/g;
const ALLOWED_ABS_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
const REL_PARENT_RE = /(?:^|[\s/='"])\.\.(?:$|[\s/;&|'")])/;
export function escapeGuardRefusal(command: string, root: string): string | null {
  if (CD_ABS_RE.test(command)) {
    return `refused: \`cd /<abs>\` is blocked in a worktree-isolated run. This run's repo root is \`${root}\` and is already your cwd — use relative paths (or absolute paths under that root).`;
  }
  if (REL_PARENT_RE.test(command)) {
    return `refused: parent-directory traversal (\`..\`) is blocked in a worktree-isolated run — it would escape into a sibling tree or the shared clone. This run's repo root is \`${root}\` (your cwd); stay at or below it.`;
  }
  for (const hit of command.matchAll(ABS_PATH_RE)) {
    const m = hit[0];
    const endsAtBracket = command[(hit.index ?? 0) + m.length] === "]";
    if (!endsAtBracket && (m === root || m.startsWith(`${root}/`) || ALLOWED_ABS_PATHS.has(m))) continue;
    return `refused: absolute path outside the worktree root \`${root}\` is blocked: \`${m}\``;
  }
  return null;
}

const SERVED_REPO_SERVER_RE =
  /(?:^|[\s;&|(])(?:npx\s+)?(?:next\s+(?:build|start|dev)|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|start|dev)|vite(?:\s+build)?)(?=$|[\s;&|)])/g;
const CD_TARGET_RE = /\bcd\s+([^\s;&|)]+)/g;

export function livePreviewRefusal(command: string): string | null {
  for (const hit of command.matchAll(SERVED_REPO_SERVER_RE)) {
    const before = command.slice(0, hit.index ?? 0);
    const cds = [...before.matchAll(CD_TARGET_RE)];
    const lastCd = cds.length ? cds[cds.length - 1][1] : null;
    if (lastCd && lastCd.startsWith("/tmp/")) continue;
    return `refused: \`${hit[0].trim()}\` would build or restart the app inside the repo the live preview serves, which turns the founder's preview into an unstyled page or a server error. Check types with run_typecheck, build a copy under /tmp/verify (the copy command in your instructions), and check a route with curl against http://127.0.0.1:3000.`;
  }
  return null;
}

export function bumpViewCounter(run_id: string): number {
  const next = (viewCounter.get(run_id) ?? 0) + 1;
  viewCounter.set(run_id, next);
  return next;
}

export type SandboxToolCtx = {
  tenant_id: string;
  run_id: string;
  repo_full_name: string;
  known_sandbox_id?: string;
  onWrite?: (event: { tool: string; path?: string; sandbox_id: string }) => Promise<void> | void;
  declared_tools?: readonly string[];
  repo_root?: string;
  slack_team_id?: string;
  slack_post_blocked?: boolean;
  servesLivePreview?: boolean;
  capProfile?: "engineer" | "default";
  always_load_tools?: readonly string[];
  create_replace_pristine_paths?: readonly string[];
  site_images?: boolean;
  lazyProvision?: () => Promise<string>;
  resolveSandboxId?: () => Promise<string>;
};

export type BuildSandboxDepsInput = Pick<
  SandboxToolCtx,
  | "tenant_id"
  | "run_id"
  | "repo_full_name"
  | "known_sandbox_id"
  | "repo_root"
  | "servesLivePreview"
  | "resolveSandboxId"
  | "lazyProvision"
  | "slack_team_id"
  | "slack_post_blocked"
  | "capProfile"
  | "create_replace_pristine_paths"
>;

export function buildSandboxToolDeps(ctx: BuildSandboxDepsInput): SandboxToolDeps {
  const root = ctx.repo_root ?? REPO_ROOT;

  const STRICT_ISOLATION = ctx.repo_root != null && ctx.repo_root !== REPO_ROOT;
  function refusalFor(command: string): string | null {
    if (ctx.servesLivePreview) {
      const live = livePreviewRefusal(command);
      if (live) return live;
    }
    if (!STRICT_ISOLATION) return null;
    return escapeGuardRefusal(command, root);
  }
  let cachedSandboxId: string | null = null;
  let lazyProvisionInFlight: Promise<string> | null = null;
  async function getSandboxId(): Promise<string> {
    if (cachedSandboxId) return cachedSandboxId;
    if (ctx.resolveSandboxId) {
      cachedSandboxId = await ctx.resolveSandboxId();
      return cachedSandboxId;
    }
    const id = ctx.known_sandbox_id || (await getSandboxIdForRun(ctx.tenant_id, ctx.repo_full_name));
    if (id) {
      cachedSandboxId = id;
      return id;
    }
    if (ctx.lazyProvision) {
      if (!lazyProvisionInFlight) {
        lazyProvisionInFlight = ctx.lazyProvision().catch((e) => {
          lazyProvisionInFlight = null;
          throw e;
        });
      }
      const provisionedId = await lazyProvisionInFlight;
      cachedSandboxId = provisionedId;
      return provisionedId;
    }
    throw new Error(
      `no active sandbox for tenant=${ctx.tenant_id} repo=${ctx.repo_full_name}. Did resolveSandboxForRun run?`,
    );
  }

  const deps: SandboxToolDeps = {
    getSandboxId,
    root,
    refusalFor,
    run_id: ctx.run_id,
    bumpRead: bumpReadCounter,
    bumpView: bumpViewCounter,
    tenant_id: ctx.tenant_id,
    slack_team_id: ctx.slack_team_id,
    slack_post_blocked: ctx.slack_post_blocked,
    capProfile: ctx.capProfile,
    ...(ctx.create_replace_pristine_paths?.length ? { createReplacePristinePaths: ctx.create_replace_pristine_paths } : {}),
  };

  return deps;
}

export function makeSandboxWriteNotifier(
  onWrite: SandboxToolCtx["onWrite"],
  getSandboxId: () => Promise<string>,
): (toolName: string, path?: string) => Promise<void> {
  return async function notifyWrite(toolName: string, path?: string): Promise<void> {
    if (!onWrite) return;
    try {
      await onWrite({ tool: toolName, path, sandbox_id: await getSandboxId() });
    } catch {
      return;
    }
  };
}

export function buildLiveSandboxHooks(
  ctx: Pick<SandboxToolCtx, "onWrite" | "site_images" | "tenant_id" | "run_id">,
  deps: SandboxToolDeps,
): LiveSandboxHooks {
  return {
    notifyWrite: makeSandboxWriteNotifier(ctx.onWrite, deps.getSandboxId),
    ...(ctx.site_images
      ? {
          runSiteImages: (args: unknown) =>
            runSiteImagesTool(
              { tenant_id: ctx.tenant_id, run_id: ctx.run_id, root: deps.root, getSandboxId: deps.getSandboxId },
              args as Parameters<typeof runSiteImagesTool>[1],
            ),
        }
      : {}),
  };
}

export async function mcpSandbox(ctx: SandboxToolCtx) {
  const { createSdkMcpServer, tool: sdkTool } = await import(
    "@anthropic-ai/claude-agent-sdk"
  );
  const baseTool = makeTool(sdkTool);
  const alwaysLoad = new Set([...(ctx.always_load_tools ?? []), ...(ctx.site_images ? [SITE_IMAGES_TOOL_NAME] : [])]);
  const tool: typeof baseTool = (name, description, inputSchema, handler) =>
    baseTool(name, description, inputSchema, handler, alwaysLoad.has(name) || undefined);

  const deps = buildSandboxToolDeps(ctx);
  const root = deps.root;
  const getSandboxId = deps.getSandboxId;

  const notifyWrite = makeSandboxWriteNotifier(ctx.onWrite, getSandboxId);

  async function withWriteNotice<T>(toolName: string, path: string | undefined, run: () => Promise<T>): Promise<T> {
    const result = await run();
    void notifyWrite(toolName, path);
    return result;
  }

  const writeFileTool = tool(
    "write_file",
    `Write a file in the sandbox at the given path (relative to the repo root, ${root}). Creates parent dirs if needed. Replaces file content if it already exists.`,
    { path: z.string().min(1), content: z.string() },
    async (args) => withWriteNotice("write_file", args.path, () => sandboxToolRegistry.write_file(deps, args)),
  );

  const readFileTool = tool(
    "read_file",
    "Read a file from the sandbox. Response capped at 8KB; longer files truncated with [truncated N bytes] marker. Limited to 24 reads per agent_run; further reads return read_cap_exceeded so you summarize and emit your envelope.",
    { path: z.string().min(1) },
    async (args) => sandboxToolRegistry.read_file(deps, args),
  );

  const runBashTool = tool(
    "run_bash",
    `Run an arbitrary shell command in the sandbox; cwd is the repo root (${root}) — use relative paths. Returns {stdout, stderr, exit_code}. Timeout default 60s, max 120s.`,
    {
      command: z.string().min(1),
      timeout_seconds: z.number().int().min(1).max(120).default(60),
    },
    async (args) => withWriteNotice("run_bash", undefined, () => sandboxToolRegistry.run_bash(deps, args)),
  );

  const runTestsTool = tool(
    "run_tests",
    "Convenience wrapper around the test command (default `npm test`). Returns {stdout, stderr, exit_code}.",
    {
      command: z.string().min(1).default("npm test"),
      timeout_seconds: z.number().int().min(1).max(300).default(120),
    },
    async (args) => sandboxToolRegistry.run_tests(deps, args),
  );

  const gitDiffTool = tool(
    "git_diff",
    "Show the unified diff of all current uncommitted changes in the sandbox vs HEAD (the tree the run started from — exactly what your write_file/str_replace calls produced, and what the PR will ship). Optionally pass {path} (repo-relative, no '..' or leading '/') to diff a single file. When output caps are on, a large diff returns a STRUCTURED payload {summary, files:[{path,status,truncated,diff}], omitted:[{path,approx_bytes}]}: complete per-file diffs are included in order until the byte budget fills, and every file that did not fit is listed in `omitted` (never silently dropped) — re-call git_diff({path}) to see an omitted or truncated file in full.",
    { path: z.string().optional() },
    async (args) => sandboxToolRegistry.git_diff(deps, args),
  );

  const gitStatusTool = tool(
    "git_status",
    "Show files changed in the sandbox (added / modified / deleted).",
    {},
    async () => sandboxToolRegistry.git_status(deps, {}),
  );

  const viewTool = tool(
    "view",
    "View a file in the sandbox at a repo-relative path (e.g. 'apps/web/src/page.tsx'). Returns content with 1-indexed line numbers. Optional view_range narrows to [start_line, end_line] inclusive. Capped at 8KB; longer files are truncated. Limited to 24 views per agent_run.",
    {
      path: z.string().min(1),
      view_range: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
    },
    async (args) => sandboxToolRegistry.view(deps, args),
  );

  const strReplaceTool = tool(
    "str_replace",
    "Replace an exact-match string in a file. `old_str` MUST appear EXACTLY ONCE in the file — if it appears zero times OR more than once, the tool fails loud (no silent partial replace). Include 2-3 lines of surrounding context in old_str to make matches unique. path is repo-relative.",
    {
      path: z.string().min(1),
      old_str: z.string().min(1),
      new_str: z.string(),
    },
    async (args) => withWriteNotice("str_replace", args.path, () => sandboxToolRegistry.str_replace(deps, args)),
  );

  const createTool = tool(
    "create",
    ctx.create_replace_pristine_paths?.length
      ? `Create a new file at a repo-relative path. Fails with \`already_exists\` if the file is already present — use \`str_replace\` to modify existing files — except these starter placeholders, which \`create\` replaces while you have not changed them: ${ctx.create_replace_pristine_paths.join(", ")}. Creates parent directories as needed.`
      : "Create a new file at a repo-relative path. Fails with `already_exists` if the file is already present — use `str_replace` to modify existing files. Creates parent directories as needed.",
    {
      path: z.string().min(1),
      file_text: z.string(),
    },
    async (args) => withWriteNotice("create", args.path, () => sandboxToolRegistry.create(deps, args)),
  );

  const insertTool = tool(
    "insert",
    "Insert text after the given 1-indexed line number. `insert_line=0` inserts at the very beginning. Path is repo-relative.",
    {
      path: z.string().min(1),
      insert_line: z.number().int().min(0),
      new_str: z.string(),
    },
    async (args) => withWriteNotice("insert", args.path, () => sandboxToolRegistry.insert(deps, args)),
  );

  const stagePreviewTool = tool(
    "stage_preview",
    "Stage a static Engineer design preview in private server-managed storage. The backend validates size, sanitizes active and network-capable content, re-derives run ownership, and permits at most one retry. On success, copy the returned small metadata object into the final <html_preview> block; never place HTML in that block.",
    {
      title: z.string().min(1).max(120),
      summary: z.string().max(4000),
      html: z.string().min(1),
      design_spec: z
        .object({
          components: z.array(z.string().max(160)).max(24).optional(),
          native_controls: z.array(z.string().max(160)).max(24).optional(),
          palette: z.array(z.string().max(40)).max(16).optional(),
          spacing: z.string().max(240).optional(),
          cta_states: z.string().max(400).optional(),
        })
        .optional(),
    },
    async (args) => sandboxToolRegistry.stage_preview(deps, args),
  );

  const emitArtifactTool = tool(
    "emit_artifact",
    "Deliver a file you wrote in the sandbox (PDF, CSV, XLSX, PPTX slide deck, or PNG image) to the user as a downloadable artifact. `path` is repo-relative (e.g. 'out/report.pdf'); `filename` is the name the user sees (extension must be .pdf/.csv/.xlsx/.pptx/.png). Optionally pass `channel_id` + `thread_ts` (from a prior slack tool) to also drop the file into that Slack thread. Returns {artifact_id, slack_ok}. Generate the file first (e.g. with run_bash + python/node — for .pptx use the python-pptx library, for a .png render an HTML page and screenshot it with headless chromium/playwright), THEN call this.",
    {
      path: z.string().min(1),
      filename: z.string().min(1),
      title: z.string().optional(),
      channel_id: z.string().optional(),
      thread_ts: z.string().optional(),
    },
    async (args) => sandboxToolRegistry.emit_artifact(deps, args),
  );

  const appVerifyTool = tool(
    "app_verify",
    "Boot the app inside the sandbox, wait for it to be ready, send ONE HTTP request to a localhost path, and assert the response status (optionally that the body contains a substring), then tear the app down. Use this AFTER run_tests when you changed an HTTP route/handler, to confirm the running app actually serves the expected response. Binds to localhost only. Args: request_path (root-relative, e.g. '/api/health'), expected_status (default 200), optional expect_body_contains, port (default 3000), optional start_cmd (auto-detected from package.json when omitted), optional health_path, boot_timeout_seconds. Returns {ok, status, booted, body_matched, reason, output_tail}.",
    appVerifyInputSchema.shape,
    async (rawArgs) => sandboxToolRegistry.app_verify(deps, rawArgs as AppVerifyInput),
  );

  const runTypecheckTool = tool(
    "run_typecheck",
    "Run the repo's TypeScript typecheck. No arguments: the platform picks the command (the changed package's `typecheck`/`type-check` npm script, else the installed tsc with its tsconfig). Returns {status: passed|failed|couldnt_run, command, error_count, errors, truncated}. This result is the typecheck verdict the PR carries.",
    {},
    async () => sandboxToolRegistry.run_typecheck(deps, {}),
  );

  const allToolNames = SANDBOX_TOOL_NAMES;
  const allTools = [
    writeFileTool,
    readFileTool,
    runBashTool,
    runTestsTool,
    gitDiffTool,
    gitStatusTool,
    viewTool,
    strReplaceTool,
    createTool,
    insertTool,
    stagePreviewTool,
    emitArtifactTool,
    appVerifyTool,
    runTypecheckTool,
  ];

  const declared = ctx.declared_tools;
  const toolsToRegister = declared
    ? allTools.filter((_, i) => declared.includes(allToolNames[i]))
    : [...allTools];

  if (ctx.site_images) {
    const siteImagesTool = tool(SITE_IMAGES_TOOL_NAME, SITE_IMAGES_TOOL_DESCRIPTION, siteImagesToolInput, async (args) => {
      try {
        const out = await runSiteImagesTool({ tenant_id: ctx.tenant_id, run_id: ctx.run_id, root, getSandboxId }, args);
        void notifyWrite(SITE_IMAGES_TOOL_NAME, "public/images");
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "site_images_failed", message: (e as Error).message.slice(0, 300) }) }],
          isError: true,
        };
      }
    });
    toolsToRegister.push(siteImagesTool as unknown as (typeof allTools)[number]);
  }

  return createSdkMcpServer({
    name: "praxis-sandbox",
    version: "0.2.0",
    tools: toolsToRegister,
  });
}
