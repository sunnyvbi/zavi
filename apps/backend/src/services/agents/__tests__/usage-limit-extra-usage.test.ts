
import { describe, it, expect } from "vitest";
import { isUsageLimitError } from "../infra-retry";
import { parseUsageLimit } from "../usage-limit-alert";

const EXTRA_USAGE_FULL =
  "Claude Code returned an error result: You're out of extra usage · resets 10:40am (UTC)";
const EXTRA_USAGE_BARE = "You're out of extra usage";
const HIT_LIMIT_FULL =
  "Claude Code returned an error result: You've hit your limit · resets 6am (UTC)";

describe("usage-limit classification — 'out of extra usage'", () => {
  it("run-level gate matches the extra-usage string (full + bare)", () => {
    expect(isUsageLimitError(EXTRA_USAGE_FULL)).toBe(true);
    expect(isUsageLimitError(EXTRA_USAGE_BARE)).toBe(true);
  });

  it("ops-alert path matches the extra-usage string (full + bare) and keeps the reset window", () => {
    const full = parseUsageLimit(EXTRA_USAGE_FULL);
    expect(full.hit).toBe(true);
    expect(full.resetsAt).toContain("10:40am");
    expect(parseUsageLimit(EXTRA_USAGE_BARE).hit).toBe(true);
  });

  it("both paths still match the original 'hit your limit' string", () => {
    expect(isUsageLimitError(HIT_LIMIT_FULL)).toBe(true);
    expect(parseUsageLimit(HIT_LIMIT_FULL).hit).toBe(true);
  });

  it("neither path false-positives on an ordinary field-length error", () => {
    const benign = "ValidationError: value exceeds the 280 character limit";
    expect(isUsageLimitError(benign)).toBe(false);
    expect(parseUsageLimit(benign).hit).toBe(false);
  });

  it("ops-alert path does NOT page on the tenant 'out of credits — top up' string", () => {
    const tenantCredit =
      'Agent "engineer" rejected: out of credits — top up to keep running';
    expect(parseUsageLimit(tenantCredit).hit).toBe(false);
  });
});
