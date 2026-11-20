import { describe, it, expect } from "vitest";
import { toolResultCapBytes } from "../smart-truncate";

describe("tool result cap: apify scrape_tiktok", () => {
  it("gives scrape_tiktok room for a full organic window", () => {
    expect(toolResultCapBytes("apify", "scrape_tiktok")).toBe(24 * 1024);
  });
  it("gives the instagram scraper the same budget as tiktok", () => {
    expect(toolResultCapBytes("apify", "scrape_instagram")).toBe(24 * 1024);
  });
});
