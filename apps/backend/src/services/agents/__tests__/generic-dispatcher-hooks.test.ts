
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dispatcherSrc = readFileSync(
  join(__dirname, "../generic-dispatcher.ts"),
  "utf-8",
);
const policySrc = readFileSync(
  join(__dirname, "../pre-tool-use-policy.ts"),
  "utf-8",
);

describe("generic-dispatcher — PreToolUse hook wiring (SDK branch)", () => {
  it("imports preToolUsePolicyHook from ./pre-tool-use-policy", () => {
    expect(dispatcherSrc).toMatch(
      /import \{ preToolUsePolicyHook \} from "\.\/pre-tool-use-policy"/,
    );
  });

  it("imports isAgentKilled from ./kill-switch (not from ./runner)", () => {
    expect(dispatcherSrc).toMatch(/import \{ isAgentKilled \} from "\.\/kill-switch"/);
    expect(dispatcherSrc).not.toMatch(/import \{[^}]*isAgentKilled[^}]*\} from "\.\/runner"/);
  });

  it("declares run-scoped killedRef + iterRef before the SDK query() call", () => {
    expect(dispatcherSrc).toMatch(/const killedRef = \{ value: false \}/);
    expect(dispatcherSrc).toMatch(/const iterRef = \{ value: 0 \}/);
  });

  it("registers hooks.PreToolUse with the matcher-array wrapper shape", () => {
    expect(dispatcherSrc).toMatch(/hooks:\s*\{\s*PreToolUse:\s*\[\{\s*hooks:\s*\[/);
  });

  it("PreToolUse closure passes all 4 deps to preToolUsePolicyHook", () => {
    expect(dispatcherSrc).toMatch(/preToolUsePolicyHook\(\{[\s\S]*?isAgentKilled,[\s\S]*?emitThreadEvent: teEmit,[\s\S]*?ctx:/);
    expect(dispatcherSrc).toMatch(/hookInput: input as PreToolUseHookInput/);
  });

  it("ctx passed to hook references killedRef + iterRef (so policy can mutate them)", () => {
    expect(dispatcherSrc).toMatch(/killed: killedRef/);
    expect(dispatcherSrc).toMatch(/iter: iterRef/);
  });

  it("outer for-await loop checks killedRef at iter-top + throws the resolved code", () => {
    expect(dispatcherSrc).toMatch(/for await \(const message of stream\) \{[\s\S]*?if \(killedRef\.value\) \{[\s\S]*?const code = stopped \? "run_cancelled" : "kill_switch";[\s\S]*?throw new Error\(code\)/);
  });

  it("emits 'failed' progress (NOT a new stage) with the resolved code on the short-circuit", () => {
    expect(dispatcherSrc).toMatch(
      /emitProgress\("failed",\s*\{\s*code,/,
    );
    expect(dispatcherSrc).toMatch(/\? "run_cancelled" : "kill_switch"/);
    expect(dispatcherSrc).not.toMatch(/emitProgress\("run_killed"/);
  });

  it("policy module emits tool_call thread_event (NOT a new kind)", () => {
    expect(policySrc).toMatch(/kind:\s*"tool_call"/);
    expect(policySrc).not.toMatch(/kind:\s*"tool_blocked"/);
    expect(policySrc).toMatch(/const reason = killed \? "kill_switch" : "run_cancelled"/);
    expect(policySrc).toMatch(/code:\s*reason/);
  });

  it("policy returns SDK HookJSONOutput deny shape (nested hookSpecificOutput)", () => {
    expect(policySrc).toMatch(/continue: false/);
    expect(policySrc).toMatch(/hookSpecificOutput:\s*\{/);
    expect(policySrc).toMatch(/hookEventName:\s*"PreToolUse"/);
    expect(policySrc).toMatch(/permissionDecision:\s*"deny"/);
    expect(policySrc).toMatch(/permissionDecisionReason:\s*reason/);
  });

  it("kill propagates via throw → runner.persistTerminal writes dispatch_error", () => {
    const runnerSrc = readFileSync(
      join(__dirname, "../runner.ts"),
      "utf-8",
    );
    expect(runnerSrc).toMatch(/update\.status = "dispatch_error"/);
    expect(runnerSrc).toMatch(/update\.error = error/);
  });
});

describe("generic-dispatcher — SDK query() loads no settings from disk", () => {
  it("passes settingSources: [] inside the query() options", () => {
    const start = dispatcherSrc.indexOf("const stream = query({");
    expect(start).toBeGreaterThan(0);
    const optionsBlock = dispatcherSrc.slice(start, dispatcherSrc.indexOf("disallowedTools: [...SDK_DISALLOWED_BUILTINS]", start));
    expect(optionsBlock).toMatch(/settingSources:\s*\[\]/);
  });
});
