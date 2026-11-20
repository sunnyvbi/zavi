// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body: unknown }>,
  reply: { status: 200, body: {} as unknown },
}));

vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts: { body?: string } = {}) => {
    net.calls.push({ path, body: opts.body ? JSON.parse(opts.body) : undefined });
    return {
      ok: net.reply.status >= 200 && net.reply.status < 300,
      status: net.reply.status,
      json: async () => net.reply.body,
    };
  },
}));

vi.mock("./useBuildSessions", () => ({ notifyBuildSessionsChanged: () => {} }));

import { BUILD_CHANGE_BUSY_MESSAGE, BUILD_REFINE_STARTED_EVENT, startBuildRefine } from "./useBuildSession";

const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";

afterEach(() => {
  net.calls.length = 0;
  net.reply = { status: 200, body: {} };
});

describe("startBuildRefine", () => {
  it("refines the open build session and tells its transcript to refresh", async () => {
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(BUILD_REFINE_STARTED_EVENT, listener);
    const error = await startBuildRefine(SESSION, "add a pricing section");
    window.removeEventListener(BUILD_REFINE_STARTED_EVENT, listener);

    expect(error).toBeNull();
    expect(net.calls).toEqual([
      {
        path: "/api/workspace/autopilot/refine-product",
        body: { message: "add a pricing section", conductor_run_id: SESSION },
      },
    ]);
    expect(seen).toEqual([{ sessionId: SESSION }]);
  });

  it("carries a picked element on a change, never on a retry", async () => {
    const selection = { selector: "main > h1", tag: "h1", text: "Rent bikes", path: "/" };
    await startBuildRefine(SESSION, "bigger", { selection });
    await startBuildRefine(SESSION, "x", { retryOf: "dcee9f28-0000-4000-8000-000000000000", selection });
    expect(net.calls[0]!.body).toEqual({ message: "bigger", conductor_run_id: SESSION, selection });
    expect(net.calls[1]!.body).not.toHaveProperty("selection");
  });

  it("returns the server's reason and announces nothing when the update is refused", async () => {
    net.reply = { status: 409, body: { error: { message: "Your app is still building." } } };
    const listener = vi.fn();
    window.addEventListener(BUILD_REFINE_STARTED_EVENT, listener);
    const error = await startBuildRefine(SESSION, "add a pricing section");
    window.removeEventListener(BUILD_REFINE_STARTED_EVENT, listener);
    expect(error).toBe("Your app is still building.");
    expect(listener).not.toHaveBeenCalled();
  });

  it("retries by id, sending no text, so the original request is rerun as it was", async () => {
    await startBuildRefine(SESSION, "The operator says…", { retryOf: "dcee9f28-0000-4000-8000-000000000000" });
    expect(net.calls[0]).toEqual({
      path: "/api/workspace/autopilot/refine-product",
      body: { retry_of: "dcee9f28-0000-4000-8000-000000000000", conductor_run_id: SESSION },
    });
  });

  it("treats a retry the server says already exists as started: no error, and the transcript refetches", async () => {
    net.reply = { status: 409, body: { error: { code: "refine_already_retried", message: "Already retrying." } } };
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(BUILD_REFINE_STARTED_EVENT, listener);
    const error = await startBuildRefine(SESSION, "x", { retryOf: "dcee9f28-0000-4000-8000-000000000000" });
    window.removeEventListener(BUILD_REFINE_STARTED_EVENT, listener);
    expect(error).toBeNull();
    expect(seen).toEqual([{ sessionId: SESSION }]);
  });

  it("still reports a retry that belongs to a different build", async () => {
    net.reply = {
      status: 409,
      body: { error: { code: "retry_session_mismatch", message: "That change belongs to a different build." } },
    };
    const error = await startBuildRefine(SESSION, "x", { retryOf: "dcee9f28-0000-4000-8000-000000000000" });
    expect(error).toBe("That change belongs to a different build.");
  });

  it("still reports a different 409 on a retry, such as another change already running", async () => {
    net.reply = { status: 409, body: { error: { code: "build_already_in_progress", message: "Another change is running." } } };
    const listener = vi.fn();
    window.addEventListener(BUILD_REFINE_STARTED_EVENT, listener);
    const error = await startBuildRefine(SESSION, "x", { retryOf: "dcee9f28-0000-4000-8000-000000000000" });
    window.removeEventListener(BUILD_REFINE_STARTED_EVENT, listener);
    expect(error).toBe(BUILD_CHANGE_BUSY_MESSAGE);
    expect(listener).not.toHaveBeenCalled();
  });
});
