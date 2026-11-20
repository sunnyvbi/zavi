import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveChatResumeSessionId,
  buildSdkUserPrompt,
} from "../generic-dispatcher";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

describe("resolveChatResumeSessionId — resume gate (default OFF)", () => {
  const SID = "11111111-2222-3333-4444-555555555555";

  it("returns null when disabled even with a valid session id + chat mode", () => {
    expect(
      resolveChatResumeSessionId({
        isChatMode: true,
        sdkSessionId: SID,
        resumeEnabled: false,
      }),
    ).toBeNull();
  });

  it("returns the id when explicitly enabled in chat mode", () => {
    expect(
      resolveChatResumeSessionId({
        isChatMode: true,
        sdkSessionId: SID,
        resumeEnabled: true,
      }),
    ).toBe(SID);
  });

  it("returns null when enabled but not chat mode", () => {
    expect(
      resolveChatResumeSessionId({
        isChatMode: false,
        sdkSessionId: SID,
        resumeEnabled: true,
      }),
    ).toBeNull();
  });

  it("returns null when enabled + chat but session id is empty/missing", () => {
    expect(
      resolveChatResumeSessionId({
        isChatMode: true,
        sdkSessionId: "",
        resumeEnabled: true,
      }),
    ).toBeNull();
    expect(
      resolveChatResumeSessionId({
        isChatMode: true,
        sdkSessionId: undefined,
        resumeEnabled: true,
      }),
    ).toBeNull();
  });

  it("defaults to OFF when PRAXIS_CHAT_SDK_RESUME is unset (env path)", () => {
    const prev = process.env.PRAXIS_CHAT_SDK_RESUME;
    delete process.env.PRAXIS_CHAT_SDK_RESUME;
    try {
      expect(
        resolveChatResumeSessionId({ isChatMode: true, sdkSessionId: SID }),
      ).toBeNull();
    } finally {
      if (prev !== undefined) process.env.PRAXIS_CHAT_SDK_RESUME = prev;
    }
  });
});

describe("transcript-flatten path preserves prior context when resume is off", () => {
  it("emits a 'Prior conversation:' block from prior turns (no resume)", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "my budget is $5k" },
      { role: "assistant", content: "noted, $5k." },
      { role: "user", content: "remind me my budget?" },
    ];
    const out = buildSdkUserPrompt({
      messages,
      resumeSessionId: null,
      runId: "run-1",
      threadId: "thread-1",
    });
    expect(typeof out).toBe("string");
    expect(out as string).toContain("Prior conversation — earlier turns");
    expect(out as string).toContain("$5k");
    expect(out as string).toContain("remind me my budget?");
  });
});

describe("generic-dispatcher routes resume through the gate", () => {
  const src = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf-8");

  it("derives resumeSessionId via resolveChatResumeSessionId, not an inline always-on read", () => {
    expect(src).toMatch(
      /const resumeSessionId\s*=\s*(?:durableResumeId\s*\?\?\s*)?resolveChatResumeSessionId\(/,
    );
  });

  it("gates on the PRAXIS_CHAT_SDK_RESUME env var", () => {
    expect(src).toContain("PRAXIS_CHAT_SDK_RESUME");
  });

  it("durable resume is DEFAULT-ON (on unless explicitly disabled with =0)", () => {
    expect(src).toContain('process.env.PRAXIS_CHAT_SDK_RESUME_DURABLE !== "0"');
  });
});
