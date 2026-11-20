import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("draft_mode suppresses direct tenant-write paths in generic-dispatcher", () => {
  const src = readFileSync(
    join(__dirname, "../generic-dispatcher.ts"),
    "utf-8",
  );

  it("suppresses thread_event emits on a draft run (not just shadow_mode)", () => {
    expect(src).toMatch(
      /suppressThreadEvents\s*=\s*isShadowRun\s*\|\|\s*ctx\.draft_mode\s*===\s*true/,
    );
    expect(src).toMatch(/const teEmit:[^\n]*=\s*suppressThreadEvents/);
    expect(src).toMatch(/const teOnce:[^\n]*=\s*suppressThreadEvents/);
  });

  it("gives the chat ui tools no approval cards on a draft or shadow run", () => {
    expect(src).toMatch(/approval_cards: ctx\.trigger === "chat" && !writesSuppressed\(ctx\)/);
  });

  it("skips operator writeOperatorStep (memory_signal) on a draft run", () => {
    expect(src).toMatch(/if\s*\(operatorState\s*&&\s*ctx\.draft_mode\s*!==\s*true\)/);
  });

  it("forces stream-draft rows OFF on a draft run", () => {
    expect(src).toMatch(
      /streamTokensEnabled\s*=\s*[\s\S]{0,80}(?:ctx\.draft_mode\s*===\s*true|writesSuppressed\(ctx\))\s*\?\s*false/,
    );
    expect(src).toMatch(/function writesSuppressed\(ctx: AgentContext\): boolean \{\s*return [^;]*ctx\.draft_mode\s*===\s*true/);
  });

  it("skips tool-effect-ledger checkpoints on a draft run", () => {
    expect(src).toMatch(
      /isToolEffectLedgerEnabled\(\)\s*&&\s*ctx\.draft_mode\s*!==\s*true/,
    );
  });

  it("threads draft_mode into all three makeDispatchTool call sites (engine funnels)", () => {
    const sites = src.match(/makeDispatchTool\(\{\s*\n\s*draft_mode: ctx\.draft_mode,/g);
    expect(sites, "all 3 makeDispatchTool call sites must pass draft_mode").toHaveLength(3);
  });

  it("exports a writesSuppressed(ctx) helper = shadow OR draft", () => {
    expect(src).toMatch(
      /export function writesSuppressed\(ctx: AgentContext\): boolean \{\s*\n\s*return ctx\.shadow_mode === true \|\| ctx\.draft_mode === true;/,
    );
  });

  it("chat-reply + mirror-degraded writes gate on writesSuppressed (3 sites), no bare !shadow_mode chat guard", () => {
    const guarded = src.match(/if \(ctx\.thread_id && !writesSuppressed\(ctx\)\) \{/g);
    expect(guarded, "2 chat-reply + 1 mirror-degraded must gate on writesSuppressed").toHaveLength(3);
    expect(src).not.toMatch(/if \(ctx\.thread_id && !ctx\.shadow_mode\) \{/);
  });

  it("SessionStore not attached + sdk_session_id not replaced on a draft/shadow run", () => {
    expect(src).toContain(
      "durableEnabled && isChatMode && ctx.thread_id && !writesSuppressed(ctx)",
    );
    expect(src).toContain("!writesSuppressed(ctx) && // P4 seal");
  });
});

describe("engine dispatch-tool funnel denies write tools on a draft run", () => {
  const src = readFileSync(
    join(__dirname, "../engine/dispatch-tool.ts"),
    "utf-8",
  );
  it("has a draft_mode + isDraftDeniedTool deny branch", () => {
    expect(src).toMatch(/import\s*\{\s*isDraftDeniedTool\s*\}\s*from\s*"\.\.\/best-of-n"/);
    expect(src).toMatch(
      /if\s*\(deps\.draft_mode === true && (deps\.variants_lab !== true && )?isDraftDeniedTool\(toolName\)\)/,
    );
  });
});
