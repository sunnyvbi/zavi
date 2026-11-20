import { describe, it, expect } from "vitest";
import { detectSummon, summonAck } from "../../services/meetings/slack-summon";

describe("detectSummon", () => {
  it("detects an explicit join verb + slack-bracketed Meet link", () => {
    expect(
      detectSummon("<@U123ZAVI> join <https://meet.google.com/abc-defg-hij|meet.google.com>"),
    ).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("detects a bare link mention (no verb, nothing else said)", () => {
    expect(detectSummon("<@U123ZAVI> <https://meet.google.com/abc-defg-hij>")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });

  it("detects notetake/record/capture variants", () => {
    expect(
      detectSummon("hey can you record this one https://zoom.us/j/123456?pwd=x"),
    ).toBe("https://zoom.us/j/123456?pwd=x");
    expect(
      detectSummon("take notes here please <https://teams.microsoft.com/l/meetup-join/xyz>"),
    ).toBe("https://teams.microsoft.com/l/meetup-join/xyz");
  });

  it("does NOT summon on a prose question that merely contains a link", () => {
    expect(
      detectSummon(
        "<@U123ZAVI> can you summarize what the team discussed yesterday in the standup at <https://meet.google.com/abc-defg-hij> and compare with the jira board",
      ),
    ).toBeNull();
  });

  it("ignores messages without a supported meeting URL", () => {
    expect(detectSummon("<@U123ZAVI> join https://evil.example.com/call")).toBeNull();
    expect(detectSummon("join us for lunch")).toBeNull();
    expect(detectSummon("")).toBeNull();
  });

  it("strips slack link trailing |label and > from the URL", () => {
    const url = detectSummon("join <https://meet.google.com/abc-defg-hij|the standup>");
    expect(url).toBe("https://meet.google.com/abc-defg-hij");
  });
});

describe("summonAck: the thread is told what will happen to the summary", () => {
  it("promises the summary in the thread only when the team chose Slack or email", () => {
    expect(summonAck("slack", "t1")).toContain("I'll post the summary here after the call.");
    expect(summonAck("email", "t1")).toContain("I'll post the summary here after the call.");
    expect(summonAck("off", "t1")).toContain("I won't post a summary here");
    const unchosen = summonAck(null, "t1");
    expect(unchosen).toContain("hasn't chosen where summaries go");
    expect(unchosen).toContain("/workspace?tab=meet&company=t1");
    expect(unchosen).not.toContain("I'll post the summary here");
  });
});
