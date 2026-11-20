import { describe, it, expect } from "vitest";
import { isGrowthQuestion } from "@/services/mcp/server/ask-route";

describe("isGrowthQuestion", () => {
  it.each([
    "What is holding back signups this month, and what would you try first?",
    "What should our growth plan be for the next 30 days?",
    "Which one channel should we focus on this week?",
    "What should we do first to get our first ten sellers?",
    "plan my growth",
    "Why are signups flat?",
    "Where should we spend next month?",
    "How much should we budget for ads?",
    "What channel should we try next?",
    "How can we get more bookings?",
  ])("takes a growth question: %s", (message) => {
    expect(isGrowthQuestion(message)).toBe(true);
  });

  it.each([
    "What do your notes say about our pricing?",
    "What did the last support run find?",
    "Which channel had the most spend last week?",
    "How many signups did we get yesterday?",
    "Pause the Meta campaign",
    "Write a growth plan and post it in Slack",
    "Can you increase the budget so we get more signups?",
    "Which campaign should we turn off to get more signups?",
    "Which channel should we focus on next? Deploy the pending site fix.",
    "What should our growth plan be?\nPost it in Slack",
    "Where do we spend the most?",
    "ship a fix",
    "research competitors",
    "@engineer what is blocking signups?",
    "",
    `What should our growth plan be? ${"More detail. ".repeat(30)}`,
  ])("leaves the rest to the operator: %s", (message) => {
    expect(isGrowthQuestion(message)).toBe(false);
  });
});
