import { describe, it, expect } from "vitest";
import { checkExecutionEnvSafe, assertExecutionEnvSafe } from "../boot-guard";

const PROD_REF = "wmycgyjsenvgtczlupoe";

describe("checkExecutionEnvSafe", () => {
  it("prod process (EXECUTION_ENV unset) is always ok, even on the prod DB", () => {
    expect(checkExecutionEnvSafe({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` }).ok).toBe(true);
  });

  it("prod process (EXECUTION_ENV=prod) is ok on the prod DB", () => {
    expect(checkExecutionEnvSafe({ EXECUTION_ENV: "prod", SUPABASE_URL: `https://${PROD_REF}.supabase.co` }).ok).toBe(true);
  });

  it("staging process pointed at the PROD project ref is REFUSED", () => {
    const r = checkExecutionEnvSafe({
      EXECUTION_ENV: "staging",
      STAGING_SUPABASE_PROJECT_REF: "stagingref123",
      SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(PROD_REF);
  });

  it("staging process with NO STAGING_SUPABASE_PROJECT_REF is REFUSED (cannot prove isolation)", () => {
    const r = checkExecutionEnvSafe({ EXECUTION_ENV: "staging", SUPABASE_URL: "https://stagingref123.supabase.co" });
    expect(r.ok).toBe(false);
  });

  it("staging process whose SUPABASE_URL host does NOT match the staging ref is REFUSED", () => {
    const r = checkExecutionEnvSafe({
      EXECUTION_ENV: "staging",
      STAGING_SUPABASE_PROJECT_REF: "stagingref123",
      SUPABASE_URL: "https://someotherref.supabase.co",
    });
    expect(r.ok).toBe(false);
  });

  it("staging process correctly pointed at its own staging project is ok", () => {
    const r = checkExecutionEnvSafe({
      EXECUTION_ENV: "staging",
      STAGING_SUPABASE_PROJECT_REF: "stagingref123",
      SUPABASE_URL: "https://stagingref123.supabase.co",
    });
    expect(r.ok).toBe(true);
  });
});

describe("assertExecutionEnvSafe", () => {
  it("throws for staging misconfig, no-ops for prod", () => {
    expect(() => assertExecutionEnvSafe({ EXECUTION_ENV: "staging", SUPABASE_URL: `https://${PROD_REF}.supabase.co` })).toThrow();
    expect(() => assertExecutionEnvSafe({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` })).not.toThrow();
  });
});
