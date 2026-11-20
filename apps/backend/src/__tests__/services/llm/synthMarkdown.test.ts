import { describe, it, expect, vi, beforeEach } from "vitest";

const captureCall = vi.fn();
let mockResponse: unknown = null;
let mockThrow: Error | null = null;

vi.mock("@/services/anthropic", async () => {
  const actual = await vi.importActual<typeof import("@/services/anthropic")>(
    "@/services/anthropic",
  );
  return {
    ...actual,
    getAnthropic: () => ({
      messages: {
        create: async (...args: unknown[]) => {
          captureCall(...args);
          if (mockThrow) throw mockThrow;
          return mockResponse;
        },
      },
    }),
  };
});

import { synthMarkdown } from "@/services/llm/synthMarkdown";

beforeEach(() => {
  captureCall.mockReset();
  mockResponse = null;
  mockThrow = null;
});

function textOnlyResponse(text: string, input = 100, output = 50) {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: input, output_tokens: output },
  };
}

describe("synthMarkdown", () => {
  it("returns text from a single-block response", async () => {
    mockResponse = textOnlyResponse("# Hello\n\nWorld.");
    const out = await synthMarkdown({
      system_prompt: "be terse",
      user_prompt: "say hi",
    });
    expect(out.markdown).toBe("# Hello\n\nWorld.");
    expect(out.input_tokens).toBe(100);
    expect(out.output_tokens).toBe(50);
    expect(out.model).toBe("claude-sonnet-5-5");
  });

  it("joins all text blocks (codex C9 — multi-block extraction)", async () => {
    mockResponse = {
      content: [
        { type: "text", text: "Block 1." },
        { type: "tool_use", name: "x", input: {} },
        { type: "text", text: "Block 2." },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const out = await synthMarkdown({
      system_prompt: "s",
      user_prompt: "u",
    });
    expect(out.markdown).toBe("Block 1.\nBlock 2.");
  });

  it("throws on empty response (no text blocks)", async () => {
    mockResponse = {
      content: [{ type: "tool_use", name: "x", input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    await expect(
      synthMarkdown({ system_prompt: "s", user_prompt: "u" }),
    ).rejects.toThrow(/empty response/);
  });

  it("throws on whitespace-only text", async () => {
    mockResponse = textOnlyResponse("   \n  \t  ");
    await expect(
      synthMarkdown({ system_prompt: "s", user_prompt: "u" }),
    ).rejects.toThrow(/empty response/);
  });

  it("throws on unknown model id (codex C10)", async () => {
    await expect(
      synthMarkdown({
        system_prompt: "s",
        user_prompt: "u",
        model: "claude-imaginary-9000",
      }),
    ).rejects.toThrow(/unknown model id.*claude-imaginary-9000/);
  });

  it("passes through known non-default model", async () => {
    mockResponse = textOnlyResponse("ok");
    const out = await synthMarkdown({
      system_prompt: "s",
      user_prompt: "u",
      model: "claude-opus-4-7",
    });
    expect(out.model).toBe("claude-opus-4-7");
    expect(out.cost_usd).toBeCloseTo(0.0018, 4);
  });

  it("computes cost using PRICING table (sonnet default)", async () => {
    mockResponse = textOnlyResponse("ok", 1000, 200);
    const out = await synthMarkdown({ system_prompt: "s", user_prompt: "u" });
    expect(out.cost_usd).toBeCloseTo(0.004, 5);
  });

  it("passes correct messages shape to Anthropic SDK", async () => {
    mockResponse = textOnlyResponse("ok");
    await synthMarkdown({
      system_prompt: "be terse",
      user_prompt: "say hi",
      max_tokens: 512,
    });
    expect(captureCall).toHaveBeenCalledOnce();
    const arg = captureCall.mock.calls[0][0] as {
      model: string;
      max_tokens: number;
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(arg.model).toBe("claude-sonnet-5-5");
    expect(arg.max_tokens).toBe(512);
    expect(arg.system).toEqual([
      { type: "text", text: "be terse", cache_control: { type: "ephemeral" } },
    ]);
    expect(arg.messages).toEqual([{ role: "user", content: "say hi" }]);
  });

  it("defaults max_tokens to 2048 when unspecified", async () => {
    mockResponse = textOnlyResponse("ok");
    await synthMarkdown({ system_prompt: "s", user_prompt: "u" });
    const arg = captureCall.mock.calls[0][0] as { max_tokens: number };
    expect(arg.max_tokens).toBe(2048);
  });
});
