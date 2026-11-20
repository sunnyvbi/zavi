import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { CHANNEL_SEEN_MAX_WAIT_MS, markChannelSeen } from "./channelSeen";

const answer = (status: number, headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers) }) as unknown as Response;

beforeEach(() => {
  apiFetch.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("markChannelSeen", () => {
  it("waits the server's Retry-After before the second try, not sooner", async () => {
    apiFetch.mockResolvedValueOnce(answer(503, { "Retry-After": "5" })).mockResolvedValueOnce(answer(204));
    const done = markChannelSeen("email_marketing", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(4999);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe("seen");
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("caps an absurd Retry-After so the ping is not parked for an hour", async () => {
    apiFetch.mockResolvedValueOnce(answer(503, { "Retry-After": "3600" })).mockResolvedValueOnce(answer(204));
    const done = markChannelSeen("email_marketing", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(CHANNEL_SEEN_MAX_WAIT_MS);
    await expect(done).resolves.toBe("seen");
  });

  it("falls back to a short wait when the 503 carries no Retry-After", async () => {
    apiFetch.mockResolvedValueOnce(answer(503)).mockResolvedValueOnce(answer(204));
    const done = markChannelSeen("email_marketing", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(999);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe("seen");
  });

  it("gives up after four 503s", async () => {
    apiFetch.mockResolvedValue(answer(503, { "Retry-After": "0" }));
    const done = markChannelSeen("email_marketing", new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe("gave_up");
    expect(apiFetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry a 401, 403 or 500", async () => {
    for (const status of [401, 403, 500]) {
      apiFetch.mockReset();
      apiFetch.mockResolvedValue(answer(status));
      await expect(markChannelSeen("email_marketing", new AbortController().signal)).resolves.toBe("refused");
      expect(apiFetch).toHaveBeenCalledTimes(1);
    }
  });

  it("stops in the middle of the wait when aborted", async () => {
    apiFetch.mockResolvedValue(answer(503, { "Retry-After": "5" }));
    const ctl = new AbortController();
    const done = markChannelSeen("email_marketing", ctl.signal);
    await vi.advanceTimersByTimeAsync(100);
    ctl.abort();
    await expect(done).resolves.toBe("aborted");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("passes the abort signal to the request", async () => {
    apiFetch.mockResolvedValue(answer(204));
    const ctl = new AbortController();
    await markChannelSeen("email_marketing", ctl.signal);
    expect((apiFetch.mock.calls[0][1] as RequestInit).signal).toBe(ctl.signal);
    expect((apiFetch.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });
});
