
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

describe("generic-dispatcher — connector-wall chat-degrade wiring", () => {
  it("imports isConnectorWallChatDegradeEnabled from ./_chat-degrade-flag-check", () => {
    expect(dispatcherSrc).toMatch(
      /import \{ isConnectorWallChatDegradeEnabled \} from "\.\/\_chat-degrade-flag-check"/,
    );
  });

  it("declares run-scoped degradedMode = false before setupGate", () => {
    expect(dispatcherSrc).toMatch(/let degradedMode = false/);
  });

  it("chat-degrade branch checks ctx.trigger === 'chat' inside setupGate !ok block", () => {
    expect(dispatcherSrc).toMatch(/ctx\.trigger === "chat"[\s\S]*?isConnectorWallChatDegradeEnabled/);
  });

  it("chat-degrade branch sets degradedMode = true and breaks out of setupGate", () => {
    expect(dispatcherSrc).toMatch(/degradedMode = true/);
    expect(dispatcherSrc).toMatch(/break setupGate/);
  });

  it("degraded preface is stored on ctx under _degradedSetupPreface key", () => {
    expect(dispatcherSrc).toMatch(/_degradedSetupPreface/);
  });

  it("degraded preface names missing connectors in the preface text", () => {
    expect(dispatcherSrc).toMatch(/missing_required_connectors/);
    expect(dispatcherSrc).toMatch(/DEGRADED MODE/);
  });

  it("degradedMode is injected into dynamic context after the connector block", () => {
    expect(dispatcherSrc).toMatch(/if \(degradedMode\)[\s\S]*?_degradedSetupPreface/);
  });

  it("degraded_mode is passed to PreToolUsePolicyCtx at the hook bind site", () => {
    expect(dispatcherSrc).toMatch(/degraded_mode: degradedMode/);
  });

  it("non-chat triggers keep the hard setup_required block (unchanged path)", () => {
    expect(dispatcherSrc).toMatch(/envelope_kind: "setup_required"/);
  });

  it("degrade condition includes ctx.trigger === 'slack' (widened from chat-only)", () => {
    expect(dispatcherSrc).toMatch(
      /ctx\.trigger === "chat" \|\| ctx\.trigger === "slack"/,
    );
  });

  it("comment explains why slack trigger is included (safety documentation)", () => {
    expect(dispatcherSrc).toMatch(/Slack.*@-mention|Slack triggers are included/);
  });
});

describe("pre-tool-use-policy — connector-wall chat-degrade write-deny", () => {
  it("exports PreToolUsePolicyCtx with degraded_mode?: boolean field", () => {
    expect(policySrc).toMatch(/degraded_mode\?: boolean/);
  });

  it("has a degraded_mode gate that calls isDraftDeniedTool (mirrors draft path)", () => {
    expect(policySrc).toMatch(/ctx\.degraded_mode === true[\s\S]*?isDraftDeniedTool/);
  });

  it("degraded_mode deny returns connector_wall_chat_degrade_readonly reason", () => {
    expect(policySrc).toMatch(/connector_wall_chat_degrade_readonly/);
  });

  it("degraded_mode deny shape has permissionDecision: 'deny' (SDK contract)", () => {
    expect(policySrc).toMatch(
      /connector_wall_chat_degrade_readonly[\s\S]*?permissionDecision:\s*"deny"/,
    );
  });
});
