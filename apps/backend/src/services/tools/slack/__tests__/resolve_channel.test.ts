
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: vi.fn() }));

import { slackFetch } from "@/services/tools/slack/_client";
import {
  looksLikeChannelId,
  resolveChannelId,
} from "@/services/tools/slack/_resolve_channel";

const mockedFetch = slackFetch as unknown as ReturnType<typeof vi.fn>;
const TENANT = "00000000-0000-0000-0000-0000000000aa";

beforeEach(() => mockedFetch.mockReset());

describe("looksLikeChannelId", () => {
  it("recognizes real Slack ids (C/G/D + upper-alnum)", () => {
    expect(looksLikeChannelId("C0ABCDEF12")).toBe(true);
    expect(looksLikeChannelId("D0B448H4PKP")).toBe(true);
    expect(looksLikeChannelId("G01ABCDEF9")).toBe(true);
  });
  it("treats names as NOT ids", () => {
    expect(looksLikeChannelId("general")).toBe(false);
    expect(looksLikeChannelId("#marketing")).toBe(false);
    expect(looksLikeChannelId("growth-team")).toBe(false);
  });
  it("treats SHORT uppercase tokens as names, not ids (codex 2026-06-29)", () => {
    expect(looksLikeChannelId("CFO")).toBe(false);
    expect(looksLikeChannelId("GTM")).toBe(false);
    expect(looksLikeChannelId("DEV")).toBe(false);
  });
});

describe("resolveChannelId", () => {
  it("returns an id unchanged (no API call)", async () => {
    const out = await resolveChannelId(TENANT, "C0ABCDEF12", "T1");
    expect(out).toBe("C0ABCDEF12");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("resolves a #name to its id via conversations.list (case-insensitive, strips #)", async () => {
    mockedFetch.mockResolvedValueOnce({
      channels: [
        { id: "C111", name: "random" },
        { id: "C222", name: "marketing" },
      ],
    });
    const out = await resolveChannelId(TENANT, "#Marketing", "T1");
    expect(out).toBe("C222");
    expect(mockedFetch).toHaveBeenCalledWith(
      TENANT,
      "conversations.list",
      expect.objectContaining({ types: "public_channel,private_channel", limit: 1000 }),
      "T1",
    );
  });

  it("paginates up to 3 pages then throws a CLEAR not-found error (never 'paste a channel id')", async () => {
    mockedFetch
      .mockResolvedValueOnce({ channels: [{ id: "C1", name: "a" }], response_metadata: { next_cursor: "c1" } })
      .mockResolvedValueOnce({ channels: [{ id: "C2", name: "b" }], response_metadata: { next_cursor: "c2" } })
      .mockResolvedValueOnce({ channels: [{ id: "C3", name: "c" }], response_metadata: { next_cursor: "c3" } });
    await expect(resolveChannelId(TENANT, "nope", "T1")).rejects.toMatchObject({
      code: "slack_channel_not_found",
    });
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it("stops early when a page has no next_cursor", async () => {
    mockedFetch.mockResolvedValueOnce({ channels: [{ id: "C9", name: "x" }] });
    await expect(resolveChannelId(TENANT, "missing", "T1")).rejects.toMatchObject({
      code: "slack_channel_not_found",
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("resolves an UPPERCASE-typed name (#GENERAL → general's id), case-insensitive", async () => {
    mockedFetch.mockResolvedValueOnce({ channels: [{ id: "C500", name: "general" }] });
    const out = await resolveChannelId(TENANT, "#GENERAL", "T1");
    expect(out).toBe("C500");
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty name", async () => {
    await expect(resolveChannelId(TENANT, "#", "T1")).rejects.toMatchObject({
      code: "slack_channel_invalid",
    });
  });
});
