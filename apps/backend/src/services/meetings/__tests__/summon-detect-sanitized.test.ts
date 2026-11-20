import { describe, it, expect } from "vitest";
import { detectSummon } from "@/services/meetings/summon-detect";
import { sanitizeSlackEventPayload } from "@/services/redactor/slack-payload-sanitizer";

function sanitizedEventText(rawText: string): string {
  const body = {
    event: {
      type: "message",
      channel_type: "im",
      channel: "D0B448H4PKP",
      user: "U08FYQSBP6K",
      ts: "1781285566.363199",
      text: rawText,
    },
  };
  const out = sanitizeSlackEventPayload(body) as {
    event: { text?: string };
  };
  return String(out.event.text ?? "");
}

describe("summon detection survives Slack PII sanitization (triage path)", () => {
  it("the exact 2026-06-12 incident text is still detected after sanitize", () => {
    const raw = "can you join <https://meet.google.com/eox-aobn-kaz?authuser=0>";
    const sanitized = sanitizedEventText(raw);
    expect(detectSummon(sanitized)).toBeTruthy();
  });

  it("a Zoom link with a numeric meeting id (phone-redaction risk) still detects", () => {
    const raw = "join https://zoom.us/j/98765432123";
    const sanitized = sanitizedEventText(raw);
    expect(detectSummon(sanitized)).toBeTruthy();
  });

  it("a near-bare Google Meet link (no verb) still detects after sanitize", () => {
    const raw = "<https://meet.google.com/abc-defg-hij>";
    const sanitized = sanitizedEventText(raw);
    expect(detectSummon(sanitized)).toBeTruthy();
  });

  it("a non-summon ask containing a meeting link is NOT suppressed", () => {
    const raw =
      "summarize what happened in <https://meet.google.com/abc-defg-hij> for me please";
    const sanitized = sanitizedEventText(raw);
    expect(detectSummon(sanitized)).toBeNull();
  });

  it("an ordinary message with no meeting link is NOT a summon", () => {
    const sanitized = sanitizedEventText("hey can you pull the latest ad numbers");
    expect(detectSummon(sanitized)).toBeNull();
  });
});
