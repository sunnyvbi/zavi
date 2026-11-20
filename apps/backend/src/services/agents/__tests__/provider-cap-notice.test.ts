
import { describe, it, expect } from "vitest";
import {
  isProviderCapNotice,
  ProviderUsageLimitError,
  isUsageLimitError,
} from "../infra-retry";
import { parseUsageLimit } from "../usage-limit-alert";
import {
  chatFailureBubbleBody,
  usageLimitFailureBody,
  USAGE_LIMIT_FAILURE_BODY,
} from "../error-body";

const CAP_EXTRA_USAGE = "You're out of extra usage · resets 7pm (UTC)";
const CAP_HIT_LIMIT = "You've hit your limit · resets Jun 13, 12am (UTC)";
const CAP_EXTRA_USAGE_2 = "You're out of extra usage · resets 10:40am (UTC)";

describe("isProviderCapNotice — TIGHT standalone cap classifier", () => {
  it("matches the real provider cap notices", () => {
    expect(isProviderCapNotice(CAP_EXTRA_USAGE)).toBe(true);
    expect(isProviderCapNotice(CAP_HIT_LIMIT)).toBe(true);
    expect(isProviderCapNotice(CAP_EXTRA_USAGE_2)).toBe(true);
    expect(isProviderCapNotice(`\n  ${CAP_EXTRA_USAGE}  \n`)).toBe(true);
  });

  it("does NOT match a normal agent reply that discusses limits", () => {
    expect(
      isProviderCapNotice(
        "If you've hit your usage limit, it usually resets at midnight — try again tomorrow and let me know if it still fails.",
      ),
    ).toBe(false);
    expect(
      isProviderCapNotice(
        "Your ad account looks like it's out of credits. You'll want to top it up before the campaign can resume.",
      ),
    ).toBe(false);
    expect(
      isProviderCapNotice(
        "Heads up: rate limits reset periodically, so if a call fails just retry after a bit.",
      ),
    ).toBe(false);
    expect(
      isProviderCapNotice("If you've hit your limit, it resets at 7pm (UTC); try later."),
    ).toBe(false);
  });

  it("rejects empty, long, and reset-less strings", () => {
    expect(isProviderCapNotice(null)).toBe(false);
    expect(isProviderCapNotice("")).toBe(false);
    expect(isProviderCapNotice("you're out of extra usage, resets tomorrow")).toBe(
      false,
    );
    const longProse =
      "Thanks for the detailed context — here's my full analysis. " +
      "One thing worth noting is that you've hit your limit on the free tier which resets at 9am, " +
      "but that's separate from the core issue, which is that the webhook signature is failing verification because the secret rotated last week.";
    expect(longProse.length).toBeGreaterThan(200);
    expect(isProviderCapNotice(longProse)).toBe(false);
  });
});

describe("ProviderUsageLimitError — message invariant (load-bearing)", () => {
  it("carries a message that isUsageLimitError + parseUsageLimit both recognize", () => {
    const err = new ProviderUsageLimitError(CAP_EXTRA_USAGE);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProviderUsageLimitError");
    expect(isUsageLimitError(err.message)).toBe(true);
    const parsed = parseUsageLimit(err.message);
    expect(parsed.hit).toBe(true);
    expect(parsed.resetsAt).toContain("7pm");
    expect(parsed.resetsAt).toContain("UTC");
  });
});

describe("terminal bubble copy — reset window folded in (P0.c)", () => {
  it("appends the parsed reset window when available", () => {
    const body = usageLimitFailureBody(CAP_EXTRA_USAGE);
    expect(body).toContain("7pm (UTC)");
    expect(body).toContain("resets around 7pm (UTC)");
    expect(body).not.toBe(USAGE_LIMIT_FAILURE_BODY);
  });

  it("falls back to the generic body when the window is unparseable", () => {
    expect(usageLimitFailureBody("You're out of extra usage")).toBe(
      USAGE_LIMIT_FAILURE_BODY,
    );
    expect(usageLimitFailureBody(null)).toBe(USAGE_LIMIT_FAILURE_BODY);
  });

  it("chatFailureBubbleBody routes a usage-limit error to the (windowed) usage-limit copy", () => {
    const body = chatFailureBubbleBody(
      "Claude Code returned an error result: " + CAP_HIT_LIMIT,
      "engineer",
    );
    expect(body).toContain("usage limit on the AI service");
    expect(body).toContain("Jun 13");
  });

  it("chatFailureBubbleBody does NOT use the usage-limit copy for an ordinary error", () => {
    const body = chatFailureBubbleBody("ECONNRESET: socket hang up", "engineer");
    expect(body).not.toContain("usage limit on the AI service");
    expect(body).toContain("Something failed");
  });
});
