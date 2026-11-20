
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("../creds", () => ({
  getPipedreamCreds: () => ({ projectId: "proj_1", environment: "production" }),
  PIPEDREAM_API_BASE_URL: "https://api.pipedream.com/v1",
  PIPEDREAM_MCP_BASE_URL: "https://remote.mcp.pipedream.net/v3",
}));
vi.mock("../token-provider", () => ({ getPipedreamAccessToken: async () => "tok" }));
vi.mock("@/services/mcp/streamable-guards", () => ({ assertStreamableUrlAllowed: () => undefined }));

import { appExists, getAppName, listApps } from "../api";

function respond(status: number, body: unknown): void {
  mocks.fetch.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
});

describe("appExists", () => {
  it("is true for a real app, via GET /apps/{slug}", async () => {
    respond(200, { data: { name_slug: "instagram_business", name: "Instagram for Business" } });
    await expect(appExists("instagram_business")).resolves.toBe(true);
    expect(String(mocks.fetch.mock.calls[0]?.[0])).toBe("https://api.pipedream.com/v1/apps/instagram_business");
  });

  it("is false on 404", async () => {
    respond(404, { error: "record not found" });
    await expect(appExists("not_a_real_app")).resolves.toBe(false);
  });

  it("throws on any other failure so the route answers 502, not 'no such app'", async () => {
    respond(500, {});
    await expect(appExists("gmail")).rejects.toThrow(/HTTP 500/);
  });
});

describe("getAppName", () => {
  it("returns the catalog name for a real app", async () => {
    respond(200, { data: { name_slug: "gmail", name: "Gmail" } });
    await expect(getAppName("gmail")).resolves.toBe("Gmail");
  });

  it("returns null on 404", async () => {
    respond(404, { error: "record not found" });
    await expect(getAppName("nope")).resolves.toBeNull();
  });
});

describe("listApps — exact slug the search missed", () => {
  it("puts the directly looked-up app first when the search does not return it", async () => {
    respond(200, { data: [{ name_slug: "bigmailer", name: "BigMailer" }], page_info: {} });
    respond(200, { data: { name_slug: "gmail", name: "Gmail" } });
    const { apps } = await listApps({ q: "Gmail" });
    expect(apps.map((a) => a.slug)).toEqual(["gmail", "bigmailer"]);
    expect(String(mocks.fetch.mock.calls[1]?.[0])).toBe("https://api.pipedream.com/v1/apps/gmail");
  });

  it("does not look up when the search already has the exact slug, or on a later page", async () => {
    respond(200, { data: [{ name_slug: "gmail", name: "Gmail" }], page_info: {} });
    await listApps({ q: "gmail" });
    respond(200, { data: [], page_info: {} });
    await listApps({ q: "gmail", cursor: "c2" });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the search page when the direct lookup fails", async () => {
    respond(200, { data: [{ name_slug: "bigmailer", name: "BigMailer" }], page_info: {} });
    respond(500, {});
    const { apps } = await listApps({ q: "gmail" });
    expect(apps.map((a) => a.slug)).toEqual(["bigmailer"]);
  });
});

describe("getApp — existence rests on name_slug", () => {
  it("still finds the app when an optional field has an odd shape", async () => {
    respond(200, { data: { name_slug: "gmail", name: "Gmail", categories: "not-an-array" } });
    await expect(appExists("gmail")).resolves.toBe(true);
  });
});
