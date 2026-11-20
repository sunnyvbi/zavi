
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: vi.fn(),
}));

import { slackFetch } from "@/services/tools/slack/_client";
import { postMessageTool } from "@/services/tools/slack/post_message";
import { openDmTool } from "@/services/tools/slack/open_dm";

const mockedFetch = slackFetch as unknown as ReturnType<typeof vi.fn>;
const TENANT = "00000000-0000-0000-0000-0000000000aa";
const ctx = { tenant_id: TENANT, slack_team_id: "T1", log: () => {} };

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("slack_post_message — user target auto-opens the DM", () => {
  it("DMs a single user_id: conversations.open then chat.postMessage (the Furqan flow)", async () => {
    mockedFetch
      .mockResolvedValueOnce({ channel: { id: "D123" } })
      .mockResolvedValueOnce({ ts: "1.0", channel: "D123" });

    const out = await postMessageTool.execute(ctx, {
      user_id: "U0BZ07V1RKR",
      text: "Here are the ad-spend findings.",
    });

    expect(mockedFetch).toHaveBeenNthCalledWith(
      1,
      TENANT,
      "conversations.open",
      { users: "U0BZ07V1RKR" },
      "T1",
    );
    expect(mockedFetch).toHaveBeenNthCalledWith(
      2,
      TENANT,
      "chat.postMessage",
      { channel: "D123", text: "Here are the ad-spend findings.", thread_ts: undefined },
      "T1",
    );
    expect(out).toEqual({ ts: "1.0", channel: "D123" });
  });

  it("group-DMs user_ids: conversations.open with comma-joined ids (mpim)", async () => {
    mockedFetch
      .mockResolvedValueOnce({ channel: { id: "G999" } })
      .mockResolvedValueOnce({ ts: "2.0", channel: "G999" });

    await postMessageTool.execute(ctx, {
      user_ids: ["U1", "U2", "U3"],
      text: "team huddle",
    });

    expect(mockedFetch).toHaveBeenNthCalledWith(
      1,
      TENANT,
      "conversations.open",
      { users: "U1,U2,U3" },
      "T1",
    );
  });

  it("posts to a channel_id unchanged — no conversations.open / no name-resolve", async () => {
    mockedFetch.mockResolvedValueOnce({ ts: "3.0", channel: "C0ABCDEF1" });

    await postMessageTool.execute(ctx, { channel_id: "C0ABCDEF1", text: "hi" });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith(
      TENANT,
      "chat.postMessage",
      { channel: "C0ABCDEF1", text: "hi", thread_ts: undefined },
      "T1",
    );
  });

  it("throws slack_dm_open_failed when conversations.open returns no channel", async () => {
    mockedFetch.mockResolvedValueOnce({ channel: {} });
    await expect(
      postMessageTool.execute(ctx, { user_id: "U1", text: "x" }),
    ).rejects.toMatchObject({ code: "slack_dm_open_failed" });
  });

  it("rejects when MORE than one target is given", async () => {
    await expect(
      postMessageTool.execute(ctx, {
        channel_id: "C1",
        user_id: "U1",
        text: "x",
      }),
    ).rejects.toBeTruthy();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("rejects when NO target is given", async () => {
    await expect(
      postMessageTool.execute(ctx, { text: "x" }),
    ).rejects.toBeTruthy();
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("slack_open_dm", () => {
  it("opens a 1:1 DM and returns the channel_id", async () => {
    mockedFetch.mockResolvedValueOnce({ channel: { id: "D7" } });
    const out = await openDmTool.execute(ctx, { user_ids: ["U1"] });
    expect(mockedFetch).toHaveBeenCalledWith(
      TENANT,
      "conversations.open",
      { users: "U1" },
      "T1",
    );
    expect(out).toEqual({ channel_id: "D7", user_ids: ["U1"] });
  });

  it("opens a group DM (mpim) for multiple users", async () => {
    mockedFetch.mockResolvedValueOnce({ channel: { id: "G1" } });
    const out = await openDmTool.execute(ctx, { user_ids: ["U1", "U2"] });
    expect(mockedFetch).toHaveBeenCalledWith(
      TENANT,
      "conversations.open",
      { users: "U1,U2" },
      "T1",
    );
    expect(out).toMatchObject({ channel_id: "G1" });
  });

  it("throws slack_open_dm_failed when no channel comes back", async () => {
    mockedFetch.mockResolvedValueOnce({});
    await expect(
      openDmTool.execute(ctx, { user_ids: ["U1"] }),
    ).rejects.toMatchObject({ code: "slack_open_dm_failed" });
  });
});
