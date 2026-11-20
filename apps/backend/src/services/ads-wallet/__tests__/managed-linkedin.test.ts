import { afterEach, expect, it, vi } from "vitest";
import { managedLinkedinEnabled } from "../managed-linkedin";
afterEach(() => { vi.unstubAllEnvs(); });
it("requires both funding enablement and explicit forward-only rollout acknowledgment", () => {
  vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED", "true");
  vi.stubEnv("ADS_LINKEDIN_ROLLOUT_ACK", "");
  expect(managedLinkedinEnabled()).toBe(false);
  vi.stubEnv("ADS_LINKEDIN_ROLLOUT_ACK", "campaign-bindings-forward-only");
  expect(managedLinkedinEnabled()).toBe(true);
  vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED", "false");
  expect(managedLinkedinEnabled()).toBe(false);
});
it("turns on with '1' or 'true' in any case, the same values the LinkedIn write switch takes", () => {
  vi.stubEnv("ADS_LINKEDIN_ROLLOUT_ACK", "campaign-bindings-forward-only");
  for (const on of ["1", "true", "TRUE", " True "]) {
    vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED", on);
    expect(managedLinkedinEnabled()).toBe(true);
  }
  for (const off of ["0", "false", "yes", "", "11"]) {
    vi.stubEnv("ADS_LINKEDIN_MANAGED_ENABLED", off);
    expect(managedLinkedinEnabled()).toBe(false);
  }
});
