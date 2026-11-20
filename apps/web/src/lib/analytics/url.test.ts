import { describe, expect, it } from "vitest";
import { analyticsPath, analyticsUrl, scrubUrlProps } from "./url";

describe("analyticsUrl", () => {
  it("keeps campaign tags and drops everything else in the query", () => {
    expect(
      analyticsUrl("https://www.zaviagent.com/start?utm_source=x&gclid=abc&website=acme.com&next=%2Fw"),
    ).toBe("https://www.zaviagent.com/start?utm_source=x&gclid=abc");
  });

  it("drops invite keys and auth codes", () => {
    expect(analyticsUrl("https://www.zaviagent.com/invite/beta?key=s3cret")).toBe(
      "https://www.zaviagent.com/invite/beta",
    );
    expect(analyticsUrl("https://www.zaviagent.com/auth/callback?code=abc")).toBe(
      "https://www.zaviagent.com/auth",
    );
  });

  it("returns empty for a blank or broken value", () => {
    expect(analyticsUrl("")).toBe("");
    expect(analyticsUrl("not a url")).toBe("");
  });
});

describe("analyticsPath", () => {
  it("collapses token-carrying paths", () => {
    expect(analyticsPath("/reset-password/tok123")).toBe("/reset-password");
    expect(analyticsPath("/pricing")).toBe("/pricing");
  });
});

describe("scrubUrlProps", () => {
  it("scrubs the URL properties an SDK adds and leaves ours alone", () => {
    expect(
      scrubUrlProps({
        $current_url: "https://www.zaviagent.com/invite/accept?id=123",
        $pathname: "/reset-password/tok",
        $referrer: "$direct",
        page_type: "invite",
      }),
    ).toEqual({
      $current_url: "https://www.zaviagent.com/invite/accept",
      $pathname: "/reset-password",
      $referrer: "$direct",
      page_type: "invite",
    });
  });

  it("passes undefined through", () => {
    expect(scrubUrlProps(undefined)).toBeUndefined();
  });
});
