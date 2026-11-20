
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: vi.fn() }) }));

import {
  PREVIEW_DENIED_TOOLS,
  PREVIEW_READ_TOOLS,
  isPreviewAllowedTool,
} from "../preview-tools";
import { SDK_HARNESS_META_TOOLS } from "@/services/agents/sdk-builtins";
import { isDryPreviewRun, planIncludesChannel } from "../preview-plan";
import { stripDryPreviewResult } from "../preview-dry-run";
import { makeDispatchTool, type MakeDispatchToolDeps } from "@/services/agents/engine/dispatch-tool";
import { preToolUsePolicyHook } from "@/services/agents/pre-tool-use-policy";
import type { DispatcherResult } from "@/services/agents/types";
import type { TierGateConfig } from "@/services/agents/entitlement";

const STARTER_CHANNELS = ["seo", "geo", "linkedin_organic", "reddit_organic", "x_organic", "instagram_organic"];

function agentTools(slug: string): string[] {
  const md = fs.readFileSync(path.resolve(__dirname, `../../../agents/${slug}/agent.md`), "utf8");
  const fm = md.split(/^---$/m)[1] ?? "";
  const out: string[] = [];
  let inTools = false;
  for (const line of fm.split("\n")) {
    if (/^\s+tools:\s*$/.test(line)) {
      inTools = true;
      continue;
    }
    if (!inTools) continue;
    const m = /^\s+-\s+([A-Za-z0-9_.-]+)/.exec(line);
    if (m) out.push(m[1]!);
    else if (/^\s*[a-z_]+:/i.test(line) && !/^\s*#/.test(line)) inTools = false;
  }
  return out;
}

describe("preview tool allowlist", () => {
  it("classifies every tool each Starter channel lists (a new tool fails here until classified)", () => {
    for (const slug of STARTER_CHANNELS) {
      const tools = agentTools(slug);
      expect(tools.length, `${slug} lists no tools: parser broke`).toBeGreaterThan(3);
      for (const t of tools) {
        expect(
          PREVIEW_READ_TOOLS.has(t) || PREVIEW_DENIED_TOOLS.has(t),
          `${slug}: tool ${t} is in neither PREVIEW_READ_TOOLS nor PREVIEW_DENIED_TOOLS`,
        ).toBe(true);
      }
    }
  });

  it("no tool is both allowed and denied", () => {
    for (const t of PREVIEW_READ_TOOLS) expect(PREVIEW_DENIED_TOOLS.has(t)).toBe(false);
  });

  it("allows named reads in bare and SDK-wrapped form, denies everything else", () => {
    expect(isPreviewAllowedTool("web_search__search")).toBe(true);
    expect(isPreviewAllowedTool("mcp__praxis-server__web_search__search")).toBe(true);
    expect(isPreviewAllowedTool("praxis__remind")).toBe(false);
    expect(isPreviewAllowedTool("mcp__praxis-server__report__generate_image")).toBe(false);
    expect(isPreviewAllowedTool("memory__write")).toBe(false);
    expect(isPreviewAllowedTool("some_future__tool")).toBe(false);
    expect(isPreviewAllowedTool("")).toBe(false);
  });

  it("allows the side-effect-free SDK meta tools on their exact name only", () => {
    expect(isPreviewAllowedTool("ToolSearch")).toBe(true);
    expect(isPreviewAllowedTool("StructuredOutput")).toBe(true);
    expect(isPreviewAllowedTool("mcp__praxis-server__ToolSearch")).toBe(false);
    expect(isPreviewAllowedTool("mcp__x__StructuredOutput")).toBe(false);
    for (const t of ["Skill", "Bash", "Write", "WebFetch", "Task", "AskUserQuestion"]) {
      expect(isPreviewAllowedTool(t), t).toBe(false);
    }
    for (const t of SDK_HARNESS_META_TOOLS) expect(PREVIEW_DENIED_TOOLS.has(t)).toBe(false);
  });
});

describe("stripDryPreviewResult", () => {
  it("keeps usage and action types, drops every text field", () => {
    const CANARY = "CANARY-4f1c";
    const full = {
      output_text: CANARY,
      parsed: { steps: [{ title: CANARY }] },
      parse_ok: true,
      parse_error: CANARY,
      customer_summary: CANARY,
      assistant_turns: [CANARY],
      raw_response_text: CANARY,
      prompt_snapshot: CANARY,
      usage: { input_tokens: 10, output_tokens: 5 },
      tool_calls: [{ name: "web_fetch__fetch", input_preview: CANARY, output_preview: CANARY, ms: 1, status: "ok" }],
      open_actions: [{ title: CANARY }],
      side_effect: { kind: "shipped", detail: CANARY },
      preview_action_types: ["fix", "page"],
      future_field_nobody_listed: CANARY,
    } as unknown as DispatcherResult;
    const out = stripDryPreviewResult(full);
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(out.preview_action_types).toEqual(["fix", "page"]);
    expect(out.parse_ok).toBe(true);
  });
});

describe("isDryPreviewRun", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const preview = {
    tenant_id: T,
    agent_slug: "seo",
    trigger: "channel_recipe" as const,
    enqueued_by: null,
    cron_dedupe_key: `first-run-preview:${T}:seo`,
  };
  const cfg = (over: Partial<TierGateConfig> = {}): TierGateConfig => ({
    enforced: true,
    agentMin: { seo: "starter" },
    proTenants: [],
    alwaysPro: [],
    ...over,
  });

  it("a preview run on a channel the plan does not include is dry", async () => {
    expect(
      await isDryPreviewRun(preview, { loadConfig: async () => cfg(), resolveTier: async () => "free" }),
    ).toBe(true);
  });

  it("the same run after upgrade is not dry", async () => {
    expect(
      await isDryPreviewRun(preview, { loadConfig: async () => cfg(), resolveTier: async () => "starter" }),
    ).toBe(false);
  });

  it("any other run is never dry, and costs no plan read", async () => {
    const loadConfig = vi.fn(async () => cfg());
    expect(await isDryPreviewRun({ ...preview, cron_dedupe_key: null }, { loadConfig })).toBe(false);
    expect(await isDryPreviewRun({ ...preview, enqueued_by: "user-1" }, { loadConfig })).toBe(false);
    expect(await isDryPreviewRun({ ...preview, trigger: "chat" as never }, { loadConfig })).toBe(false);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED: an unreadable config or subscription means dry", async () => {
    expect(await isDryPreviewRun(preview, { loadConfig: async () => cfg({ deferred: true }) })).toBe(true);
    expect(
      await isDryPreviewRun(preview, {
        loadConfig: async () => cfg(),
        resolveTier: async () => {
          throw new Error("db down");
        },
      }),
    ).toBe(true);
    expect(await planIncludesChannel(T, "seo", { loadConfig: async () => { throw new Error("x"); } })).toBe(false);
  });
});

describe("tool gates on a preview_dry run", () => {
  function funnel(preview_dry: boolean) {
    const callSpy = vi.fn().mockResolvedValue({ ok: true, content: "{}", is_error: false, ms: 1 });
    const deps: MakeDispatchToolDeps = {
      isToolAllowed: async () => ({ allowed: true }),
      evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
      shouldDenyPmOperatorDb: () => false,
      isAgentKilled: async () => false,
      callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
      tenant_id: "t1",
      agent_slug: "seo",
      baseCallCtx: { tenant_id: "t1", run_id: "r1" },
      onEvent: () => {},
      iter: { value: 1 },
      preview_dry,
    };
    return { dispatchTool: makeDispatchTool(deps), callSpy };
  }

  it("engine funnel: a write tool is denied and never called", async () => {
    const { dispatchTool, callSpy } = funnel(true);
    const res = await dispatchTool({ tool_name: "praxis__remind", input: {}, tool_use_id: "tu-1" });
    expect(res.denied).toBe(true);
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("engine funnel: a named read still runs", async () => {
    const { dispatchTool, callSpy } = funnel(true);
    await dispatchTool({ tool_name: "web_fetch__fetch", input: { url: "https://example.com" }, tool_use_id: "tu-2" });
    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  it("engine funnel: nothing changes on a normal run", async () => {
    const { dispatchTool, callSpy } = funnel(false);
    await dispatchTool({ tool_name: "praxis__remind", input: {}, tool_use_id: "tu-3" });
    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  it("SDK PreToolUse hook: denies a write tool on a preview_dry run", async () => {
    const out = await preToolUsePolicyHook({
      isAgentKilled: async () => false,
      emitThreadEvent: vi.fn(),
      ctx: {
        tenant_id: "t1",
        agent: { slug: "seo" },
        runId: "r1",
        thread_id: null,
        killed: { value: false },
        iter: { value: 1 },
        preview_dry: true,
      },
      hookInput: {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__praxis-server__report__render_blog",
        tool_input: {},
        tool_use_id: "tu-4",
        cwd: "/tmp",
        permission_mode: "default",
        session_id: "s",
        transcript_path: "/tmp/t",
      },
    } as never);
    expect(out.continue).toBeUndefined();
    expect((out.hookSpecificOutput as { permissionDecision?: string }).permissionDecision).toBe("deny");
    expect(out.reason).toBe("preview_readonly");
  });
});
