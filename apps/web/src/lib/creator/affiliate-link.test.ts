import { expect, it } from "vitest";
import { AFFILIATE_BASE, affiliateBaseForOrigin } from "./affiliate-link";

it.each([
  ["https://latest.zaviagent.com", "https://latest.zaviagent.com/?via="],
  ["http://localhost:3301", "http://localhost:3301/?via="],
  ["http://127.0.0.1:3301", "http://127.0.0.1:3301/?via="],
  ["http://[::1]:3301", "http://[::1]:3301/?via="],
])("keeps test referral links in their own environment: %s", (origin, expected) => {
  expect(affiliateBaseForOrigin(origin)).toBe(expected);
});
it.each(["https://www.zaviagent.com", "https://zaviagent.com", "https://latest.zaviagent.com.evil.test", "https://unknown.test", "file://localhost", "invalid"]) (
  "keeps the canonical production destination for %s", origin => {
    expect(affiliateBaseForOrigin(origin)).toBe(AFFILIATE_BASE);
  },
);
