
import { describe, expect, it } from "vitest";

import { parseInput } from "./slashCommands";

type Case = {
  name: string;
  input: string;
  expected: ReturnType<typeof parseInput>;
};

const cases: Case[] = [
  {
    name: "plain text → chat",
    input: "what was yesterday's big event",
    expected: { kind: "chat", body: "what was yesterday's big event" },
  },
  {
    name: "empty → empty chat",
    input: "",
    expected: { kind: "chat", body: "" },
  },
  {
    name: "whitespace → empty chat",
    input: "   ",
    expected: { kind: "chat", body: "" },
  },
  {
    name: "/run alone → force_run with empty body",
    input: "/run",
    expected: { kind: "force_run", body: "" },
  },
  {
    name: "/run with body → force_run carrying body",
    input: "/run review yesterday's dispute",
    expected: { kind: "force_run", body: "review yesterday's dispute" },
  },
  {
    name: "@agent body → route_to_agent",
    input: "@support-lead look at trip 10583",
    expected: {
      kind: "route_to_agent",
      agent: "support-lead",
      body: "look at trip 10583",
    },
  },
  {
    name: "@agent only → route_to_agent with empty body",
    input: "@chief-of-staff",
    expected: { kind: "route_to_agent", agent: "chief-of-staff", body: "" },
  },
  {
    name: "@ alone → plain chat",
    input: "@",
    expected: { kind: "chat", body: "@" },
  },
  {
    name: "@ followed by space → plain chat",
    input: "@ hi",
    expected: { kind: "chat", body: "@ hi" },
  },
  {
    name: "@invalid_chars → plain chat (don't pretend it routed)",
    input: "@WEIRD_AGENT body",
    expected: { kind: "chat", body: "@WEIRD_AGENT body" },
  },
  {
    name: "/decision <uuid> body → attach_decision",
    input: "/decision 11111111-2222-3333-4444-555555555555 approve this",
    expected: {
      kind: "attach_decision",
      decisionId: "11111111-2222-3333-4444-555555555555",
      body: "approve this",
    },
  },
  {
    name: "/decision <non-uuid> → unknown_command (reject; don't silently chat)",
    input: "/decision not-a-uuid look at this",
    expected: {
      kind: "unknown_command",
      raw: "/decision not-a-uuid look at this",
    },
  },
  {
    name: "/decision alone → unknown_command",
    input: "/decision",
    expected: { kind: "unknown_command", raw: "/decision" },
  },
  {
    name: "/unknown → unknown_command",
    input: "/foo bar",
    expected: { kind: "unknown_command", raw: "/foo bar" },
  },
  {
    name: "/feedback alone → unknown_command (force user to type body)",
    input: "/feedback",
    expected: { kind: "unknown_command", raw: "/feedback" },
  },
  {
    name: "/feedback with body → feedback",
    input: "/feedback the dispute reply was too long",
    expected: { kind: "feedback", body: "the dispute reply was too long" },
  },
  {
    name: "/feedback with whitespace-only body → unknown_command",
    input: "/feedback   ",
    expected: { kind: "unknown_command", raw: "/feedback" },
  },
  {
    name: "/Feedback (uppercase) → still parsed (lowercased)",
    input: "/Feedback be more concise",
    expected: { kind: "feedback", body: "be more concise" },
  },
  {
    name: "/clear alone → clear",
    input: "/clear",
    expected: { kind: "clear" },
  },
  {
    name: "/clear with body (ignored) → clear",
    input: "/clear okay sure",
    expected: { kind: "clear" },
  },
  {
    name: "/Clear (uppercase) → still parsed (lowercased)",
    input: "/Clear",
    expected: { kind: "clear" },
  },
  {
    name: "/help alone → help",
    input: "/help",
    expected: { kind: "help" },
  },
  {
    name: "/help with body (ignored) → help",
    input: "/help me out",
    expected: { kind: "help" },
  },
  {
    name: "/Help (uppercase) → still parsed (lowercased)",
    input: "/Help",
    expected: { kind: "help" },
  },
  {
    name: "/ alone → plain chat",
    input: "/",
    expected: { kind: "chat", body: "/" },
  },
  {
    name: "/ followed by space → plain chat",
    input: "/ hi",
    expected: { kind: "chat", body: "/ hi" },
  },
];

describe("parseInput", () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(parseInput(c.input)).toEqual(c.expected);
    });
  }
});
