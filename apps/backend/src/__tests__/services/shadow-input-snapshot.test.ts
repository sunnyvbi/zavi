import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePromptSnapshot } from "../../../scripts/shadow-replay";

describe("parsePromptSnapshot", () => {
  const mk = (sys: string, user: string) =>
    `--- system ---\n${sys}\n\n--- initial user ---\n${user}`;

  it("splits a well-formed snapshot into {system, initial_user}", () => {
    const out = parsePromptSnapshot(mk("SYS BODY", "the ask"), false);
    expect(out).toEqual({ system: "SYS BODY", initial_user: "the ask" });
  });

  it("null/empty input → null", () => {
    expect(parsePromptSnapshot(null, false)).toBeNull();
    expect(parsePromptSnapshot("", false)).toBeNull();
    expect(parsePromptSnapshot(undefined, true)).toBeNull();
  });

  it("missing system marker → null (older/malformed row)", () => {
    expect(parsePromptSnapshot("no markers at all", false)).toBeNull();
    expect(parsePromptSnapshot("--- initial user ---\nx", false)).toBeNull();
  });

  it("ambiguous: delimiter appears >1× (collision in system body) → null", () => {
    const collide = mk("sys with \n\n--- initial user ---\n embedded", "real ask");
    expect(parsePromptSnapshot(collide, false)).toBeNull();
  });

  it("non-chat with empty initial_user → null (starvation-looking-valid)", () => {
    expect(parsePromptSnapshot(mk("SYS", ""), false)).toBeNull();
    expect(parsePromptSnapshot(mk("SYS", "   "), false)).toBeNull();
  });

  it("chat with no user marker → {system, initial_user:''} (ask is in payload messages)", () => {
    expect(parsePromptSnapshot("--- system ---\nSYS ONLY", true)).toEqual({
      system: "SYS ONLY",
      initial_user: "",
    });
  });

  it("chat with empty initial_user is allowed (turn history comes from payload)", () => {
    expect(parsePromptSnapshot(mk("SYS", ""), true)).toEqual({ system: "SYS", initial_user: "" });
  });

  it("preserves multi-line + special chars in both sections", () => {
    const out = parsePromptSnapshot(mk("line1\nline2", "ask\nmore"), false);
    expect(out).toEqual({ system: "line1\nline2", initial_user: "ask\nmore" });
  });
});

describe("generic-dispatcher P2 seam — source-level guard (live-inertness proof)", () => {
  const gd = readFileSync(
    join(__dirname, "../../services/agents/generic-dispatcher.ts"),
    "utf-8",
  );

  it("the prompt override is GUARDED by isShadowRun && ctx.shadow_prompt_override (inert for live runs)", () => {
    expect(gd).toMatch(/if \(isShadowRun && ctx\.shadow_prompt_override\) \{/);
  });

  it("ALWAYS overrides systemPrompt from the snapshot (the embedded-ask fix)", () => {
    expect(gd).toMatch(/systemPrompt = ctx\.shadow_prompt_override\.system;/);
  });

  it("overrides the user turn ONLY for non-chat (chat keeps payload multi-turn)", () => {
    expect(gd).toMatch(/if \(!isChatMode\) \{[\s\S]*?shadow_prompt_override\.initial_user/);
  });

  it("systemPrompt + messages are `let` (re-assignable) — the override compiles", () => {
    expect(gd).toMatch(/const cachedPromptPrefix = stablePreamble \+ productBuilderCachedBlock;/);
    expect(gd).toMatch(/let systemPrompt = cachedPromptPrefix \+ dynamicContext;/);
    expect(gd).toMatch(/let messages: MessageParam\[\] = isChatMode/);
  });
});
