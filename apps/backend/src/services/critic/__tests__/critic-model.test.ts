import { describe, it, expect, vi, beforeEach } from "vitest";

const ctorMock = vi.fn();
const createMock = vi.fn();
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: (...a: unknown[]) => createMock(...a) } };
    constructor(opts: unknown) {
      ctorMock(opts);
    }
  },
}));

const getAppSettingMock = vi.fn(async (_key: string): Promise<unknown> => undefined);
vi.mock("@/services/settings", () => ({
  getAppSetting: (key: string) => getAppSettingMock(key),
}));

import {
  callCriticModel,
  resolveCriticFamily,
} from "../critic-model";

function okResp() {
  return {
    choices: [{ message: { content: '{"verdict":"pass","reason":"ok"}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

const baseInput = { system: "s", user: "u", maxTokens: 200, timeoutMs: 5_000 };

beforeEach(() => {
  ctorMock.mockReset();
  createMock.mockReset();
  getAppSettingMock.mockReset();
  getAppSettingMock.mockResolvedValue(undefined);
  delete process.env.CRITIC_FAMILY;
  delete process.env.OPENAI_CRITIC_MODEL;
  delete process.env.FIREWORKS_BASE_URL;
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.FIREWORKS_API_KEY = "fw-test";
});

describe("resolveCriticFamily", () => {
  it("(a) defaults to openai (registry default) when CRITIC_FAMILY is unset", async () => {
    expect(await resolveCriticFamily()).toBe("openai");
  });

  it("returns the env family when it's a known key", async () => {
    process.env.CRITIC_FAMILY = "glm52";
    expect(await resolveCriticFamily()).toBe("glm52");
  });

  it("(c) an unknown CRITIC_FAMILY falls back to the registry default (openai)", async () => {
    process.env.CRITIC_FAMILY = "totally-made-up";
    expect(await resolveCriticFamily()).toBe("openai");
  });

  it("the critic_family STAFF SETTING wins over the env var (live override)", async () => {
    process.env.CRITIC_FAMILY = "openai";
    getAppSettingMock.mockResolvedValue("glm52");
    expect(await resolveCriticFamily()).toBe("glm52");
  });

  it("a present-but-INVALID setting value resolves to the registry default (openai)", async () => {
    getAppSettingMock.mockResolvedValue("not-a-family");
    process.env.CRITIC_FAMILY = "glm52";
    expect(await resolveCriticFamily()).toBe("openai");
  });

  it("unset setting + unset env → openai (registry default; unset == today's effective default)", async () => {
    getAppSettingMock.mockResolvedValue(undefined);
    delete process.env.CRITIC_FAMILY;
    expect(await resolveCriticFamily()).toBe("openai");
  });
});

describe("callCriticModel — family routing", () => {
  it("(a) openai family → no baseURL, OPENAI_API_KEY, flagship model", async () => {
    process.env.CRITIC_FAMILY = "openai";
    createMock.mockResolvedValue(okResp());
    const r = await callCriticModel(baseInput);
    expect(r.family).toBe("openai");
    expect(r.model).toBe("gpt-5.5");
    expect(ctorMock).toHaveBeenCalledWith({ apiKey: "sk-test" });
    expect(createMock.mock.calls[0][0].model).toBe("gpt-5.5");
    expect(createMock.mock.calls[0][0].max_completion_tokens).toBe(200);
    expect(createMock.mock.calls[0][0]).not.toHaveProperty("max_tokens");
    expect(createMock.mock.calls[0][0]).not.toHaveProperty("temperature");
    expect(r.cost_usd).toBeCloseTo(0.002, 6);
  });

  it("(b) CRITIC_FAMILY=glm52 → Fireworks baseURL + glm-5p2 model + FIREWORKS_API_KEY", async () => {
    process.env.CRITIC_FAMILY = "glm52";
    createMock.mockResolvedValue(okResp());
    const r = await callCriticModel(baseInput);
    expect(r.family).toBe("glm52");
    expect(r.model).toBe("accounts/fireworks/models/glm-5p2");
    expect(ctorMock).toHaveBeenCalledWith({
      apiKey: "fw-test",
      baseURL: "https://api.fireworks.ai/inference/v1",
    });
    expect(createMock.mock.calls[0][0].model).toBe(
      "accounts/fireworks/models/glm-5p2",
    );
    expect(createMock.mock.calls[0][0].max_tokens).toBe(200);
    expect(createMock.mock.calls[0][0]).not.toHaveProperty("max_completion_tokens");
    expect(r.cost_usd).toBeCloseTo(0.000135, 6);
  });

  it("respects FIREWORKS_BASE_URL override for glm52", async () => {
    process.env.CRITIC_FAMILY = "glm52";
    process.env.FIREWORKS_BASE_URL = "https://proxy.internal/v1";
    createMock.mockResolvedValue(okResp());
    await callCriticModel(baseInput);
    expect(ctorMock).toHaveBeenCalledWith({
      apiKey: "fw-test",
      baseURL: "https://proxy.internal/v1",
    });
  });

  it("respects OPENAI_CRITIC_MODEL override for the openai family", async () => {
    process.env.CRITIC_FAMILY = "openai";
    process.env.OPENAI_CRITIC_MODEL = "gpt-6-mini";
    createMock.mockResolvedValue(okResp());
    const r = await callCriticModel(baseInput);
    expect(r.model).toBe("gpt-6-mini");
    expect(createMock.mock.calls[0][0].model).toBe("gpt-6-mini");
  });
});

describe("callCriticModel — missing api key throws (engine fails open)", () => {
  it("(d) throws a clear error when the family api key env is unset (openai)", async () => {
    process.env.CRITIC_FAMILY = "openai";
    delete process.env.OPENAI_API_KEY;
    await expect(callCriticModel(baseInput)).rejects.toThrow(/OPENAI_API_KEY/);
    expect(ctorMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("(d) throws when FIREWORKS_API_KEY is unset for glm52", async () => {
    process.env.CRITIC_FAMILY = "glm52";
    delete process.env.FIREWORKS_API_KEY;
    await expect(callCriticModel(baseInput)).rejects.toThrow(/FIREWORKS_API_KEY/);
  });
});

it("passes caller cancellation through without overriding the SDK retry policy", async () => {
  createMock.mockResolvedValue(okResp());
  const abort = new AbortController();
  await callCriticModel({ ...baseInput, signal: abort.signal });
  const options = createMock.mock.calls[0][1];
  expect(options.signal.aborted).toBe(false);
  abort.abort();
  expect(options.signal.aborted).toBe(true);
  expect(options).not.toHaveProperty("maxRetries");
});
