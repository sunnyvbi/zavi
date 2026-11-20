
import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock, alertMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  alertMock: vi.fn(),
}));
vi.mock("@/services/openai", () => ({
  getOpenAi: () => ({ chat: { completions: { create: createMock } } }),
}));
vi.mock("@/services/anthropic", () => ({
  getAnthropic: () => ({}),
  heliconePropertyHeaders: () => ({}),
}));
vi.mock("@/services/logging/alert", () => ({ alert: alertMock }));

import { callModel } from "../call-model";

beforeEach(() => {
  createMock.mockReset();
  alertMock.mockReset();
  alertMock.mockResolvedValue(undefined);
  createMock.mockResolvedValue({
    choices: [{ message: { content: '{"score":50}' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
});

async function call(model: string, temperature?: number) {
  await callModel({
    provider: "openai",
    model,
    messages: [{ role: "user", content: "x" }],
    max_tokens: 10,
    ...(temperature !== undefined ? { temperature } : {}),
  });
}

function paramsOf() {
  return createMock.mock.calls[0][0] as Record<string, unknown>;
}

describe("callModel openai temperature handling", () => {
  it("omits temperature for gpt-5.5 even when the caller passes 0", async () => {
    await callModel({
      provider: "openai",
      model: "gpt-5.5",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      temperature: 0,
    });
    expect(paramsOf()).not.toHaveProperty("temperature");
    expect(paramsOf().max_completion_tokens).toBe(10);
  });

  it("omits temperature for the o-series (o1/o3)", async () => {
    await callModel({
      provider: "openai",
      model: "o3-mini",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      temperature: 0,
    });
    expect(paramsOf()).not.toHaveProperty("temperature");
  });

  it("keeps an explicit temperature for gpt-4-class models", async () => {
    await callModel({
      provider: "openai",
      model: "gpt-4o",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      temperature: 0,
    });
    expect(paramsOf().temperature).toBe(0);
  });
});

describe("callModel openai temperature-drop is LOUD", () => {
  it("alerts when a caller's temperature is dropped for a fixed-temperature model", async () => {
    await call("gpt-5.5", 0.2);
    expect(alertMock).toHaveBeenCalledTimes(1);
    const arg = alertMock.mock.calls[0][0] as Record<string, string>;
    expect(arg.code).toBe("temperature_dropped");
    expect(arg.source).toBe("llm.call_model");
    expect(arg.msg).toContain("gpt-5.5");
    expect(arg.msg).toContain("0.2");
    expect(paramsOf()).not.toHaveProperty("temperature");
  });

  it("does NOT alert when the model honors the requested temperature", async () => {
    await call("gpt-4o", 0.3);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("does NOT alert when the caller passes no temperature at all", async () => {
    await call("gpt-5.5");
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("does NOT alert when the requested value IS the provider default (no-op drop)", async () => {
    await call("o3-mini", 1);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("dedups per (model, value) so the */10 judge cron cannot spam", async () => {
    await call("gpt-5-dedup-probe", 0.4);
    await call("gpt-5-dedup-probe", 0.4);
    await call("gpt-5-dedup-probe", 0.4);
    expect(alertMock).toHaveBeenCalledTimes(1);
    await call("gpt-5-dedup-probe", 0.9);
    expect(alertMock).toHaveBeenCalledTimes(2);
  });
});
