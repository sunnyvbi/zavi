
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/tools/slack/_client", () => ({
  slackFetch: vi.fn(),
}));

import { slackFetch } from "@/services/tools/slack/_client";
import { ExpectedToolError } from "@/services/tools/types";
import { slackFetchWithBackoff } from "../_retry";

const mockedFetch = slackFetch as unknown as ReturnType<typeof vi.fn>;
const T1 = "00000000-0000-0000-0000-000000000001";

describe("slackFetchWithBackoff . 429 retry contract", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    vi.useFakeTimers();
  });

  it("retries on a Slack 429 then succeeds on the next attempt", async () => {
    mockedFetch
      .mockRejectedValueOnce(
        new ExpectedToolError(
          "slack_http",
          "Slack API conversations.history returned HTTP 429",
          { status: 429, slack_method: "conversations.history" },
        ),
      )
      .mockResolvedValueOnce({ ok: true, messages: [] });
    const p = slackFetchWithBackoff(T1, "conversations.history", { channel: "C1" }, 3);
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.rate_limit_hits).toBeGreaterThanOrEqual(1);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("handles 429-then-2xx-then-429-then-2xx across two independent calls (each pair = 1 retry)", async () => {
    mockedFetch
      .mockRejectedValueOnce(
        new ExpectedToolError(
          "slack_http",
          "ratelimited",
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce({ ok: true, messages: ["a"] });
    const p1 = slackFetchWithBackoff(T1, "conversations.history", { channel: "C1" }, 3);
    await vi.advanceTimersByTimeAsync(2000);
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(r1.rate_limit_hits).toBe(1);

    mockedFetch
      .mockRejectedValueOnce(
        new ExpectedToolError(
          "slack_http",
          "ratelimited",
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce({ ok: true, messages: ["b"] });
    const p2 = slackFetchWithBackoff(T1, "conversations.history", { channel: "C2" }, 3);
    await vi.advanceTimersByTimeAsync(2000);
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(r2.rate_limit_hits).toBe(1);

    expect(mockedFetch).toHaveBeenCalledTimes(4);
  });

  it("retries a 5xx via ExpectedToolError({status:503}) up to maxRetries → succeeds on third attempt", async () => {
    const transient = new ExpectedToolError(
      "slack_http",
      "Slack API conversations.history returned HTTP 503",
      { status: 503 },
    );
    mockedFetch
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ ok: true, messages: [] });
    const p = slackFetchWithBackoff(T1, "conversations.history", { channel: "C1" }, 3);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.rate_limit_hits).toBe(0);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it("returns immediately (ok=false) on a routine slack_api_error like 'not_in_channel' . no retry", async () => {
    mockedFetch.mockRejectedValueOnce(
      new ExpectedToolError(
        "slack_api_error",
        "Slack API conversations.history not ok: not_in_channel",
        { slack_error: "not_in_channel" },
      ),
    );
    const res = await slackFetchWithBackoff(T1, "conversations.history", { channel: "C1" }, 3);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_in_channel");
    expect(res.rate_limit_hits).toBe(0);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("after exhausting maxRetries on 429 → returns ok=false with error='ratelimited' (helper's contract)", async () => {
    const err = new ExpectedToolError(
      "slack_http",
      "Slack API conversations.history returned HTTP 429",
      { status: 429 },
    );
    mockedFetch
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);
    const p = slackFetchWithBackoff(T1, "conversations.history", { channel: "C1" }, 2);
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("ratelimited");
    expect(res.rate_limit_hits).toBeGreaterThanOrEqual(2);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it("propagates a non-retryable raw throw (programmer fault) up to the caller", async () => {
    const bug = new Error("boom . slackFetch bug");
    mockedFetch.mockRejectedValueOnce(bug);
    await expect(
      slackFetchWithBackoff(T1, "conversations.history", { channel: "C1" }, 3),
    ).rejects.toThrow(/boom/);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});
