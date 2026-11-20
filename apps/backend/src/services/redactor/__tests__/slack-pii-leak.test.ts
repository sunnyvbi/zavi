
import { describe, it, expect } from "vitest";
import { sanitizeSlackEventPayload } from "../slack-payload-sanitizer";

const FIXTURES: Array<{
  name: string;
  raw_value: string;
  expected_marker_substring: string;
}> = [
  { name: "plain email in event.text",       raw_value: "ping me at bob@example.com",        expected_marker_substring: "‹redacted:email›" },
  { name: "email inside attachment text",    raw_value: "see contact details: alice.smith+ops@startup.io for billing", expected_marker_substring: "‹redacted:email›" },
  { name: "email inside block element",      raw_value: "owner is owner@team.co",            expected_marker_substring: "‹redacted:email›" },
  { name: "email in profile.real_name",      raw_value: "carol@acme.com",                    expected_marker_substring: "‹redacted›" },

  { name: "phone in event.text",             raw_value: "call +1 (415) 555-2671 asap",        expected_marker_substring: "‹redacted:phone›" },
  { name: "phone in previous_message.text",  raw_value: "old number was 415-555-9988",        expected_marker_substring: "‹redacted:phone›" },

  { name: "ssn in event.text",               raw_value: "ssn 123-45-6789 belongs to the contractor",      expected_marker_substring: "‹redacted:ssn›" },
  { name: "ssn in attachment fallback",      raw_value: "applicant tax id 987-65-4321 was rejected",      expected_marker_substring: "‹redacted:ssn›" },

  { name: "card in event.text",              raw_value: "the test card 4242 4242 4242 4242 worked",     expected_marker_substring: "‹redacted:card›" },
  { name: "card in attachment text",         raw_value: "amex 3782-822463-10005 declined",              expected_marker_substring: "‹redacted:card›" },

  { name: "JWT in event.text",               raw_value: "auth bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123XYZ_def456-ghi789 expired", expected_marker_substring: "‹redacted:secret›" },
  { name: "JWT in block.text",               raw_value: "captured token eyJzZXNzaW9uIjoidGVzdCJ9.eyJ1c2VyIjoiYWxpY2UifQ.zyx987-uvw654_tsr321 needs rotation", expected_marker_substring: "‹redacted:secret›" },

  { name: "api key in event.text",           raw_value: "stripe sk-test-abcdefghij1234567890ABCDEFGHIJ leaked", expected_marker_substring: "‹redacted:secret›" },
  { name: "api key in files[].name",         raw_value: "sk-prod-XYZ1234567890abcd",                  expected_marker_substring: "‹redacted›" },
];

function buildEnvelope(raw: string): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: "T12345",
    event_id: "Ev123",
    event: {
      type: "message",
      channel: "C1",
      ts: "1700000000.000100",
      user: "U1",
      text: raw,
      attachments: [
        { text: raw, fallback: raw, pretext: raw, title: raw },
      ],
      blocks: [
        {
          type: "rich_text",
          text: { type: "plain_text", text: raw },
          elements: [
            { type: "rich_text_section", text: raw, elements: [{ type: "text", text: raw }] },
          ],
        },
      ],
      files: [{ name: raw, title: raw }],
      previous_message: { text: raw },
      profile: { display_name: raw, real_name: raw },
    },
  };
}

function flattenStrings(value: unknown, acc: string[] = []): string[] {
  if (value === null || value === undefined) return acc;
  if (typeof value === "string") {
    acc.push(value);
    return acc;
  }
  if (typeof value === "number" || typeof value === "boolean") return acc;
  if (Array.isArray(value)) {
    for (const el of value) flattenStrings(el, acc);
    return acc;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      flattenStrings(v, acc);
    }
  }
  return acc;
}

describe("G2 — Slack payload sanitizer must redact all PII shapes", () => {
  for (const fx of FIXTURES) {
    it(`fixture: ${fx.name}`, () => {
      const before = buildEnvelope(fx.raw_value);
      const after = sanitizeSlackEventPayload(before);
      const allStrings = flattenStrings(after).join("\n");

      expect(allStrings).toContain(fx.expected_marker_substring);

      const RAW_LEAKAGE_PATTERNS = [
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
        /\b\d{3}-\d{2}-\d{4}\b/,
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
        /\bsk-[A-Za-z0-9-]{10,}\b/,
      ];
      for (const p of RAW_LEAKAGE_PATTERNS) {
        expect(allStrings).not.toMatch(p);
      }
    });
  }

  it("idempotent — sanitizing twice produces byte-identical output", () => {
    const envelope = buildEnvelope("bob@example.com and 415-555-2671 and 123-45-6789");
    const once = sanitizeSlackEventPayload(envelope);
    const twice = sanitizeSlackEventPayload(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("preserves shape — non-PII fields pass through unchanged", () => {
    const envelope = {
      type: "event_callback",
      team_id: "T12345",
      event_id: "Ev999",
      event: {
        type: "message",
        channel: "C1",
        ts: "1700000000.000100",
        text: "no pii here, just a normal message",
        thread_ts: "1699999999.000050",
      },
    };
    const after = sanitizeSlackEventPayload(envelope) as Record<string, unknown>;
    expect(after.type).toBe("event_callback");
    expect(after.team_id).toBe("T12345");
    expect((after.event as { type: string }).type).toBe("message");
    expect((after.event as { thread_ts: string }).thread_ts).toBe("1699999999.000050");
    expect((after.event as { text: string }).text).toBe("no pii here, just a normal message");
  });

  it("opaque Slack identifiers (ts/channel/user/event_id) MUST pass through unchanged", () => {
    const envelope = {
      type: "event_callback",
      team_id: "T12345",
      api_app_id: "A0123",
      event_id: "Ev999",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C9999",
        channel_type: "channel",
        ts: "1700000000.000100",
        thread_ts: "1699999999.000050",
        deleted_ts: "1699999998.000040",
        client_msg_id: "abc-123-uuid",
        user: "U777",
        team: "T12345",
        bot_id: "B555",
        previous_message: { ts: "1699999900.000001", user: "U777" },
      },
    };
    const after = sanitizeSlackEventPayload(envelope) as { event: Record<string, unknown> };
    expect(after.event.ts).toBe("1700000000.000100");
    expect(after.event.thread_ts).toBe("1699999999.000050");
    expect(after.event.deleted_ts).toBe("1699999998.000040");
    expect(after.event.channel).toBe("C9999");
    expect(after.event.channel_type).toBe("channel");
    expect(after.event.client_msg_id).toBe("abc-123-uuid");
    expect(after.event.user).toBe("U777");
    expect(after.event.team).toBe("T12345");
    expect(after.event.bot_id).toBe("B555");
    expect(after.event.subtype).toBe("message_changed");
    const prev = after.event.previous_message as Record<string, unknown>;
    expect(prev.ts).toBe("1699999900.000001");
    expect(prev.user).toBe("U777");
  });
});
