import { describe, expect, it } from "vitest";
import { stripUrlQuery } from "./url";

describe("stripUrlQuery", () => {
  it("drops the query string — where account ids and tokens live", () => {
    expect(
      stripUrlQuery(
        "https://adsmanager.facebook.com/adsmanager/manage?act=12345&token=sec",
      ),
    ).toBe("https://adsmanager.facebook.com/adsmanager/manage");
  });

  it("drops the fragment", () => {
    expect(stripUrlQuery("https://x.example/a/b#section-2")).toBe(
      "https://x.example/a/b",
    );
  });

  it("drops embedded credentials", () => {
    expect(stripUrlQuery("https://user:pw@x.example/a")).toBe("https://x.example/a");
  });

  it("keeps the path, which is what tells the agent WHICH surface it is", () => {
    expect(stripUrlQuery("https://x.example/campaigns/991/edit")).toBe(
      "https://x.example/campaigns/991/edit",
    );
  });

  it("rejects non-http(s) schemes", () => {
    expect(stripUrlQuery("chrome://settings")).toBeNull();
    expect(stripUrlQuery("file:///Users/me/secret.html")).toBeNull();
    expect(stripUrlQuery("javascript:alert(1)")).toBeNull();
  });

  it("rejects an unparseable value instead of guessing", () => {
    expect(stripUrlQuery("not a url")).toBeNull();
    expect(stripUrlQuery("")).toBeNull();
  });

  it("matches the server helper on a bare origin", () => {
    expect(stripUrlQuery("https://x.example")).toBe("https://x.example/");
  });
});
