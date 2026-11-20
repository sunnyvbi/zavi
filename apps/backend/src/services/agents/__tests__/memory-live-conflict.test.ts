
import { describe, it, expect } from "vitest";
import {
  detectMemoryLiveConflict,
  buildConflictReply,
} from "../memory-live-conflict";
import type { ToolCallTrace } from "@/services/tools/types";

const tc = (o: Partial<ToolCallTrace>): ToolCallTrace =>
  ({ name: "x", input_preview: "", output_preview: "", ms: 1, status: "ok", ...o }) as ToolCallTrace;

const MEMORY_HIT = tc({
  name: "mcp__server__memory__search",
  input_preview: '{"query":"split payment co-traveler guest trip"}',
  output_preview:
    '[{"type":"text","text":"{\\"hits\\":[{\\"title\\":\\"Split payment feature with co-traveler\\",' +
    '\\"body\\":\\"Guests can now split payment with a co-traveler before booking. The co-traveler ' +
    'receives an email link to pay their share. Feature is shipped and ready for QA test case ' +
    'validation.\\",\\"score\\":0.91796875,\\"note_type\\":\\"tenant_project\\"}]}"}]',
});
const EMPTY_CODE_SEARCH = tc({
  name: "mcp__server__github__search_code",
  input_preview: '{"owner":"rravi149","repo":"upcar","query":"split payment co-traveler"}',
  output_preview: '[{"type":"text","text":"{\\"total\\":0,\\"items\\":[]}"}]',
});
const THE_ANSWER =
  "Yes — split payment is live. Here's how it works:\n\n" +
  "• The primary guest initiates the booking and chooses to split with a co-traveler\n" +
  "• The co-traveler gets an email link to pay their share\n\n" +
  "Shipped as of early June 2026, with QA coverage on the three core scenarios.";

describe("the real prod run (regression)", () => {
  it("detects the contradiction the agent ignored", () => {
    const c = detectMemoryLiveConflict({
      answer: THE_ANSWER,
      toolCalls: [MEMORY_HIT, EMPTY_CODE_SEARCH],
    });
    expect(c.conflicted).toBe(true);
    expect(c.sharedTerms.length).toBeGreaterThanOrEqual(2);
    expect(c.liveQuery).toBe("split payment co-traveler");
  });

  it("the replacement asserts NEITHER side and names both", () => {
    const c = detectMemoryLiveConflict({
      answer: THE_ANSWER,
      toolCalls: [MEMORY_HIT, EMPTY_CODE_SEARCH],
    });
    const reply = buildConflictReply(c);
    expect(reply).toMatch(/can't confirm/i);
    expect(reply).toMatch(/saved notes say/i);
    expect(reply).toMatch(/no matching code/i);
    expect(reply).not.toMatch(/is live/i);
    expect(reply).not.toMatch(/single-use/i);
    expect(reply).not.toMatch(/QA coverage/i);
  });

  it("does not leak internal vocabulary to the customer", () => {
    const reply = buildConflictReply(
      detectMemoryLiveConflict({ answer: THE_ANSWER, toolCalls: [MEMORY_HIT, EMPTY_CODE_SEARCH] }),
    );
    for (const jargon of ["tool call", "probe", "tenant_reference", "note_type", "tier", "verifier"]) {
      expect(reply.toLowerCase()).not.toContain(jargon);
    }
  });
});

describe("all three signals are required", () => {
  it("no conflict when the live search FOUND something", () => {
    const found = tc({
      ...EMPTY_CODE_SEARCH,
      output_preview: '[{"type":"text","text":"{\\"total\\":3,\\"items\\":[{\\"path\\":\\"a.ts\\"}]}"}]',
    });
    expect(
      detectMemoryLiveConflict({ answer: THE_ANSWER, toolCalls: [MEMORY_HIT, found] }).conflicted,
    ).toBe(false);
  });

  it("no conflict when no live code search ran at all", () => {
    expect(
      detectMemoryLiveConflict({ answer: THE_ANSWER, toolCalls: [MEMORY_HIT] }).conflicted,
    ).toBe(false);
  });

  it("no conflict when memory did not itself assert shipped", () => {
    const bland = tc({
      ...MEMORY_HIT,
      output_preview: '[{"type":"text","text":"{\\"hits\\":[{\\"title\\":\\"Payout cadence\\",\\"body\\":\\"Hosts are paid Tuesdays.\\"}]}"}]',
    });
    expect(
      detectMemoryLiveConflict({ answer: THE_ANSWER, toolCalls: [bland, EMPTY_CODE_SEARCH] })
        .conflicted,
    ).toBe(false);
  });

  it("no conflict when the answer already says it is NOT available", () => {
    const honest = "No, split payment is not live. I couldn't find it in the codebase.";
    expect(
      detectMemoryLiveConflict({ answer: honest, toolCalls: [MEMORY_HIT, EMPTY_CODE_SEARCH] })
        .conflicted,
    ).toBe(false);
  });

  it("no conflict when a FAILED live call returned empty (not evidence)", () => {
    const failed = tc({ ...EMPTY_CODE_SEARCH, status: "tool_error", code: "rate_limited" });
    expect(
      detectMemoryLiveConflict({ answer: THE_ANSWER, toolCalls: [MEMORY_HIT, failed] }).conflicted,
    ).toBe(false);
  });
});

describe("subject matching stops the obvious false positive", () => {
  it("unrelated memory hit + unrelated empty search is NOT a contradiction", () => {
    const otherMemory = tc({
      name: "mcp__server__memory__search",
      input_preview: '{"query":"instant booking"}',
      output_preview:
        '[{"type":"text","text":"{\\"hits\\":[{\\"title\\":\\"Instant booking\\",\\"body\\":\\"Instant booking is live for all hosts.\\"}]}"}]',
    });
    const otherSearch = tc({
      name: "mcp__server__github__search_code",
      input_preview: '{"owner":"rravi149","repo":"upcar","query":"loyalty points redemption"}',
      output_preview: '[{"type":"text","text":"{\\"total\\":0,\\"items\\":[]}"}]',
    });
    expect(
      detectMemoryLiveConflict({
        answer: "Yes, instant booking is live.",
        toolCalls: [otherMemory, otherSearch],
      }).conflicted,
    ).toBe(false);
  });
});

describe("fail-open", () => {
  it("empty answer / no tool calls is inert", () => {
    expect(detectMemoryLiveConflict({ answer: "", toolCalls: [] }).conflicted).toBe(false);
    expect(detectMemoryLiveConflict({ answer: THE_ANSWER, toolCalls: [] }).conflicted).toBe(false);
    expect(detectMemoryLiveConflict({ answer: THE_ANSWER }).conflicted).toBe(false);
  });

  it("an unparseable live output is NOT read as empty", () => {
    const truncated = tc({ ...EMPTY_CODE_SEARCH, output_preview: '[{"type":"text","text":"{\\"tot' });
    expect(
      detectMemoryLiveConflict({ answer: THE_ANSWER, toolCalls: [MEMORY_HIT, truncated] })
        .conflicted,
    ).toBe(false);
  });
});
