import { describe, it, expect } from "vitest";
import { stripProcessNarration } from "../reply-brevity";

const pad = (s: string) => s + "\n\n" + "x".repeat(650);

describe("stripProcessNarration", () => {
  it("drops a leading read-budget apology so the answer leads", () => {
    const body = pad(
      [
        "I hit the read budget before I could open the Private page components.",
        "The toggle is always visible; only turning it ON is gated by billing.",
      ].join("\n"),
    );
    const out = stripProcessNarration({ body, userMessage: "is the toggle shown?" });
    expect(out).not.toContain("read budget");
    expect(out).toContain("The toggle is always visible");
  });

  it("drops a first-person investigation opener", () => {
    const body = pad(
      [
        "Let me check the checkout code and the pricing service.",
        "The gig flag is dropped between the click and the price call.",
      ].join("\n"),
    );
    const out = stripProcessNarration({ body, userMessage: "why same price?" });
    expect(out).not.toContain("Let me check");
    expect(out).toContain("The gig flag is dropped");
  });

  it("KEEPS a line with a conclusion after ':' even though it opens with 'Checking'", () => {
    const body = pad(
      [
        "Checking trip 16289: the refund is already posted, guest was made whole.",
        "Nothing further is needed on this one.",
      ].join("\n"),
    );
    const out = stripProcessNarration({ body, userMessage: "refund status?" });
    expect(out).toContain("Checking trip 16289: the refund is already posted");
  });

  it("KEEPS a line carrying a Stripe payment ID / domain id", () => {
    const body = pad(
      [
        "I looked at the payout and Stripe shows pi_3TrvGXLKcPR2 failed on retry.",
        "You'll want to re-add the bank account.",
      ].join("\n"),
    );
    const out = stripProcessNarration({ body, userMessage: "payout issue?" });
    expect(out).toContain("pi_3TrvGXLKcPR2");
  });

  it("never enters a fenced code block", () => {
    const code = ["```ts", "let me = checkThis(); // narration-looking code", "```"].join("\n");
    const body = pad(["Here's the fix:", code].join("\n"));
    const out = stripProcessNarration({ body, userMessage: "how do I fix it?" });
    expect(out).toContain("let me = checkThis(); // narration-looking code");
  });

  it("EXEMPT: operator asked for depth (FULL_REQUEST_MARKERS) → byte-identical", () => {
    const body = pad(
      ["Let me walk through it.", "Checking the flow now.", "Step one is X."].join("\n"),
    );
    const out = stripProcessNarration({
      body,
      userMessage: "walk me through the full flow",
    });
    expect(out).toBe(body);
  });

  it("EXEMPT: operator named a path → byte-identical (keeps the path they asked about)", () => {
    const body = pad(
      ["I checked runner.ts and the routing is at the top.", "It handles slack there."].join("\n"),
    );
    const out = stripProcessNarration({ body, userMessage: "which file handles runner.ts routing?" });
    expect(out).toBe(body);
  });

  it("short clean reply → byte-identical no-op (under the floor)", () => {
    const body = "The deposit is held for 7 days after the trip ends.";
    expect(stripProcessNarration({ body, userMessage: "deposit window?" })).toBe(body);
  });

  it("long clean reply with no narration → byte-identical (nothing matched)", () => {
    const body = pad(
      "The deposit is held for 7 days after the trip ends. Inside that window it can be applied to incidentals or damage; after it, it auto-releases.",
    );
    expect(stripProcessNarration({ body, userMessage: "deposit?" })).toBe(body);
  });

  it("KEEPS a numbered-list line even without a space after the colon", () => {
    const body = pad(
      [
        "Two things on the deposit:",
        "3:deposit held 7 days after trip end, then auto-releases.",
        "That window covers incidentals.",
      ].join("\n"),
    );
    const out = stripProcessNarration({ body, userMessage: "deposit rules?" });
    expect(out).toContain("3:deposit held 7 days after trip end");
  });

  it("drops a pasted grep command line", () => {
    const body = pad(
      [
        'grep -n "trigger" workers/index',
        "The routing only sends chat into runChat, so slack misses the backstop.",
      ].join("\n"),
    );
    const out = stripProcessNarration({ body, userMessage: "why no strip on slack?" });
    expect(out).not.toContain('grep -n "trigger"');
    expect(out).toContain("The routing only sends chat into runChat");
  });

  it("kill switch REPLY_BREVITY_STRIP=0 → byte-identical", () => {
    const prev = process.env.REPLY_BREVITY_STRIP;
    process.env.REPLY_BREVITY_STRIP = "0";
    try {
      const body = pad(["I hit the read budget.", "The answer is X."].join("\n"));
      expect(stripProcessNarration({ body, userMessage: "?" })).toBe(body);
    } finally {
      if (prev === undefined) delete process.env.REPLY_BREVITY_STRIP;
      else process.env.REPLY_BREVITY_STRIP = prev;
    }
  });

  it("null / empty userMessage does not throw and still strips", () => {
    const body = pad(["Let me check the logs.", "The service is healthy."].join("\n"));
    expect(() => stripProcessNarration({ body, userMessage: null })).not.toThrow();
    expect(stripProcessNarration({ body, userMessage: null })).not.toContain("Let me check the logs");
  });
});
