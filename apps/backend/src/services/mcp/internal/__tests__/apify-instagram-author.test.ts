
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callApifyTool } from "../apify";

const TENANT = "00000000-0000-0000-0000-000000000000";

function stubActor(items: unknown[]) {
  vi.stubGlobal("fetch", (async () =>
    new Response(JSON.stringify(items), {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
    })) as typeof fetch);
}

async function posts(args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const r = await callApifyTool(TENANT, "scrape_instagram", args);
  return JSON.parse(r.content).items;
}

describe("scrape_instagram: post author fields", () => {
  let prevToken: string | undefined;
  beforeEach(() => {
    prevToken = process.env.APIFY_TOKEN;
    process.env.APIFY_TOKEN = "test-token";
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = prevToken;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps owner, coauthors and tagged users on a hashtag pull", async () => {
    stubActor([
      {
        type: "Image",
        caption: "Morning routine with @examplebrand",
        url: "https://www.instagram.com/p/xyz/",
        ownerUsername: "some_creator",
        ownerFullName: "Some Creator",
        coauthorProducers: [{ username: "examplebrand" }, { username: "" }, {}],
        taggedUsers: Array.from({ length: 14 }, (_, i) => ({ username: `friend_${i}` })),
      },
    ]);
    const [p] = await posts({ hashtag: "examplebrand", result_type: "posts" });

    expect(p).toMatchObject({
      owner_username: "some_creator",
      owner_full_name: "Some Creator",
      coauthors: ["examplebrand"],
    });
    expect(p.tagged_users).toHaveLength(10);
    expect((p.tagged_users as string[])[0]).toBe("friend_0");
    expect(p).not.toHaveProperty("coauthorProducers");
    expect(p).not.toHaveProperty("taggedUsers");
  });

  it("caps coauthors at 5", async () => {
    stubActor([
      { type: "Image", coauthorProducers: Array.from({ length: 8 }, (_, i) => ({ username: `co_${i}` })) },
    ]);
    const [p] = await posts({ hashtag: "anything", result_type: "posts" });
    expect(p.coauthors).toEqual(["co_0", "co_1", "co_2", "co_3", "co_4"]);
  });

  it("maps a post without author fields to null and empty lists", async () => {
    stubActor([{ type: "Video", caption: "no author data" }]);
    const [p] = await posts({ hashtag: "anything", result_type: "posts" });
    expect(p).toMatchObject({
      owner_username: null,
      owner_full_name: null,
      coauthors: [],
      tagged_users: [],
    });
  });
});
