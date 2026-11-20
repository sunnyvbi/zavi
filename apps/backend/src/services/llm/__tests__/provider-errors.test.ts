import { describe, it, expect } from "vitest";
import {
  classifyProviderError,
  isRetryableSameModel,
  shouldTryFallbackProvider,
  type ProviderErrorKind,
} from "@/services/llm/provider-errors";

describe("classifyProviderError (Goose ProviderError mining — Copy 3)", () => {
  it("maps HTTP status codes", () => {
    expect(classifyProviderError({ status: 401 }, "openai").kind).toBe("authentication");
    expect(classifyProviderError({ status: 403 }, "openai").kind).toBe("authentication");
    expect(classifyProviderError({ status: 429 }, "openai").kind).toBe("rate_limit");
    expect(classifyProviderError({ status: 404 }, "openai").kind).toBe("endpoint_not_found");
    expect(classifyProviderError({ status: 500 }, "anthropic").kind).toBe("server_error");
    expect(classifyProviderError({ status: 503 }, "anthropic").kind).toBe("server_error");
  });

  it("disambiguates 429 rate-limit vs credits-exhausted on message", () => {
    expect(classifyProviderError({ status: 429, message: "Rate limit reached" }, "openai").kind).toBe("rate_limit");
    expect(
      classifyProviderError({ status: 429, message: "You exceeded your current quota" }, "openai").kind,
    ).toBe("credits_exhausted");
  });

  it("detects context-length overflow from message (400-class)", () => {
    expect(
      classifyProviderError({ status: 400, message: "This model's maximum context length is 200000 tokens" }, "anthropic").kind,
    ).toBe("context_length");
  });

  it("detects network errors when no HTTP status is present", () => {
    expect(classifyProviderError({ message: "fetch failed: ECONNRESET" }, "openai").kind).toBe("network_error");
    expect(classifyProviderError({ message: "socket hang up" }, "anthropic").kind).toBe("network_error");
    expect(
      classifyProviderError(
        {
          message:
            "Invalid response body while trying to fetch https://api.anthropic.com/v1/messages: Premature close",
        },
        "anthropic",
      ).kind,
    ).toBe("network_error");
  });

  it("extracts retry-after into retryDelayMs", () => {
    expect(
      classifyProviderError({ status: 429, headers: { "retry-after": "12" } }, "openai").retryDelayMs,
    ).toBe(12_000);
    expect(classifyProviderError({ status: 429 }, "openai").retryDelayMs).toBeNull();
  });

  it("falls back to unknown for an unrecognized error", () => {
    expect(classifyProviderError({}, "openai").kind).toBe("unknown");
    expect(classifyProviderError(new Error("weird"), "anthropic").kind).toBe("unknown");
  });

  it("preserves provider + full message", () => {
    const c = classifyProviderError({ status: 500, message: "Internal Server Error xyz" }, "anthropic");
    expect(c.provider).toBe("anthropic");
    expect(c.message).toContain("xyz");
  });
});

describe("retryability + fallback classification", () => {
  it("retries only transient same-model failures", () => {
    expect(isRetryableSameModel("rate_limit")).toBe(true);
    expect(isRetryableSameModel("server_error")).toBe(true);
    expect(isRetryableSameModel("network_error")).toBe(true);
    expect(isRetryableSameModel("authentication")).toBe(false);
    expect(isRetryableSameModel("context_length")).toBe(false);
  });

  it("falls back to the other provider only where a swap could help", () => {
    for (const k of ["rate_limit", "server_error", "network_error", "endpoint_not_found", "credits_exhausted"] as ProviderErrorKind[]) {
      expect(shouldTryFallbackProvider(k), `${k} should fallback`).toBe(true);
    }
    for (const k of ["authentication", "context_length", "request_failed", "unknown"] as ProviderErrorKind[]) {
      expect(shouldTryFallbackProvider(k), `${k} should NOT fallback`).toBe(false);
    }
  });
});
