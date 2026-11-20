
import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { approveDecision } from "./approveDecision";

const ID = "20000000-0000-4000-8000-000000000099";

function res(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() {
      return this;
    },
  } as unknown as Response;
}

const shipRed409 = () =>
  res(409, { error: { code: "requires_ship_red_override", message: "confirm" } });

function bodyOf(call: unknown[]): Record<string, unknown> | null {
  const init = call[1] as RequestInit | undefined;
  return init?.body ? JSON.parse(String(init.body)) : null;
}

beforeEach(() => apiFetch.mockReset());

describe("approveDecision", () => {
  it("plain approve → one bodyless POST, no confirm", async () => {
    apiFetch.mockResolvedValueOnce(res(200, { ok: true }));
    const confirm = vi.fn(() => true);

    const r = await approveDecision(ID, {}, confirm);

    expect(r?.status).toBe(200);
    expect(confirm).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe(`/api/approvals/${ID}/approve`);
    expect(bodyOf(apiFetch.mock.calls[0])).toBeNull();
  });

  it("ship_red 409 + operator confirms → retries with ship_anyway:true", async () => {
    apiFetch.mockResolvedValueOnce(shipRed409());
    apiFetch.mockResolvedValueOnce(res(200, { ok: true }));
    const confirm = vi.fn(() => true);

    const r = await approveDecision(ID, {}, confirm);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(apiFetch.mock.calls[1])).toEqual({ ship_anyway: true });
    expect(r?.status).toBe(200);
  });

  it("ship_red 409 + operator declines → null, and NO ship_anyway is sent", async () => {
    apiFetch.mockResolvedValueOnce(shipRed409());
    const confirm = vi.fn(() => false);

    const r = await approveDecision(ID, {}, confirm);

    expect(r).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("carries always_allow through the ship-red retry", async () => {
    apiFetch.mockResolvedValueOnce(shipRed409());
    apiFetch.mockResolvedValueOnce(res(200, { ok: true, allowlisted: true }));

    await approveDecision(ID, { always_allow: true }, () => true);

    expect(bodyOf(apiFetch.mock.calls[0])).toEqual({ always_allow: true });
    expect(bodyOf(apiFetch.mock.calls[1])).toEqual({
      always_allow: true,
      ship_anyway: true,
    });
  });

  it("carries scheduled_at (social approve-at-time) — ISO and an explicit null both travel", async () => {
    apiFetch.mockResolvedValueOnce(res(200, { ok: true }));
    await approveDecision(ID, { scheduled_at: "2099-01-02T09:00:00.000Z" }, () => true);
    expect(bodyOf(apiFetch.mock.calls[0])).toEqual({ scheduled_at: "2099-01-02T09:00:00.000Z" });

    apiFetch.mockResolvedValueOnce(res(200, { ok: true }));
    await approveDecision(ID, { scheduled_at: null }, () => true);
    expect(bodyOf(apiFetch.mock.calls[1])).toEqual({ scheduled_at: null });
  });

  it("a NON-ship_red 409 surfaces untouched — never prompts to ship anyway", async () => {
    apiFetch.mockResolvedValueOnce(res(409, { error: { code: "some_other_conflict" } }));
    const confirm = vi.fn(() => true);

    const r = await approveDecision(ID, {}, confirm);

    expect(confirm).not.toHaveBeenCalled();
    expect(r?.status).toBe(409);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("non-409 failures pass straight through", async () => {
    apiFetch.mockResolvedValueOnce(res(403, { error: { code: "not_authorized" } }));
    const confirm = vi.fn(() => true);

    const r = await approveDecision(ID, {}, confirm);

    expect(confirm).not.toHaveBeenCalled();
    expect(r?.status).toBe(403);
  });
});

describe("approveDecision — payload edits", () => {
  it("sends payload_text and thread when given", async () => {
    apiFetch.mockResolvedValueOnce(res(200, { ok: true }));
    await approveDecision(ID, { payload_text: "better", thread: ["two"] });
    expect(bodyOf(apiFetch.mock.calls[0])).toEqual({ payload_text: "better", thread: ["two"] });
  });
});

describe("approveDecision — Composio card seal", () => {
  it("sends expected_fingerprint in the approve body", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce(res(200));
    const fp = "d".repeat(64);
    await approveDecision(ID, { expected_fingerprint: fp }, () => false);
    const init = apiFetch.mock.calls[0][1] as { body?: string };
    expect(JSON.parse(String(init.body))).toEqual({ expected_fingerprint: fp });
  });
});

describe("approveDecision on a Pinterest pin Zavi could not fully check", () => {
  const unverified409 = () =>
    res(409, { error: { code: "requires_unverified_confirm", message: "Zavi could not check everything on this pin. The site blocked the check." } });

  it("asks once with the reasons, then re-posts with confirm_unverified", async () => {
    apiFetch.mockResolvedValueOnce(unverified409());
    apiFetch.mockResolvedValueOnce(res(200, { ok: true }));
    const confirm = vi.fn((_message: string) => true);

    const r = await approveDecision(ID, {}, confirm);

    expect(confirm.mock.calls[0][0]).toContain("The site blocked the check.");
    expect(bodyOf(apiFetch.mock.calls[1])).toEqual({ confirm_unverified: true });
    expect(r?.status).toBe(200);
  });

  it("declined: nothing is re-posted", async () => {
    apiFetch.mockResolvedValueOnce(unverified409());
    const r = await approveDecision(ID, {}, vi.fn(() => false));
    expect(r).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("a caller with its own Post anyway panel gets the 409 back untouched", async () => {
    apiFetch.mockResolvedValueOnce(unverified409());
    const confirm = vi.fn(() => true);
    const r = await approveDecision(ID, {}, confirm, { ownUnverifiedConfirm: true });
    expect(r?.status).toBe(409);
    expect(confirm).not.toHaveBeenCalled();
  });
});
