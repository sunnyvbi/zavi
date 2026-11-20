
import { describe, expect, it } from "vitest";
import { CONTACT_REDACTION, scrubContact } from "../contact-scrub";

const survives = (s: string) => {
  const r = scrubContact(s);
  expect(r.body, s).toBe(s);
  expect(r.removed, s).toEqual([]);
};

const scrubbed = (s: string, kind: string) => {
  const r = scrubContact(s);
  expect(r.body, s).toContain(CONTACT_REDACTION);
  expect(r.removed, s).toContain(kind);
};

describe("money, counts and ordinary sentences survive", () => {
  it.each([
    "Your payout of $127.50 is on its way to Stripe now.",
    "You were paid $127.50",
    "Zavi sent $127.50 to your Stripe account for 3 ad videos.",
    "$150 is on its way",
    "3 videos are on the way",
    "1,500 followers and 3 posts",
    "The job takes 3 days and the review window is 72 hours.",
    "$1,250.00 is released after a 10 day buffer.",
    "Delivery is due in 2 days, the draft is on its way.",
  ])("%s", survives);
});

describe("contact details a human typed are still removed", () => {
  it.each([
    ["Come by 1200 Market Street and pick it up.", "address"],
    ["meet me at 45 Oak Ave", "address"],
    ["my place is 742 Evergreen Terrace", "address"],
    ["drop it at 9 west 57th st", "address"],
    ["reach me at nia@example.com", "email"],
    ["nia (at) example.com works too", "email"],
    ["call +1 (415) 555-0199", "phone"],
    ["ping wa.me/14155550199", "link"],
    ["t.me/niacreates is faster", "link"],
  ])("%s", (body, kind) => scrubbed(body, kind));
});

describe("the rule is reusable", () => {
  it("does not carry regex state between calls", () => {
    const body = "reach me at nia@example.com";
    for (let i = 0; i < 3; i += 1) expect(scrubContact(body).removed).toEqual(["email"]);
  });
});
