import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { cronFailureSummaryText } from "../cron-summary";
import { chatFailureBubbleBody } from "../error-body";

const SEAT_REFUSAL =
  "dispatch_inner: Claude Code returned an error result: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

describe("cronFailureSummaryText", () => {
  it("never carries the raw seat refusal", () => {
    const out = cronFailureSummaryText(SEAT_REFUSAL, "cgo");
    expect(out).not.toMatch(/API key|ask your admin|organization has disabled|Claude Code/i);
    expect(out).toContain("temporary account issue on our side");
    expect(out).not.toContain("—");
  });

  it("is the chat failure bubble copy, capped at 200 chars", () => {
    const raw = "dispatch_inner: TypeError: Cannot read properties of undefined (reading 'x') at persistTerminal (generic-dispatcher.ts:123)";
    const out = cronFailureSummaryText(raw, "growth-lead");
    expect(out).toBe(chatFailureBubbleBody(raw, "growth-lead").slice(0, 200));
    expect(out).not.toContain("generic-dispatcher.ts");
    expect(out.length).toBeLessThanOrEqual(200);
  });
});
