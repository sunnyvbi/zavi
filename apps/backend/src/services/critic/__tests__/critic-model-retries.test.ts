import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/services/settings", () => ({ getAppSetting: async () => "openai" }));
import { callCriticModel } from "../critic-model";

beforeEach(() => { vi.stubEnv("OPENAI_API_KEY", "sk-test"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const busy = (status: number) => new Response(JSON.stringify({error:{message:"temporarily busy"}}), {
  status, headers:{"content-type":"application/json","retry-after-ms":"1"},
});

describe("reviewer retries through the real SDK", () => {
  it("retries brief errors twice and delivers the review instead of failing", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(busy(503)).mockResolvedValueOnce(busy(429))
      .mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:"reviewed"}}],usage:{prompt_tokens:10,completion_tokens:10}}),{headers:{"content-type":"application/json"}}));
    vi.stubGlobal("fetch", fetch);
    const out = await callCriticModel({system:"s",user:"u",maxTokens:100,timeoutMs:5000});
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(out.text).toBe("reviewed");
  });

  it("does not make another attempt after caller cancellation", async () => {
    const abort = new AbortController();
    const fetch = vi.fn(async () => { abort.abort(); return busy(503); });
    vi.stubGlobal("fetch", fetch);
    await expect(callCriticModel({system:"s",user:"u",maxTokens:100,timeoutMs:5000,signal:abort.signal})).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("still aborts an outstanding request at its deadline", async () => {
    const fetch = vi.fn((_input: unknown, options?: RequestInit) => new Promise<Response>((_resolve,reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once:true});
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(callCriticModel({system:"s",user:"u",maxTokens:100,timeoutMs:20})).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
