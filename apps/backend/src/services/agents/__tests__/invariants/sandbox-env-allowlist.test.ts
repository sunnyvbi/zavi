
import { describe, it, expect } from "vitest";
import { assertAllowlistedEnvKeys } from "../../../sandbox/e2b-client";

describe("invariant: sandbox env is deny-by-default (no connector secrets in-box)", () => {
  it("REJECTS a connector secret key", () => {
    expect(() =>
      assertAllowlistedEnvKeys({ STRIPE_SECRET_KEY: "sk_live_x" }),
    ).toThrow(/non-allowlisted key 'STRIPE_SECRET_KEY'/);
    expect(() => assertAllowlistedEnvKeys({ SLACK_BOT_TOKEN: "xoxb-x" })).toThrow(
      /non-allowlisted/,
    );
    expect(() => assertAllowlistedEnvKeys({ OPERATOR_DB_URL: "postgres://x" })).toThrow(
      /non-allowlisted/,
    );
  });

  it("REJECTS an arbitrary unknown key even mixed with an allowed one", () => {
    expect(() =>
      assertAllowlistedEnvKeys({ GITHUB_TOKEN: "ok", AWS_SECRET_ACCESS_KEY: "leak" }),
    ).toThrow(/AWS_SECRET_ACCESS_KEY/);
  });

  it("ALLOWS the two legitimate sandbox keys", () => {
    expect(() =>
      assertAllowlistedEnvKeys({ GITHUB_TOKEN: "t", NODE_OPTIONS: "--max-old-space-size=4096" }),
    ).not.toThrow();
    expect(() => assertAllowlistedEnvKeys({})).not.toThrow();
  });
});
