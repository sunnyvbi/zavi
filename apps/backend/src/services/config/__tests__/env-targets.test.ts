import { describe, it, expect } from "vitest";
import { resolveInngestAppId, resolveInngestServeHost, resolveIssuerUrl } from "../env-targets";

describe("env-targets (defaults to current prod values)", () => {
  it("issuer falls back to the prod default when nothing set", () => {
    expect(resolveIssuerUrl({})).toBe("https://api.zaviagent.com");
  });

  it("issuer uses PRAXIS_ISSUER_URL when set (prod behavior unchanged)", () => {
    expect(resolveIssuerUrl({ PRAXIS_ISSUER_URL: "https://api.zaviagent.com" })).toBe("https://api.zaviagent.com");
  });

  it("issuer prefers the staging override ONLY for a staging process", () => {
    expect(resolveIssuerUrl({ EXECUTION_ENV: "staging", STAGING_ISSUER_URL: "https://api-staging.zaviagent.com" }))
      .toBe("https://api-staging.zaviagent.com");
    expect(resolveIssuerUrl({ STAGING_ISSUER_URL: "https://api-staging.zaviagent.com" }))
      .toBe("https://api.zaviagent.com");
  });

  it("inngest serve host passes through undefined on prod (unchanged)", () => {
    expect(resolveInngestServeHost({})).toBeUndefined();
    expect(resolveInngestServeHost({ INNGEST_SERVE_HOST: "https://api.zaviagent.com" })).toBe("https://api.zaviagent.com");
  });

  it("inngest serve host uses staging override only for a staging process", () => {
    expect(resolveInngestServeHost({ EXECUTION_ENV: "staging", STAGING_INNGEST_SERVE_HOST: "https://api-staging.zaviagent.com" }))
      .toBe("https://api-staging.zaviagent.com");
    expect(resolveInngestServeHost({ STAGING_INNGEST_SERVE_HOST: "https://api-staging.zaviagent.com" }))
      .toBeUndefined();
  });

  it("inngest app id is exactly 'praxis' on any non-staging process (prod unchanged)", () => {
    expect(resolveInngestAppId({})).toBe("praxis");
    expect(resolveInngestAppId({ EXECUTION_ENV: "prod" })).toBe("praxis");
    expect(resolveInngestAppId({ STAGING_SUPABASE_PROJECT_REF: "stagingref123" })).toBe("praxis");
  });

  it("inngest app id is a separate 'praxis-staging' app only for a staging process", () => {
    expect(resolveInngestAppId({ EXECUTION_ENV: "staging" })).toBe("praxis-staging");
  });
});
