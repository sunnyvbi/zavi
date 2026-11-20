import { describe, it, expect, vi } from "vitest";
import { preToolUsePolicyHook } from "../pre-tool-use-policy";
import type {
  PreToolUsePolicyCtx,
  PreToolUsePolicyDeps,
} from "../pre-tool-use-policy";

function makeCtx(o?: Partial<PreToolUsePolicyCtx>): PreToolUsePolicyCtx {
  return {
    tenant_id: "11111111-1111-1111-1111-111111111111",
    agent: { slug: "engineer" },
    runId: "run_x",
    thread_id: null,
    killed: { value: false },
    iter: { value: 0 },
    ...o,
  };
}
function deps(
  ctx: PreToolUsePolicyCtx,
  tool_name: string,
): PreToolUsePolicyDeps {
  return {
    isAgentKilled: vi.fn(async () => false),
    emitThreadEvent: vi.fn(async () => {}),
    ctx,
    hookInput: { tool_name, tool_input: {}, tool_use_id: "t1" } as never,
  };
}
const isDeny = (r: { continue?: boolean; hookSpecificOutput?: unknown }) =>
  r.continue === undefined &&
  (r.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === "deny";

describe("engineer read-only-on-info PreToolUse gate", () => {
  const writeTools = [
    "mcp__sandbox__write_file",
    "mcp__sandbox__create",
    "mcp__sandbox__str_replace",
    "mcp__sandbox__insert",
    "mcp__sandbox__run_bash",
    "mcp__sandbox__run_tests",
  ];
  const readTools = [
    "mcp__sandbox__read_file",
    "mcp__sandbox__view",
    "mcp__sandbox__git_diff",
    "mcp__sandbox__git_status",
  ];

  for (const t of writeTools) {
    it(`info intent → DENY mutating sandbox tool ${t}`, async () => {
      const r = await preToolUsePolicyHook(
        deps(makeCtx({ cto_chat_intent: "info" }), t),
      );
      expect(isDeny(r)).toBe(true);
      expect(
        (r as { hookSpecificOutput?: { permissionDecisionReason?: string } })
          .hookSpecificOutput?.permissionDecisionReason,
      ).toMatch(/read-only/);
    });
  }

  for (const t of readTools) {
    it(`info intent → ALLOW read-only sandbox tool ${t}`, async () => {
      const r = await preToolUsePolicyHook(
        deps(makeCtx({ cto_chat_intent: "info" }), t),
      );
      expect(r).toEqual({ continue: true });
    });
  }

  it("ship intent → ALLOW write tool (full access)", async () => {
    const r = await preToolUsePolicyHook(
      deps(makeCtx({ cto_chat_intent: "ship" }), "mcp__sandbox__write_file"),
    );
    expect(r).toEqual({ continue: true });
  });

  it("ambiguous intent → ALLOW write tool (full access)", async () => {
    const r = await preToolUsePolicyHook(
      deps(
        makeCtx({ cto_chat_intent: "ambiguous" }),
        "mcp__sandbox__str_replace",
      ),
    );
    expect(r).toEqual({ continue: true });
  });

  it("no cto_chat_intent (non-chat run) → ALLOW write tool", async () => {
    const r = await preToolUsePolicyHook(
      deps(makeCtx(), "mcp__sandbox__write_file"),
    );
    expect(r).toEqual({ continue: true });
  });

  it("OTHER agent in info intent → ALLOW (gate is engineer-scoped)", async () => {
    const r = await preToolUsePolicyHook(
      deps(
        makeCtx({ agent: { slug: "pm" }, cto_chat_intent: "info" }),
        "mcp__sandbox__write_file",
      ),
    );
    expect(r).toEqual({ continue: true });
  });

  it("info intent → non-sandbox tool (e.g. memory__search) is NOT denied", async () => {
    const r = await preToolUsePolicyHook(
      deps(makeCtx({ cto_chat_intent: "info" }), "memory__search"),
    );
    expect(r).toEqual({ continue: true });
  });

  it("info intent + kill switch flipped on a read tool → kill still wins (deny)", async () => {
    const ctx = makeCtx({ cto_chat_intent: "info" });
    const d: PreToolUsePolicyDeps = {
      isAgentKilled: vi.fn(async () => true),
      emitThreadEvent: vi.fn(async () => {}),
      ctx,
      hookInput: {
        tool_name: "mcp__sandbox__view",
        tool_input: {},
        tool_use_id: "t1",
      } as never,
    };
    const r = await preToolUsePolicyHook(d);
    expect(r.continue).toBe(false);
    expect(
      (r as { hookSpecificOutput?: { permissionDecisionReason?: string } })
        .hookSpecificOutput?.permissionDecisionReason,
    ).toBe("kill_switch");
  });
});
