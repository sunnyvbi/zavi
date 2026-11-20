import { expect, it } from "vitest";
import { chatgptAccountReadable } from "./adapters";
it("uses observed inventory, including empty/partial reads, instead of source or connector presence", () => {
  const base = { source: "chatgpt_ads_api", campaigns: [] };
  expect(chatgptAccountReadable(base)).toBe(false);
  for (const status of ["complete", "partial"]) expect(chatgptAccountReadable({ ...base, account_read: { status, observed_at: "2026-10-23T00:00:00Z" } })).toBe(true);
  expect(chatgptAccountReadable({ ...base, account_read: { status: "unavailable" } })).toBe(false);
  expect(chatgptAccountReadable({ ...base, error_code: "offline", account_read: { status: "complete" } })).toBe(false);
});
