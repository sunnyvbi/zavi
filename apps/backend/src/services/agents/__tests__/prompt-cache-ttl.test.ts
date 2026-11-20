import { describe, it, expect, vi } from "vitest";
import { BUILD_PROMPT_CACHE_SETTING, isBuildOrEditRunPayload, promptCacheTtlForRun } from "../prompt-cache-ttl";
import { buildAgentChildEnv } from "../agent-auth";
import { APP_SETTINGS } from "@/services/settings/registry";

const T = "t-1";
const C = "c0000000-0000-4000-8000-00000000000a";

describe("which runs are builds or edits", () => {
  it("a conductor-dispatched stage, repair or fix pass, and a refine run, are", () => {
    for (const p of [
      { build_conductor_run_id: C, stage: "build", fast_single_pass: true },
      { build_conductor_run_id: C, stage: "build", repair_mode: true, vision_fix: true },
      { build_conductor_run_id: C, stage: "spec" },
      { refine_mode: true, message: "make the header blue" },
    ]) {
      expect(isBuildOrEditRunPayload(p)).toBe(true);
    }
  });

  it("chat, scheduled agents, cgo and anything without a payload are not", () => {
    for (const p of [null, undefined, "x", [], {}, { thread_id: "th-1", message: "hi" }, { build_conductor_run_id: "" }, { build_conductor_run_id: 7 }, { build_conductor_run_id: "not-a-uuid" }, { refine_mode: "true" }, { goal_id: "g" }]) {
      expect(isBuildOrEditRunPayload(p)).toBe(false);
    }
  });
});

describe("promptCacheTtlForRun", () => {
  it("builds and edits get 5m while the setting is on; every other run keeps 1h without reading it", async () => {
    const read = vi.fn(async () => true);
    expect(await promptCacheTtlForRun(T, { build_conductor_run_id: C }, read)).toBe("5m");
    expect(await promptCacheTtlForRun(T, { refine_mode: true }, read)).toBe("5m");
    expect(read).toHaveBeenCalledWith(BUILD_PROMPT_CACHE_SETTING, T);
    read.mockClear();
    expect(await promptCacheTtlForRun(T, { thread_id: "th" }, read)).toBe("1h");
    expect(read).not.toHaveBeenCalled();
  });

  it("the setting turned off puts builds back on 1h; an unreadable setting reads as its default (on)", async () => {
    expect(await promptCacheTtlForRun(T, { build_conductor_run_id: C }, async () => false)).toBe("1h");
    expect(await promptCacheTtlForRun(T, { build_conductor_run_id: C }, async () => { throw new Error("settings down"); })).toBe("5m");
  });

  it("the setting ships on", () => {
    expect(APP_SETTINGS[BUILD_PROMPT_CACHE_SETTING].defaultValue).toBe(true);
  });
});

describe("buildAgentChildEnv cache TTL", () => {
  it("5m forces the 5-minute cache even over an inherited 1h switch", () => {
    const env = buildAgentChildEnv({ mode: "api_key", apiKey: "k", baseEnv: { ENABLE_PROMPT_CACHING_1H: "1" }, promptCacheTtl: "5m" });
    expect(env.ENABLE_PROMPT_CACHING_1H).toBe("0");
    expect(env.FORCE_PROMPT_CACHING_5M).toBe("1");
  });

  it("absent or 1h keeps the fleet default (1h, an explicit opt-out still wins)", () => {
    expect(buildAgentChildEnv({ mode: "api_key", apiKey: "k", baseEnv: {} }).ENABLE_PROMPT_CACHING_1H).toBe("1");
    expect(buildAgentChildEnv({ mode: "api_key", apiKey: "k", baseEnv: {}, promptCacheTtl: "1h" }).ENABLE_PROMPT_CACHING_1H).toBe("1");
    expect(buildAgentChildEnv({ mode: "api_key", apiKey: "k", baseEnv: {}, promptCacheTtl: "1h" }).FORCE_PROMPT_CACHING_5M).toBeUndefined();
    expect(buildAgentChildEnv({ mode: "api_key", apiKey: "k", baseEnv: { ENABLE_PROMPT_CACHING_1H: "0" } }).ENABLE_PROMPT_CACHING_1H).toBe("0");
  });
});
