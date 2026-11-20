
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("../creds", () => ({
  getPipedreamCreds: () => ({ projectId: "proj_1", environment: "production" }),
  PIPEDREAM_API_BASE_URL: "https://api.pipedream.com/v1",
  PIPEDREAM_MCP_BASE_URL: "https://remote.mcp.pipedream.net/v3",
}));
vi.mock("../token-provider", () => ({ getPipedreamAccessToken: async () => "tok" }));
vi.mock("@/services/mcp/streamable-guards", () => ({ assertStreamableUrlAllowed: () => undefined }));

import { listApps } from "../api";

function respond(body: unknown): void {
  mocks.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
}

function requestedUrl(): URL {
  return new URL(String(mocks.fetch.mock.calls[0]?.[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("listApps — vendor null tolerance", () => {
  it("keeps an app whose auth_type is null (the live page-2 row that 502'd the page)", async () => {
    respond({
      data: [
        { name_slug: "airweave", name: "Airweave", auth_type: null, img_src: null },
        { name_slug: "ascora", name: "Ascora", auth_type: "oauth", img_src: "https://x/y.png" },
      ],
      page_info: { end_cursor: "cur_2" },
    });

    const { apps, next_cursor } = await listApps({ limit: 100 });

    expect(apps).toEqual([
      {
        slug: "airweave",
        name: "Airweave",
        auth_type: null,
        img_src: null,
        needs_setup: false,
        description: null,
        categories: [],
      },
      {
        slug: "ascora",
        name: "Ascora",
        auth_type: "oauth",
        img_src: "https://x/y.png",
        needs_setup: false,
        description: null,
        categories: [],
      },
    ]);
    expect(next_cursor).toBe("cur_2");
  });

  it("tolerates a null name / null end_cursor", async () => {
    respond({ data: [{ name_slug: "acme", name: null }], page_info: { end_cursor: null } });
    const { apps, next_cursor } = await listApps({});
    expect(apps[0]).toMatchObject({ slug: "acme", name: "acme" });
    expect(next_cursor).toBeNull();
  });

  it("drops ONLY the unparseable row, not the whole page", async () => {
    respond({
      data: [
        { name_slug: "good_one" },
        { name: "no slug at all" },
        { name_slug: "good_two" },
      ],
    });
    const { apps } = await listApps({});
    expect(apps.map((a) => a.slug)).toEqual(["good_one", "good_two"]);
  });

  it("still flags custom-OAuth apps as needs_setup", async () => {
    respond({ data: [{ name_slug: "byo", auth_type: "custom_oauth" }] });
    const { apps } = await listApps({});
    expect(apps[0]!.needs_setup).toBe(true);
  });
});

describe("listApps — paging params", () => {
  it("sends q, after (cursor) and limit", async () => {
    respond({ data: [] });
    await listApps({ q: "notion", cursor: "cur_1", limit: 100 });
    const url = requestedUrl();
    expect(url.searchParams.get("q")).toBe("notion");
    expect(url.searchParams.get("after")).toBe("cur_1");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("clamps limit to the vendor's 100 cap", async () => {
    respond({ data: [] });
    await listApps({ limit: 5000 });
    expect(requestedUrl().searchParams.get("limit")).toBe("100");
  });

  it("omits limit entirely when not asked for (vendor default page)", async () => {
    respond({ data: [] });
    await listApps({});
    expect(requestedUrl().searchParams.has("limit")).toBe(false);
  });
});
