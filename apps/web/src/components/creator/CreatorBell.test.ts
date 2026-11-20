import { describe, expect, it } from "vitest";
import { bellCount, type BellFeed } from "./CreatorBell";

const alert = (kind: string) => ({ id: kind, kind, title: kind, body: null, link_path: null, read_at: null, created_at: "2026-09-30" }) as never;

describe("bellCount", () => {
  it("counts each item once: an alert a thread, request or job already shows is not counted again", () => {
    const feed: BellFeed = {
      threads: [],
      requests: [{ id: "r1" }] as never,
      changes: [{ id: "j1", status: "revision_requested" }] as never,
      alerts: [alert("booking_request_received"), alert("revision_requested"), alert("thread_message"), alert("payout_sent")],
    };
    expect(bellCount(feed)).toBe(3);
  });
});
