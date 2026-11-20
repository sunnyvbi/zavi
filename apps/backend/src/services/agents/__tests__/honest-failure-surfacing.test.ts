
import { describe, it, expect } from "vitest";
import { deriveOutcome, detectToolNoOutput } from "@/services/agents/outcome-model";

const IMAGE_CALL_ZERO = {
  name: "mcp__server__report__generate_image",
  status: "ok" as const,
  ms: 0,
  input_preview: "",
  output_preview:
    '[{"type":"text","text":"{\\"images\\":[],\\"generated\\":0,\\"typeset\\":0,\\"cached\\":0,' +
    '\\"skipped\\":[{\\"index\\":0,\\"reason\\":\\"generation_failed\\",' +
    '\\"detail\\":\\"submit 403: {\\\\\\"detail\\\\\\":\\\\\\"not_enough_credits\\\\\\"}\\"}],' +
    '\\"slack_ok\\":false}"}]',
};

const IMAGE_CALL_OK = {
  name: "mcp__server__report__generate_image",
  status: "ok" as const,
  ms: 0,
  input_preview: "",
  output_preview:
    '[{"type":"text","text":"{\\"images\\":[{\\"artifact_id\\":\\"a1\\"}],\\"generated\\":1,' +
    '\\"typeset\\":0,\\"cached\\":0,\\"skipped\\":[],\\"slack_ok\\":true}"}]',
};

const IMAGE_CALL_PARTIAL = {
  name: "mcp__server__report__generate_image",
  status: "ok" as const,
  ms: 0,
  input_preview: "",
  output_preview:
    '[{"type":"text","text":"{\\"images\\":[{\\"artifact_id\\":\\"a1\\"},{\\"artifact_id\\":\\"a2\\"}],' +
    '\\"generated\\":2,\\"typeset\\":0,\\"cached\\":0,' +
    '\\"skipped\\":[{\\"index\\":2,\\"reason\\":\\"generation_failed\\",\\"detail\\":\\"boom\\"}]}"}]',
};

const TOOL_SEARCH = {
  name: "ToolSearch",
  status: "ok" as const,
  ms: 0,
  input_preview: "",
  output_preview: '[{"type":"tool_reference","tool_name":"mcp__server__report__generate_image"}]',
};

describe("detectToolNoOutput — read the payload, not the status", () => {
  it("catches a tool that produced nothing while reporting ok", () => {
    const hit = detectToolNoOutput([TOOL_SEARCH, IMAGE_CALL_ZERO]);
    expect(hit).not.toBeNull();
    expect(hit!.tool).toContain("generate_image");
    expect(hit!.reason).toMatch(/not_enough_credits/);
  });

  it("stays silent when the tool actually produced something", () => {
    expect(detectToolNoOutput([TOOL_SEARCH, IMAGE_CALL_OK])).toBeNull();
  });

  it("does NOT fire on partial degradation — fail-soft is working there", () => {
    expect(detectToolNoOutput([IMAGE_CALL_PARTIAL])).toBeNull();
  });

  it("stays silent on unrelated tools", () => {
    expect(detectToolNoOutput([TOOL_SEARCH])).toBeNull();
    expect(detectToolNoOutput([])).toBeNull();
    expect(detectToolNoOutput(undefined)).toBeNull();
  });

  it("needs a stated reason — an empty skip list is not a confident signal", () => {
    const noReason = {
      name: "x",
      status: "ok" as const,
      ms: 0,
      input_preview: "",
      output_preview: '{"generated":0,"skipped":[]}',
    };
    expect(detectToolNoOutput([noReason])).toBeNull();
  });
});

describe("deriveOutcome — a zero-output run must not read as clean success", () => {
  it("marks the credit-exhausted image run as tool_no_output, not none", () => {
    const outcome = deriveOutcome({
      status: "success",
      outputText: "No image was produced. The account is out of credits.",
      toolCalls: [TOOL_SEARCH, IMAGE_CALL_ZERO],
    });
    expect(outcome.failure.class).toBe("tool_no_output");
    expect(outcome.failure.raw_error).toMatch(/not_enough_credits/);
  });

  it("still keeps the deliverable so the user sees the explanation", () => {
    const outcome = deriveOutcome({
      status: "success",
      outputText: "No image was produced. The account is out of credits.",
      toolCalls: [IMAGE_CALL_ZERO],
    });
    expect(outcome.deliverable).toMatch(/out of credits/);
  });

  it("leaves a genuinely clean run clean", () => {
    const outcome = deriveOutcome({
      status: "success",
      outputText: "Here is your image.",
      toolCalls: [IMAGE_CALL_OK],
    });
    expect(outcome.failure.class).toBe("none");
    expect(outcome.failure.raw_error).toBeNull();
  });

  it("leaves a partially-degraded run clean", () => {
    const outcome = deriveOutcome({
      status: "success",
      outputText: "Two of three images are attached.",
      toolCalls: [IMAGE_CALL_PARTIAL],
    });
    expect(outcome.failure.class).toBe("none");
  });
});

describe("name gate — only real generation tools can raise this", () => {
  it("ignores a fetch whose CONTENT quotes the payload shape", () => {
    const docFetch = {
      name: "web_fetch",
      status: "ok" as const,
      ms: 0,
      input_preview: "",
      output_preview: 'sample: {"generated":0,"skipped":[{"reason":"not_applicable"}]}',
    };
    expect(detectToolNoOutput([docFetch])).toBeNull();
    expect(
      deriveOutcome({ status: "success", outputText: "Here is the answer.", toolCalls: [docFetch] })
        .failure.class,
    ).toBe("none");
  });

  it("still fires for the other media tools, not just images", () => {
    const video = {
      name: "mcp__server__report__generate_video",
      status: "ok" as const,
      ms: 0,
      input_preview: "",
      output_preview: '{"generated":0,"skipped":[{"reason":"vendor_error","detail":"boom"}]}',
    };
    expect(detectToolNoOutput([video])).not.toBeNull();
  });
});
