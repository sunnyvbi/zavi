import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  engineerStepCap,
  engineerTaskText,
  isEngineerCodeRun,
  makeStepBudgetHook,
  stepBudgetWarning,
} from "@/services/agents/engineer-cost-v2";
import {
  SOCIAL_PUBLISH_HANDOFF_INSTRUCTION,
  buildStablePromptPrefix,
  loadCoreInheritedBlocks,
} from "@/services/agents/generic-dispatcher";

describe("engineerStepCap", () => {
  it("gives 40 steps on Sonnet 5.5 and 80 on Opus 5.5 when v2 is on", () => {
    expect(engineerStepCap({ agentSlug: "engineer", model: "claude-sonnet-5-5", costV2Enabled: true })).toBe(40);
    expect(engineerStepCap({ agentSlug: "engineer", model: "claude-opus-5-5", costV2Enabled: true })).toBe(80);
  });

  it("keeps 40 steps for a thread still sticky on Sonnet 5", () => {
    expect(engineerStepCap({ agentSlug: "engineer", model: "claude-sonnet-5", costV2Enabled: true })).toBe(40);
  });

  it("returns null (agent.md cap, 100 for the engineer) when v2 is off", () => {
    expect(engineerStepCap({ agentSlug: "engineer", model: "claude-sonnet-5", costV2Enabled: false })).toBeNull();
    expect(engineerStepCap({ agentSlug: "engineer", model: "claude-opus-5-5", costV2Enabled: false })).toBeNull();
  });

  it("returns null for any other agent or model", () => {
    expect(engineerStepCap({ agentSlug: "operator", model: "claude-opus-5-5", costV2Enabled: true })).toBeNull();
    expect(engineerStepCap({ agentSlug: "engineer", model: "claude-opus-4-7", costV2Enabled: true })).toBeNull();
  });
});

describe("stepBudgetWarning", () => {
  it("is silent below 75% of the cap", () => {
    expect(stepBudgetWarning(29, 40)).toBeNull();
    expect(stepBudgetWarning(59, 80)).toBeNull();
  });

  it("from 75% says how many steps are left and how to hand back", () => {
    expect(stepBudgetWarning(30, 40)).toMatch(/^10 steps left: finish or hand back\./);
    expect(stepBudgetWarning(60, 80)).toMatch(/^20 steps left: finish or hand back\./);
    expect(stepBudgetWarning(30, 40)).toContain('"incomplete": true');
    expect(stepBudgetWarning(30, 40)).toContain('"remaining"');
  });

  it("never goes negative past the cap", () => {
    expect(stepBudgetWarning(45, 40)).toMatch(/^0 steps left/);
  });
});

describe("makeStepBudgetHook", () => {
  it("counts calls in PreToolUse and adds the warning as PostToolUse additionalContext from 75%", async () => {
    const b = makeStepBudgetHook(4);
    await b.pre();
    expect(await b.hook({ hook_event_name: "PostToolUse" })).toEqual({});
    await b.pre();
    expect(await b.hook({ hook_event_name: "PostToolUse" })).toEqual({});
    await b.pre();
    const third = await b.hook({ hook_event_name: "PostToolUse" });
    expect(third.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(third.hookSpecificOutput?.additionalContext).toMatch(/^1 steps left/);
    await b.pre();
    const fourth = await b.hook({ hook_event_name: "PostToolUseFailure" });
    expect(fourth.hookSpecificOutput?.hookEventName).toBe("PostToolUseFailure");
    expect(b.used()).toBe(4);
  });

  it("sequential exhaustion: the first tool call from a later turn stops the run", async () => {
    let stopCalls = 0;
    const b = makeStepBudgetHook(2, () => {
      stopCalls += 1;
    });
    b.noteAssistantMessage("m1");
    expect(await b.pre()).toEqual({});
    b.noteAssistantMessage("m2");
    expect(await b.pre()).toEqual({});
    b.noteAssistantMessage("m3");
    const stop = await b.pre();
    expect(stop.continue).toBe(false);
    expect(stop.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(b.stopped()).toBe(true);
    expect(stopCalls).toBe(1);
    expect((await b.pre()).continue).toBe(false);
    expect(stopCalls).toBe(1);
    expect(b.used()).toBe(2);
  });

  it("parallel exhaustion: same-turn extras are denied, the next turn's call stops", async () => {
    const b = makeStepBudgetHook(2);
    b.noteAssistantMessage("msg_1");
    const [x, y, z] = await Promise.all([b.pre(), b.pre(), b.pre()]);
    expect(x).toEqual({});
    expect(y).toEqual({});
    expect(z.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(z.hookSpecificOutput?.permissionDecisionReason).toMatch(/hand back now/);
    expect(z.hookSpecificOutput?.permissionDecisionReason).toMatch(/"incomplete": true/);
    expect(z).not.toHaveProperty("continue");
    b.noteAssistantMessage("msg_1");
    expect(await b.pre()).not.toHaveProperty("continue");
    expect(b.stopped()).toBe(false);
    b.noteAssistantMessage("msg_2");
    expect((await b.pre()).continue).toBe(false);
    expect(b.stopped()).toBe(true);
  });

  it("a hand-back without a tool call is never stopped", async () => {
    const b = makeStepBudgetHook(1);
    b.noteAssistantMessage("m1");
    await b.pre();
    b.noteAssistantMessage("m2");
    expect(b.stopped()).toBe(false);
  });

  it("ToolSearch calls do not use up step budget", async () => {
    const b = makeStepBudgetHook(2);
    b.noteAssistantMessage("m1");
    for (let i = 0; i < 5; i++) expect(await b.pre({ tool_name: "ToolSearch" })).toEqual({});
    expect(b.used()).toBe(0);
    expect(b.exhausted()).toBe(false);
    expect(await b.pre({ tool_name: "mcp__sandbox__read_file" })).toEqual({});
    expect(b.used()).toBe(1);
  });

  it("after the cap, StructuredOutput in a later turn is the hand-back and is allowed", async () => {
    let stopCalls = 0;
    const b = makeStepBudgetHook(1, () => {
      stopCalls += 1;
    });
    b.noteAssistantMessage("m1");
    await b.pre({ tool_name: "mcp__sandbox__read_file" });
    expect(await b.pre({ tool_name: "StructuredOutput" })).toEqual({});
    b.noteAssistantMessage("m2");
    expect(await b.pre({ tool_name: "StructuredOutput" })).toEqual({});
    expect(await b.pre({ tool_name: "ToolSearch" })).toEqual({});
    expect(b.stopped()).toBe(false);
    expect(stopCalls).toBe(0);
    expect(b.used()).toBe(1);
    expect(b.exhausted()).toBe(true);
  });

  it("after the cap, a real tool call in a later turn still stops the run", async () => {
    let stopCalls = 0;
    const b = makeStepBudgetHook(1, () => {
      stopCalls += 1;
    });
    b.noteAssistantMessage("m1");
    await b.pre({ tool_name: "mcp__sandbox__read_file" });
    b.noteAssistantMessage("m2");
    expect(await b.pre({ tool_name: "StructuredOutput" })).toEqual({});
    const stop = await b.pre({ tool_name: "mcp__sandbox__write_file" });
    expect(stop.continue).toBe(false);
    expect(b.stopped()).toBe(true);
    expect(stopCalls).toBe(1);
  });

  it("a prefixed lookalike (mcp__x__StructuredOutput) is counted and stopped like any tool", async () => {
    const b = makeStepBudgetHook(1);
    b.noteAssistantMessage("m1");
    expect(await b.pre({ tool_name: "mcp__x__StructuredOutput" })).toEqual({});
    expect(b.used()).toBe(1);
    b.noteAssistantMessage("m2");
    expect((await b.pre({ tool_name: "mcp__x__ToolSearch" })).continue).toBe(false);
    expect(b.stopped()).toBe(true);
  });

  it("the steps-left warning skips harness meta tools", async () => {
    const b = makeStepBudgetHook(4);
    await b.pre();
    await b.pre();
    await b.pre();
    expect(
      (await b.hook({ hook_event_name: "PostToolUse", tool_name: "mcp__sandbox__read_file" }))
        .hookSpecificOutput?.additionalContext,
    ).toMatch(/^1 steps left/);
    expect(await b.hook({ hook_event_name: "PostToolUse", tool_name: "ToolSearch" })).toEqual({});
    expect(await b.hook({ hook_event_name: "PostToolUse", tool_name: "StructuredOutput" })).toEqual({});
  });

  it("keeps one counter per instance (per run attempt)", async () => {
    const a = makeStepBudgetHook(40);
    const b = makeStepBudgetHook(40);
    await a.pre();
    await a.pre();
    expect(a.used()).toBe(2);
    expect(b.used()).toBe(0);
  });
});

describe("isEngineerCodeRun", () => {
  it("chat: only a ship intent is a code run", () => {
    expect(isEngineerCodeRun("chat", { cto_chat_intent: "ship", current_message: "fix it" })).toBe(true);
    expect(isEngineerCodeRun("chat", { cto_chat_intent: "info", current_message: "why?" })).toBe(false);
    expect(isEngineerCodeRun("chat", { cto_chat_intent: "ambiguous", current_message: "hm" })).toBe(false);
    expect(isEngineerCodeRun("chat", { current_message: "hi" })).toBe(false);
  });

  it("handoff / a2a / slack / manual with a task are code runs; without one they are not", () => {
    expect(isEngineerCodeRun("handoff", { intent: "add a banner" })).toBe(true);
    expect(isEngineerCodeRun("a2a", { task_description: "rename X" })).toBe(true);
    expect(isEngineerCodeRun("slack", { text: "fix the footer" })).toBe(true);
    expect(isEngineerCodeRun("manual", { intent: "bump dep" })).toBe(true);
    expect(isEngineerCodeRun("manual", {})).toBe(false);
    expect(isEngineerCodeRun("cron", { intent: "x" })).toBe(false);
  });

  it("a build-pipeline stage is always a code run", () => {
    expect(isEngineerCodeRun("a2a", { stage: "scaffold" })).toBe(true);
  });
});

describe("engineerTaskText", () => {
  it("prefers the chat turn, then user text, task, brief", () => {
    expect(engineerTaskText({ current_message: " a ", intent: "b" })).toBe("a");
    expect(engineerTaskText({ current_user_text_raw: "u", intent: "b" })).toBe("u");
    expect(engineerTaskText({ task_description: "t", intent: "b" })).toBe("t");
    expect(engineerTaskText({ intent: "b" })).toBe("b");
    expect(engineerTaskText(null)).toBe("");
  });
});

describe("item 8 prompt drops (engineer + v2 only)", () => {
  it("the social publish footer is still in every prompt unless omitted", () => {
    const base = { body_markdown: "x", memory: { company: "", ops: "" } };
    expect(buildStablePromptPrefix(base)).toContain(SOCIAL_PUBLISH_HANDOFF_INSTRUCTION);
    expect(buildStablePromptPrefix({ ...base, omitSocialPublishHandoff: false })).toContain(
      SOCIAL_PUBLISH_HANDOFF_INSTRUCTION,
    );
    expect(buildStablePromptPrefix({ ...base, omitSocialPublishHandoff: true })).not.toContain(
      SOCIAL_PUBLISH_HANDOFF_INSTRUCTION,
    );
  });

  it("dropping output-shaping reuses the variant drop mechanism", () => {
    const inherits = ["security-hard-rules", "agent-chat-voice"];
    const full = loadCoreInheritedBlocks(inherits);
    const dropped = loadCoreInheritedBlocks(inherits, ["output-shaping"]);
    expect(dropped.length).toBeLessThan(full.length);
    expect(loadCoreInheritedBlocks(inherits, ["security-hard-rules"])).toBe(full);
  });

  it("the dispatcher gates every drop and the step cap on engineer + ctx.engineer_cost_v2", () => {
    const src = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf-8");
    expect(src).toMatch(
      /const engineerCostV2 = ctx\.agent\.slug === "engineer" && ctx\.engineer_cost_v2 === true;/,
    );
    expect(src).toMatch(/engineerCostV2 \? \["operator_db"\] : \[\]/);
    expect(src).toMatch(/engineerCostV2 && isEngineerCodeRun\(ctx\.trigger, payload\)/);
    expect(src).toMatch(/omitSocialPublishHandoff: engineerCostV2/);
    expect(src).toMatch(/costV2Enabled: engineerCostV2 && !isPipelineStageRun/);
    expect(src).toMatch(
      /if \(stepBudgetStopped\) parseCapNote = "tool_iter_cap";/,
    );
    expect(src).toMatch(/stepBudget\?\.noteAssistantMessage\(/);
    expect(src).toMatch(
      /r\.subtype === "error_max_structured_output_retries" && stepBudget\?\.exhausted\(\)\) \{\s*stepBudgetStopped = true;/,
    );
    expect(src).toMatch(
      /variant\.config\.max_turns \?\?[\s\S]{0,200}\(engineerV2StepCap !== null \? engineerV2StepCap \+ STEP_HANDBACK_TURNS : null\) \?\?\s*ctx\.agent\.metadata_praxis\.tool_iter_cap \?\?\s*MAX_TOOL_ITERS/,
    );
    expect(src).toMatch(
      /\.\.\.\(stepBudget \? \[\{ hooks: \[async \(input: unknown\) => stepBudget\.pre\(input as PreToolUseHookInput\)\] \}\] : \[\]\)/,
    );
    expect(src).toMatch(/\.\.\.\(stepBudget\s*\?\s*\{\s*PostToolUse:/);
  });

  it("the runner sets engineer_cost_v2 only for an engineer run with the setting on", () => {
    const src = readFileSync(join(__dirname, "../runner.ts"), "utf-8");
    expect(src).toMatch(/claim\.agent_slug === "engineer"\s*\?\s*loadEngineerCostV2Config\(\)/);
    expect(src).toMatch(/\.\.\.\(engineerCostV2 \? \{ engineer_cost_v2: true \} : \{\}\)/);
  });
});
