
import { describe, it, expect, vi, beforeEach } from "vitest";

let host = "www.zaviagent.com";
vi.mock("next/headers", () => ({
  headers: () => new Headers({ "x-forwarded-host": host }),
}));

vi.mock("@/lib/marketing/liveUpcar", () => ({ getLivePillSlug: async () => null, getLiveUpcar: async () => null }));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

beforeEach(() => {
  host = "www.zaviagent.com";
});

describe("unknown site host", () => {
  it("robots.txt disallows everything and lists no sitemap", async () => {
    host = "deleted-site.zaviagent.com";
    expect(await robots()).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
  });

  it("sitemap.xml is empty", async () => {
    host = "deleted-site.zaviagent.com";
    expect(await sitemap()).toEqual([]);
  });
});

describe("served hosts", () => {
  it("www keeps its own robots + sitemap", async () => {
    const r = await robots();
    expect(r.sitemap).toBe("https://www.zaviagent.com/sitemap.xml");
    expect((await sitemap())[0]?.url).toBe("https://www.zaviagent.com/");
  });

  it("a retired segment host points at www", async () => {
    host = "growth.zaviagent.com";
    expect((await robots()).sitemap).toBe("https://www.zaviagent.com/sitemap.xml");
  });
});
