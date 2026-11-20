
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: vi.fn(),
}));

import { slackFetch } from "@/services/tools/slack/_client";
import { ExpectedToolError } from "@/services/tools/types";
import {
  slackJoinWithBackoff,
  slackListChannelsPage,
} from "../slack-auto-join";

const mockedFetch = slackFetch as unknown as ReturnType<typeof vi.fn>;

const T1 = "00000000-0000-0000-0000-000000000001";
const T2 = "00000000-0000-0000-0000-000000000002";

describe("slackJoinWithBackoff — Slack-IQ W1 P0 #5 429 retry contract", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    vi.useFakeTimers();
  });

  it("retries on a Slack 429 then succeeds on the next attempt", async () => {
    mockedFetch
      .mockRejectedValueOnce(
        new ExpectedToolError(
          "slack_http",
          "Slack API conversations.join returned HTTP 429",
          { status: 429, slack_method: "conversations.join" },
        ),
      )
      .mockResolvedValueOnce({ ok: true });
    const p = slackJoinWithBackoff(T1, "C1", undefined, 3);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBeUndefined();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch).toHaveBeenNthCalledWith(
      2,
      T1,
      "conversations.join",
      { channel: "C1" },
      undefined,
    );
  });

  it("treats a slack_api_error with /ratelimited/i as rate-limited", async () => {
    mockedFetch
      .mockRejectedValueOnce(
        new ExpectedToolError(
          "slack_api_error",
          "Slack API conversations.join not ok: ratelimited",
        ),
      )
      .mockResolvedValueOnce({ ok: true });
    const p = slackJoinWithBackoff(T1, "C2", undefined, 3);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBeUndefined();
  });

  it("does NOT retry non-429 expected errors — bubbles them up", async () => {
    mockedFetch.mockRejectedValueOnce(
      new ExpectedToolError(
        "slack_api_error",
        "Slack API conversations.join not ok: not_in_channel",
        { slack_error: "not_in_channel" },
      ),
    );
    await expect(slackJoinWithBackoff(T1, "C3", undefined, 3)).rejects.toThrow(
      /not_in_channel/,
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and rethrows as a 'ratelimited' slack_api_error", async () => {
    const err = new ExpectedToolError(
      "slack_http",
      "Slack API conversations.join returned HTTP 429",
      { status: 429 },
    );
    mockedFetch
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);
    const assertion = expect(slackJoinWithBackoff(T1, "C4", undefined, 2)).rejects.toThrow(
      /ratelimited/,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });
});

describe("slackListChannelsPage — cross-tenant isolation (Codex C8)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("calls slackFetch with the SUPPLIED tenant_id, never an event-payload value", async () => {
    mockedFetch.mockResolvedValue({
      channels: [{ id: "C1", name: "x" }],
      response_metadata: { next_cursor: "" },
    });
    await slackListChannelsPage(T1, undefined);
    await slackListChannelsPage(T2, "next");
    const calls = mockedFetch.mock.calls;
    expect(calls[0][0]).toBe(T1);
    expect(calls[1][0]).toBe(T2);
    expect(calls[0][2]).not.toHaveProperty("cursor");
    expect(calls[1][2]).toMatchObject({ cursor: "next" });
  });

  it("sets exclude_archived=true + the public+private types union", async () => {
    mockedFetch.mockResolvedValue({ channels: [] });
    await slackListChannelsPage(T1, undefined);
    expect(mockedFetch).toHaveBeenCalledWith(
      T1,
      "conversations.list",
      expect.objectContaining({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
      }),
      undefined,
    );
  });
});
