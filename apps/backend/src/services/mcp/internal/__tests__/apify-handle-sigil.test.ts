
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callApifyTool, bareHandle } from "../apify";

const TENANT = "00000000-0000-0000-0000-000000000000";

function fakeApify(capture: { body?: any }) {
  return (async (_url: string | URL, init?: RequestInit) => {
    capture.body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    });
  }) as typeof fetch;
}

describe("bareHandle", () => {
  it("strips a leading @ or #, and leaves a clean name alone", () => {
    expect(bareHandle("@turo")).toBe("turo");
    expect(bareHandle("#homebaking")).toBe("homebaking");
    expect(bareHandle("turo")).toBe("turo");
  });

  it("trims what a founder actually pastes into a settings box", () => {
    expect(bareHandle("  @turo  ")).toBe("turo");
    expect(bareHandle("@@turo")).toBe("turo");
  });

  it("never eats a character that is legal inside a name", () => {
    expect(bareHandle("acme.co_2")).toBe("acme.co_2");
    expect(bareHandle("@acme.co_2")).toBe("acme.co_2");
    expect(bareHandle("ac@me")).toBe("ac@me");
  });
});

describe("the sigil never reaches the actor", () => {
  let prevToken: string | undefined;
  beforeEach(() => {
    prevToken = process.env.APIFY_TOKEN;
    process.env.APIFY_TOKEN = "test-token";
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = prevToken;
    vi.restoreAllMocks();
  });

  it("instagram: @turo reads the same URL as turo, not %40turo", async () => {
    const at: { body?: any } = {};
    vi.stubGlobal("fetch", fakeApify(at));
    await callApifyTool(TENANT, "scrape_instagram", { username: "@turo", result_type: "details" });

    const bare: { body?: any } = {};
    vi.stubGlobal("fetch", fakeApify(bare));
    await callApifyTool(TENANT, "scrape_instagram", { username: "turo", result_type: "details" });

    expect(at.body.directUrls).toEqual(["https://www.instagram.com/turo/"]);
    expect(at.body.directUrls).toEqual(bare.body.directUrls);
    expect(String(at.body.directUrls[0])).not.toContain("%40");
  });

  it("instagram: #homebaking reads the tag page, not %23homebaking", async () => {
    const cap: { body?: any } = {};
    vi.stubGlobal("fetch", fakeApify(cap));
    await callApifyTool(TENANT, "scrape_instagram", { hashtag: "#homebaking" });

    expect(cap.body.directUrls).toEqual([
      "https://www.instagram.com/explore/tags/homebaking/",
    ]);
    expect(String(cap.body.directUrls[0])).not.toContain("%23");
  });

  it("refuses a value that is nothing but sigils, rather than fetching instagram.com//", async () => {
    vi.stubGlobal("fetch", fakeApify({}));
    const ig = await callApifyTool(TENANT, "scrape_instagram", { username: "@" });
    expect(ig.ok).toBe(false);
    expect(ig.content).toContain("not just a @ or # sign");

    vi.stubGlobal("fetch", fakeApify({}));
    const tt = await callApifyTool(TENANT, "scrape_tiktok", { hashtag: "#" });
    expect(tt.ok).toBe(false);
    expect(tt.content).toContain("not just a @ or # sign");
  });

  it("tiktok: the actor param is the bare name the tool's own description asks for", async () => {
    const user: { body?: any } = {};
    vi.stubGlobal("fetch", fakeApify(user));
    await callApifyTool(TENANT, "scrape_tiktok", { username: "@examplebrand" });
    expect(user.body.profiles).toEqual(["examplebrand"]);

    const tag: { body?: any } = {};
    vi.stubGlobal("fetch", fakeApify(tag));
    await callApifyTool(TENANT, "scrape_tiktok", { hashtag: "#homebaking" });
    expect(tag.body.hashtags).toEqual(["homebaking"]);
  });
});
