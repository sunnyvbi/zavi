import { describe, it, expect, vi, beforeEach } from "vitest";
const H = vi.hoisted(() => ({ out: "removed" as string, calls: [] as string[], reset: 0 }));
vi.mock("@/services/start-card/seed/notice-store", () => ({
  unsubscribeByKey: vi.fn(async (k: string) => (H.calls.push(k), H.out)),
}));
vi.mock("@/services/start-card/leaderboard", () => ({ resetLeaderboardCache: () => void H.reset++ }));
import { seedNoticeUnsubscribe, seedNoticeUnsubscribePage } from "../seed-notice";

function res() {
  const r: Record<string, unknown> & { statusCode?: number; body?: string } = {};
  r.set = () => r;
  r.type = () => r;
  r.status = (c: number) => ((r.statusCode = c), r);
  r.send = (b: string) => ((r.body = b), r);
  return r as never as { statusCode: number; body: string };
}
const KEY = "seed-notice-0f0e3a3c-1d2b-4a5e-8f9a-0b1c2d3e4f50";

describe("seed notice one-click unsubscribe", () => {
  beforeEach(() => {
    H.out = "removed";
    H.calls = [];
    H.reset = 0;
  });
  it("GET only shows one button and removes nothing (mail scanners follow links)", async () => {
    const r = res();
    await seedNoticeUnsubscribePage({ query: { k: KEY } } as never, r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`method="post" action="/api/public/seed-notice/unsubscribe?k=${KEY}"`);
    expect(H.calls).toEqual([]);
  });
  it("POST (the RFC 8058 one-click body or the button) removes the site and clears the board cache", async () => {
    const r = res();
    await seedNoticeUnsubscribe({ query: { k: KEY }, body: { "List-Unsubscribe": "One-Click" } } as never, r as never);
    expect(r.statusCode).toBe(200);
    expect(H.calls).toEqual([KEY]);
    expect(H.reset).toBe(1);
  });
  it("a malformed or unknown key removes nothing and never echoes the input", async () => {
    const bad = res();
    await seedNoticeUnsubscribe({ query: { k: '"><script>x</script>' } } as never, bad as never);
    expect(bad.statusCode).toBe(404);
    expect(bad.body).not.toContain("<script>");
    expect(H.calls).toEqual([]);
    H.out = "unknown";
    const unk = res();
    await seedNoticeUnsubscribe({ query: { k: KEY } } as never, unk as never);
    expect(unk.statusCode).toBe(404);
  });
});
