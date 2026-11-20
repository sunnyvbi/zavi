import { describe, expect, it } from "vitest";
import { limitKind, parseResetAt, usageLimitBenchMs } from "../seat-limit";
import { isProviderCapNotice, isUsageLimitError } from "../infra-retry";

const H = 3_600_000;
const NOW = Date.parse("2026-10-12T14:06:36Z");

describe("the provider's limit notices", () => {
  const notices = [
    "You've hit your weekly limit · resets 4am (UTC)",
    "You've hit your session limit · resets 9am (UTC)",
    "You’ve hit your weekly limit · resets 4am (UTC)",
    "You've hit your limit · resets Jun 13, 12am (UTC)",
    "You're out of extra usage · resets Sep 18 at 12pm (America/Los_Angeles)",
  ];

  it("are recognised as a standalone cap notice (so a clean attempt rotates)", () => {
    for (const n of notices) expect(isProviderCapNotice(n), n).toBe(true);
    for (const n of notices) expect(isUsageLimitError(n), n).toBe(true);
  });

  it("ordinary answers that mention limits are not", () => {
    for (const t of [
      "You've hit your daily budget limit on Meta, so I paused the raise.",
      "If you've hit your limit, it resets at 7pm (UTC).",
      "The campaign hit your spend limit yesterday.",
    ]) {
      expect(isProviderCapNotice(t), t).toBe(false);
    }
    expect(isUsageLimitError("You've hit your daily budget limit on Meta.")).toBe(false);
  });
});

describe("parseResetAt", () => {
  it("a time with no date is its next occurrence", () => {
    expect(parseResetAt("You've hit your weekly limit · resets 4am (UTC)", NOW)).toBe(Date.parse("2026-10-13T04:00:00Z"));
    expect(parseResetAt("resets 3pm (UTC)", NOW)).toBe(Date.parse("2026-10-12T15:00:00Z"));
    expect(parseResetAt("resets 12:20am (UTC)", NOW)).toBe(Date.parse("2026-10-13T00:20:00Z"));
  });

  it("a dated reset, in UTC or a named zone", () => {
    expect(parseResetAt("resets Oct 19, 12am (UTC)", NOW)).toBe(Date.parse("2026-10-19T00:00:00Z"));
    expect(parseResetAt("resets Oct 18 at 12pm (America/Los_Angeles)", NOW)).toBe(Date.parse("2026-10-18T19:00:00Z"));
  });

  it("nothing usable → null", () => {
    expect(parseResetAt("You've hit your limit", NOW)).toBeNull();
    expect(parseResetAt("resets soon", NOW)).toBeNull();
    expect(parseResetAt("resets 4am (Mars/Base)", NOW)).toBeNull();
  });
});

describe("usageLimitBenchMs", () => {
  it("a weekly cap sits out until its reset, not 20 minutes", () => {
    expect(usageLimitBenchMs("You've hit your weekly limit · resets 4am (UTC)", NOW)).toBe(Date.parse("2026-10-13T04:00:00Z") - NOW);
  });

  it("the SDK's resetsAt wins over the text", () => {
    const sdk = Date.parse("2026-10-15T04:00:00Z") / 1000;
    expect(usageLimitBenchMs("You've hit your weekly limit · resets 4am (UTC)", NOW, sdk)).toBe(sdk * 1000 - NOW);
  });

  it("no reset time: 24h weekly, 5h session, 20 min otherwise", () => {
    expect(usageLimitBenchMs("You've hit your weekly limit", NOW)).toBe(24 * H);
    expect(usageLimitBenchMs("You've hit your session limit", NOW)).toBe(5 * H);
    expect(usageLimitBenchMs("rate limited", NOW)).toBe(20 * 60_000);
  });

  it("clamped: never under 20 minutes, never over 8 days", () => {
    expect(usageLimitBenchMs("x", NOW, NOW / 1000 + 60)).toBe(20 * 60_000);
    expect(usageLimitBenchMs("x", NOW, NOW / 1000 + 30 * 24 * 3600)).toBe(8 * 24 * H);
  });

  it("limitKind", () => {
    expect(limitKind("You've hit your weekly limit · resets 4am (UTC)")).toBe("weekly");
    expect(limitKind("You've hit your session limit · resets 9am (UTC)")).toBe("session");
    expect(limitKind("You're out of extra usage · resets 7pm (UTC)")).toBe("other");
  });
});
