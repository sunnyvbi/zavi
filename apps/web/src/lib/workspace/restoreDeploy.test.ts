// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
const toastAdd = vi.fn(() => "toast-1");
const toastUpdate = vi.fn();
const toastClose = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  toast: {
    add: (...a: unknown[]) => toastAdd(...(a as [])),
    update: (...a: unknown[]) => toastUpdate(...(a as [])),
    close: (...a: unknown[]) => toastClose(...(a as [])),
  },
}));

import { watchRestoreDeploy, RESTORE_MAX_POLLS, publishCopy, shortVersionTitle } from "./restoreDeploy";

const sleep = async () => {};
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

beforeEach(() => {
  apiFetch.mockReset();
  toastAdd.mockClear();
  toastUpdate.mockClear();
  toastClose.mockClear();
});

describe("watchRestoreDeploy", () => {
  it("shows a loading toast, polls the reverted commit, and only reloads once it is live", async () => {
    const states = ["deploying", "deploying", "live"];
    apiFetch.mockImplementation(async () => json({ state: states.shift() ?? "live" }));
    const onLive = vi.fn();
    const out = await watchRestoreDeploy({ commitSha: "abc1234", title: "Darker hero", onLive, sleep });
    expect(out).toBe("live");
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "loading", title: "Reverting to an earlier version", description: "“Darker hero” is redeploying. This usually takes a couple of minutes." }));
    expect(apiFetch.mock.calls[0][0]).toBe("/api/workspace/autopilot/restore-status?commit_sha=abc1234");
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(onLive).toHaveBeenCalledTimes(1);
    expect(toastUpdate).toHaveBeenCalledWith("toast-1", expect.objectContaining({ type: "success" }));
  });

  it("a failed deploy tells the founder the app kept its previous version and never reloads", async () => {
    apiFetch.mockImplementation(async () => json({ state: "failed" }));
    const onLive = vi.fn();
    expect(await watchRestoreDeploy({ commitSha: "abc1234", title: "X", onLive, sleep })).toBe("failed");
    expect(onLive).not.toHaveBeenCalled();
    expect(toastUpdate).toHaveBeenCalledWith("toast-1", expect.objectContaining({ type: "error" }));
  });

  it("server hiccups count as still deploying, and it gives up honestly after the cap", async () => {
    apiFetch.mockImplementation(async () => {
      throw new Error("network");
    });
    const onLive = vi.fn();
    expect(await watchRestoreDeploy({ commitSha: "abc1234", title: "X", onLive, sleep })).toBe("timeout");
    expect(apiFetch).toHaveBeenCalledTimes(RESTORE_MAX_POLLS);
    expect(onLive).not.toHaveBeenCalled();
    expect(toastUpdate).toHaveBeenCalledWith("toast-1", expect.objectContaining({ type: "info" }));
  });
});

describe("watchRestoreDeploy cancellation", () => {
  it("an abort while a status read is in flight stops polling, skips onLive even though that read says live, and closes the toast", async () => {
    const controller = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    apiFetch.mockImplementation(async (_path: string, init?: RequestInit) => {
      seenSignals.push(init?.signal ?? undefined);
      if (seenSignals.length === 2) controller.abort();
      return json({ state: seenSignals.length === 2 ? "live" : "deploying" });
    });
    const onLive = vi.fn();
    const out = await watchRestoreDeploy({ commitSha: "abc1234", title: "X", onLive, sleep, signal: controller.signal });
    expect(out).toBe("cancelled");
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(seenSignals.every((s) => s === controller.signal)).toBe(true);
    expect(onLive).not.toHaveBeenCalled();
    expect(toastUpdate).not.toHaveBeenCalled();
    expect(toastClose).toHaveBeenCalledWith("toast-1");
  });

  it("an abort during the wait between polls makes no further status read", async () => {
    const controller = new AbortController();
    apiFetch.mockImplementation(async () => json({ state: "deploying" }));
    let waits = 0;
    const abortingSleep = async () => {
      waits += 1;
      if (waits === 3) controller.abort();
    };
    const out = await watchRestoreDeploy({ commitSha: "abc1234", title: "X", onLive: vi.fn(), sleep: abortingSleep, signal: controller.signal });
    expect(out).toBe("cancelled");
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(toastClose).toHaveBeenCalledWith("toast-1");
  });
});

describe("publishCopy", () => {
  it("a failed publish never points at a preview that no longer shows the changes", async () => {
    apiFetch.mockImplementation(async () => json({ state: "failed" }));
    await watchRestoreDeploy({ commitSha: "abc1234", title: "Publish", onLive: vi.fn(), sleep, copy: publishCopy(2) });
    const failed = toastUpdate.mock.calls.find((c) => (c as unknown[])[1] && ((c as unknown[])[1] as { type?: string }).type === "error");
    const description = ((failed as unknown[])[1] as { description: string }).description;
    expect(description).not.toMatch(/preview/i);
    expect(description).toBe(
      "Your live app kept its previous version. Your changes are saved in your app's code and go live with the next successful deploy.",
    );
  });
});

describe("shortVersionTitle", () => {
  it("keeps short names, squashes whitespace, and cuts long chat prompts with an ellipsis", () => {
    expect(shortVersionTitle("Darker hero")).toBe("Darker hero");
    expect(shortVersionTitle("a  b\n c")).toBe("a b c");
    const long = "can you add a store section to list the products like Tvns and other vagus nerve simulators that users can buy";
    const out = shortVersionTitle(long);
    expect(out.length).toBeLessThanOrEqual(56);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("can you add a store section")).toBe(true);
  });
});
