
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../_client", () => ({
  slackFetch: vi.fn(),
}));

import { slackFetch } from "../_client";
import { listChannelsTool } from "../list_channels";

const mockedFetch = slackFetch as unknown as ReturnType<typeof vi.fn>;

const ctx = {
  tenant_id: "00000000-0000-0000-0000-00000000aaaa",
  log: () => {},
};

describe("listChannelsTool — Slack-IQ W1 P0 #4 surfaces purpose+topic+num_members", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("maps purpose.value + topic.value + num_members onto every channel row", async () => {
    mockedFetch.mockResolvedValueOnce({
      channels: [
        {
          id: "C1",
          name: "general",
          is_member: true,
          is_archived: false,
          purpose: { value: "Team-wide announcements" },
          topic: { value: "Welcome!" },
          num_members: 42,
        },
        {
          id: "C2",
          name: "private-eng",
          is_member: false,
          is_archived: false,
          purpose: { value: "" },
          topic: { value: "" },
          num_members: 7,
        },
      ],
      response_metadata: { next_cursor: "" },
    });

    const out = (await listChannelsTool.execute(ctx, {})) as {
      channels: Array<{
        id: string;
        name: string;
        is_member: boolean;
        is_archived: boolean;
        purpose: string;
        topic: string;
        num_members: number;
      }>;
      next_cursor: string | null;
    };

    expect(out.channels).toHaveLength(2);
    expect(out.channels[0]).toEqual({
      id: "C1",
      name: "general",
      is_member: true,
      is_archived: false,
      purpose: "Team-wide announcements",
      topic: "Welcome!",
      num_members: 42,
    });
    expect(out.channels[1].purpose).toBe("");
    expect(out.channels[1].topic).toBe("");
    expect(out.channels[1].num_members).toBe(7);
  });

  it("defaults purpose/topic to '' and num_members to 0 when missing", async () => {
    mockedFetch.mockResolvedValueOnce({
      channels: [
        { id: "C9", name: "no-meta", is_member: false, is_archived: true },
      ],
    });
    const out = (await listChannelsTool.execute(ctx, {})) as {
      channels: Array<{ purpose: string; topic: string; num_members: number }>;
    };
    expect(out.channels[0].purpose).toBe("");
    expect(out.channels[0].topic).toBe("");
    expect(out.channels[0].num_members).toBe(0);
  });

  it("passes the expected types + limit + exclude_archived to slackFetch", async () => {
    mockedFetch.mockResolvedValueOnce({ channels: [] });
    await listChannelsTool.execute(ctx, { types: "public_channel", limit: 50 });
    expect(mockedFetch).toHaveBeenCalledWith(
      ctx.tenant_id,
      "conversations.list",
      { types: "public_channel", limit: 50, exclude_archived: true },
      undefined,
    );
  });
});
