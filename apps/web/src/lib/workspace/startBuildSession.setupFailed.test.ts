
import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { startBuildSession } from "./useBuildSession";

function res(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body });
}

beforeEach(() => apiFetch.mockReset());

describe("startBuildSession — a failed site setup", () => {
  it("opens the failed run when the server names it", async () => {
    apiFetch.mockReturnValueOnce(res(503, { error: { code: "build_setup_failed", message: "Try again", retryable: true, run_id: "run-9" } }));
    expect(await startBuildSession({ idea: "a bakery", companyName: "Shop" })).toEqual({ id: "run-9" });
  });

  it("without a run (refused before the slot) it is an ordinary error with the server's message", async () => {
    apiFetch.mockReturnValueOnce(res(503, { error: { code: "build_setup_failed", message: "Try again in a few minutes.", retryable: true } }));
    expect(await startBuildSession({ idea: "a bakery", companyName: "Shop" })).toEqual({ error: "Try again in a few minutes." });
  });
});

it("retries a dropped response with the same request ID and opens the original build", async () => {
  apiFetch.mockRejectedValueOnce(new Error("Network lost"));
  apiFetch.mockReturnValueOnce(res(200, { conductor_run_id: "original" }));
  expect(await startBuildSession({ idea: "a bakery", companyName: "Shop" })).toEqual({ id: "original" });
  const requests = apiFetch.mock.calls.filter(([url]) => url === "/api/workspace/autopilot/build-product").map(([, init]) => init.headers);
  expect(requests).toHaveLength(2);
  expect(requests[0]["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[1]["Idempotency-Key"]).toBe(requests[0]["Idempotency-Key"]);
});

it("keeps the request key while the original start is still processing", async () => {
  const pending = { ok: false, status: 409, json: async () => ({ error: { code: "idempotency_in_progress" } }),
    clone() { return this; } };
  apiFetch.mockResolvedValueOnce(pending);
  apiFetch.mockReturnValueOnce(res(200, { conductor_run_id: "original" }));
  expect(await startBuildSession({ idea: "another bakery", companyName: "Shop" })).toEqual({ id: "original" });
  const calls = apiFetch.mock.calls.filter(([url]) => url === "/api/workspace/autopilot/build-product");
  expect(calls[0][1].headers).toEqual(calls[1][1].headers);
});

it("a manual retry after two lost responses keeps the unresolved key", async () => {
  apiFetch.mockRejectedValueOnce(new Error("lost"));
  apiFetch.mockRejectedValueOnce(new Error("lost again"));
  expect(await startBuildSession({ idea: "a new shop", companyName: "Shop" })).toEqual({ error: "lost again" });
  apiFetch.mockReturnValueOnce(res(200, { conductor_run_id: "original" }));
  expect(await startBuildSession({ idea: "a new shop", companyName: "Shop" })).toEqual({ id: "original" });
  const calls = apiFetch.mock.calls.filter(([url]) => url === "/api/workspace/autopilot/build-product");
  expect(calls).toHaveLength(3);
  expect(calls[2][1].headers).toEqual(calls[0][1].headers);
});

it("replays when the success headers arrive but the response body is dropped", async () => {
  apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error("body lost"); } });
  apiFetch.mockReturnValueOnce(res(200, { conductor_run_id: "original" }));
  expect(await startBuildSession({ idea: "a shop with a menu", companyName: "Shop" })).toEqual({ id: "original" });
  const calls = apiFetch.mock.calls.filter(([url]) => url === "/api/workspace/autopilot/build-product");
  expect(calls[1][1].headers).toEqual(calls[0][1].headers);
});

it("KEEPS the key after a stale claim: the retry asks about the same build, never starts a second", async () => {
  const input = { idea: "a shop after a server restart", companyName: "Shop" };
  apiFetch.mockReturnValueOnce(res(409, { error: { code: "idempotency_stale", message: "Check before trying again." } }));
  expect(await startBuildSession(input)).toEqual({ error: "Check before trying again." });

  apiFetch.mockReturnValueOnce(res(200, { conductor_run_id: "original" }));
  expect(await startBuildSession(input)).toEqual({ id: "original" });
  const calls = apiFetch.mock.calls.filter(([url]) => url === "/api/workspace/autopilot/build-product");
  expect(calls).toHaveLength(2);
  expect(calls[1][1].headers["Idempotency-Key"]).toBe(calls[0][1].headers["Idempotency-Key"]);
});

it("a definitive answer drops the key: the next press of the same idea is a new intent", async () => {
  const input = { idea: "a shop that was refused", companyName: "Shop" };
  apiFetch.mockReturnValueOnce(res(429, { error: { code: "daily_build_limit_reached", message: "Limit." } }));
  await startBuildSession(input);
  apiFetch.mockReturnValueOnce(res(200, { conductor_run_id: "next" }));
  await startBuildSession(input);
  const calls = apiFetch.mock.calls.filter(([url]) => url === "/api/workspace/autopilot/build-product");
  expect(calls[1][1].headers["Idempotency-Key"]).not.toBe(calls[0][1].headers["Idempotency-Key"]);
});
