
import { describe, expect, it } from "vitest";
import { ANALYTICS, NECESSARY } from "@/lib/cookie-inventory";
import { isAnalyticsStorageKey } from "@/lib/consent";

describe("the inventory agrees with the purge", () => {
  it("every Analytics row is something withdrawal deletes", () => {
    const samples = [
      "ph_phc_abc_posthog",
      "__ph_opt_in_out_phc_abc",
      "__mp_opt_in_out_abc",
      "mp_abc_mixpanel",
      "ph_pv:https://www.zaviagent.com/",
      "mp_pv:/pricing",
      "mp_signup:uid",
      "mp_login:uid",
      "zft_first_touch",
      "_ga",
      "_ga_ABC123XYZ",
    ];
    for (const s of samples) {
      expect(ANALYTICS.some((r) => r.pattern.test(s)), s).toBe(true);
      expect(isAnalyticsStorageKey(s), s).toBe(true);
    }
    for (const r of ANALYTICS) {
      expect(samples.some((s) => r.pattern.test(s)), r.name).toBe(true);
    }
  });

  it("no Necessary row is something withdrawal deletes", () => {
    const samples = [
      "sb-proj-auth-token",
      "zavi_consent_v1",
      "zavi_region",
      "__epv_run",
      "zavi:dark",
      "zavi:column-order",
      "praxis.brain.view",
      "praxis_pending_build",
      "zavi.launch-video.job",
      "praxis:connect-return",
      "cf_clearance",
    ];
    for (const s of samples) {
      expect(NECESSARY.some((r) => r.pattern.test(s)), s).toBe(true);
      expect(isAnalyticsStorageKey(s), s).toBe(false);
    }
  });

  it("every row is fully described", () => {
    for (const r of [...NECESSARY, ...ANALYTICS]) {
      for (const f of ["name", "provider", "type", "expiry", "purpose"] as const) {
        expect(r[f], `${r.name}.${f}`).toBeTruthy();
      }
    }
  });
});
