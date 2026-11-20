
import { describe, it, expect } from "vitest";
import { classifyFailureOrigin } from "../../../scripts/shadow-replay";

function named(name: string, message = "boom"): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe("classifyFailureOrigin", () => {
  describe("harness — provably ours, must abort the batch", () => {
    it("classifies the EXACT recorded ESM failure as harness", () => {
      const e = new Error(
        "require() of ES Module /private/tmp/praxis-shadow/node_modules/" +
          "@anthropic-ai/claude-agent-sdk/sdk.mjs not supported.",
      );
      expect(classifyFailureOrigin(e)).toBe("harness");
    });

    it.each([
      ["Cannot find module '@/services/foo'"],
      ["ERR_REQUIRE_ESM"],
      ["ENOENT: no such file or directory"],
      ["tsconfig.json could not be resolved"],
    ])("classifies local build fault as harness: %s", (msg) => {
      expect(classifyFailureOrigin(new Error(msg))).toBe("harness");
    });
  });

  describe("model — a real quality signal, must be recorded", () => {
    it.each([
      "ModelBehaviorError",
      "InvalidToolInputError",
      "ToolCallError",
      "MaxTurnsExceededError",
      "OutputGuardrailTripwireTriggered",
      "InputGuardrailTripwireTriggered",
    ])("classifies SDK %s as model, not harness", (name) => {
      expect(classifyFailureOrigin(named(name))).toBe("model");
    });
  });

  describe("unknown — unattributable, recorded but excluded from means", () => {
    it.each([
      ["rate limited", 429],
      ["internal server error", 500],
    ])("classifies provider weather (%s) as unknown", (msg, status) => {
      const e = Object.assign(new Error(msg), { status });
      expect(classifyFailureOrigin(e)).toBe("unknown");
    });

    it("classifies a wholly unrecognised error as unknown, NOT model", () => {
      const origin = classifyFailureOrigin(new Error("something weird"));
      expect(origin).not.toBe("model");
      expect(origin).toBe("unknown");
    });

    it("survives a non-Error throw without claiming it was the model", () => {
      expect(classifyFailureOrigin("a bare string")).not.toBe("model");
      expect(classifyFailureOrigin(null)).not.toBe("model");
      expect(classifyFailureOrigin(undefined)).not.toBe("model");
    });
  });
});
