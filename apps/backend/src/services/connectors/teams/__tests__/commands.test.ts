import { describe, it, expect } from "vitest";
import {
  classifyTeamsText,
  connectedReplyFor,
  TEAMS_GREETING_TEXT,
  TEAMS_HELP_TEXT,
  TEAMS_ASK_EMPTY_TEXT,
  TEAMS_EMPTY_TEXT,
} from "../commands";

describe("classifyTeamsText", () => {
  it.each(["hi", "Hello!", "hey there", "Good morning."])("treats %s as a greeting", (t) => {
    expect(classifyTeamsText(t)).toEqual({ kind: "greeting" });
  });
  it.each(["help", "HELP", "/help", "?", "what can you do?"])("treats %s as help", (t) => {
    expect(classifyTeamsText(t)).toEqual({ kind: "help" });
  });
  it("treats the bare manifest 'ask' command as asking for a question", () => {
    expect(classifyTeamsText("ask")).toEqual({ kind: "ask_empty" });
  });
  it("strips the 'ask' command word and passes the question on", () => {
    expect(classifyTeamsText("ask why did signups drop?")).toEqual({ kind: "task", text: "why did signups drop?" });
  });
  it("passes a plain question to the agent untouched", () => {
    expect(classifyTeamsText("Hi, why did signups drop?")).toEqual({ kind: "task", text: "Hi, why did signups drop?" });
    expect(classifyTeamsText("asking for the plan")).toEqual({ kind: "task", text: "asking for the plan" });
  });
  it("treats an empty message as empty", () => {
    expect(classifyTeamsText("   ")).toEqual({ kind: "empty" });
  });
});

describe("connectedReplyFor", () => {
  it("answers every built-in command with a way forward and runs no agent for them", () => {
    expect(connectedReplyFor({ kind: "greeting" })).toBe(TEAMS_GREETING_TEXT);
    expect(connectedReplyFor({ kind: "help" })).toBe(TEAMS_HELP_TEXT);
    expect(connectedReplyFor({ kind: "ask_empty" })).toBe(TEAMS_ASK_EMPTY_TEXT);
    expect(connectedReplyFor({ kind: "empty" })).toBe(TEAMS_EMPTY_TEXT);
    expect(connectedReplyFor({ kind: "task", text: "x" })).toBeNull();
  });
});
