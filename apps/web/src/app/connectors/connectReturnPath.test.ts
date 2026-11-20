// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const calls = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string) => {
    calls.urls.push(url);
    return new Response(JSON.stringify({ oauth_url: "https://www.linkedin.com/oauth/v2/authorization?state=s" }), { status: 200 });
  }),
}));

import { CONNECT_RETURN_KEY, startConnectFlow, takeConnectReturn } from "./ConnectButton";
import { linkedin_ads } from "@/components/workspace/actions/platforms/linkedin_ads";
import { justConnectedSlugs } from "@/components/workspace/actions/ChannelDashboard";

let assigned: string[] = [];
beforeEach(() => {
  calls.urls.length = 0;
  assigned = [];
  sessionStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname: "/workspace",
      search: "?tab=channels&channel=linkedin_ads",
      hash: "",
      set href(v: string) { assigned.push(v); },
      get href() { return "http://localhost:3040/workspace?tab=channels&channel=linkedin_ads"; },
    },
  });
});

describe("LinkedIn Ads connect carries the page it started from", () => {
  it("the channel page's Connect sends the channel page as return_to, and the landing on that page clears the session copy", async () => {
    await linkedin_ads.connect!();
    expect(calls.urls).toEqual([
      `/api/connectors/linkedin_ads/start?return_to=${encodeURIComponent("/workspace?tab=channels&channel=linkedin_ads")}`,
    ]);
    expect(assigned).toEqual(["https://www.linkedin.com/oauth/v2/authorization?state=s"]);
    expect(takeConnectReturn("?tab=channels&channel=linkedin_ads&linkedin_ads=connected")).toBeNull();
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("a connector started without asking still carries its page, so a round trip finished in another tab comes back", async () => {
    await startConnectFlow("linear");
    expect(calls.urls).toEqual([`/api/connectors/linear/start?return_to=${encodeURIComponent("/workspace?tab=channels&channel=linkedin_ads")}`]);
  });

  it.each(["slack", "meta_ads", "google_ads", "tiktok"])(
    "%s, whose start route ignores return_to and lands on Settings, still goes back to the page it started from",
    async (slug) => {
      await startConnectFlow(slug);
      expect(takeConnectReturn(`?tab=settings&${slug}=connected`)).toBe(`/workspace?tab=channels&channel=linkedin_ads&${slug}=connected`);
    },
  );

  it("a connect started on Settings drops a stale page an abandoned earlier connect left behind", async () => {
    sessionStorage.setItem(CONNECT_RETURN_KEY, "/workspace?tab=channels&channel=meta_ads");
    (window.location as { search: string }).search = "?tab=settings";
    await startConnectFlow("slack");
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBeNull();
  });

  it("returnHere: false keeps the plain start URL and the session return", async () => {
    await startConnectFlow("linear", { returnHere: false });
    expect(calls.urls).toEqual(["/api/connectors/linear/start"]);
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBe("/workspace?tab=channels&channel=linkedin_ads");
  });

  it("asking from Settings sends no return_to, so the callback keeps its default", async () => {
    (window.location as { search: string }).search = "?tab=settings";
    await startConnectFlow("linkedin_ads", { returnHere: true });
    expect(calls.urls).toEqual(["/api/connectors/linkedin_ads/start"]);
  });
});

describe("justConnectedSlugs", () => {
  it("names the channel's connector only when the landing says it connected", () => {
    expect(justConnectedSlugs("?tab=channels&channel=linkedin_ads&linkedin_ads=connected", ["linkedin_ads"])).toEqual(["linkedin_ads"]);
    expect(justConnectedSlugs("?tab=channels&channel=linkedin_ads", ["linkedin_ads"])).toEqual([]);
    expect(justConnectedSlugs("?tab=channels&channel=linkedin_ads&meta_ads=connected", ["linkedin_ads"])).toEqual([]);
  });
});

describe("a page the server would refuse as return_to falls back to the session return", () => {
  it.each([
    ["an underscore thread segment", "/workspace/thread_1", "?tab=channels&channel=linkedin_ads"],
    ["a path over 512 once normalised", "/workspace", `?tab=channels&channel=linkedin_ads&q=${"é".repeat(200)}`],
    ["a raw path over 512", "/workspace", `?tab=channels&channel=linkedin_ads&q=${"a".repeat(600)}`],
  ])("%s sends no return_to and remembers the page", async (_label, pathname, search) => {
    Object.assign(window.location as object, { pathname, search });
    await startConnectFlow("linkedin_ads", { returnHere: true });
    expect(calls.urls).toEqual(["/api/connectors/linkedin_ads/start"]);
    expect(sessionStorage.getItem(CONNECT_RETURN_KEY)).toBe(pathname + search);
  });

  it("every Connect carries its page by default: Integrations comes back to Integrations, hash included", async () => {
    Object.assign(window.location as object, { pathname: "/workspace", search: "?tab=brain", hash: "#integrations" });
    await startConnectFlow("github");
    expect(calls.urls).toEqual([`/api/connectors/github/start?return_to=${encodeURIComponent("/workspace?tab=brain#integrations")}`]);
  });

  it("a dashed thread id still goes as return_to", async () => {
    Object.assign(window.location as object, { pathname: "/workspace/thread-1", search: "?tab=channels" });
    await startConnectFlow("linkedin_ads", { returnHere: true });
    expect(calls.urls).toEqual([`/api/connectors/linkedin_ads/start?return_to=${encodeURIComponent("/workspace/thread-1?tab=channels")}`]);
  });
});
