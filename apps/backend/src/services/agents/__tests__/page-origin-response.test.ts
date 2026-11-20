import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Response } from "express";

const { stampState } = vi.hoisted(() => ({
  stampState: { calls: [] as Array<Record<string, unknown>>, never: false, order: [] as string[] },
}));

vi.mock("@/services/agents/thread-channel-origin", () => ({
  stampThreadChannelOrigin: vi.fn(async (input: Record<string, unknown>) => {
    stampState.calls.push(input);
    if (stampState.never) await new Promise(() => {});
    stampState.order.push("stamp");
  }),
}));

import {
  holdResponseForPageOrigin,
  PAGE_ORIGIN_STAMP_DEADLINE_MS,
} from "@/services/agents/page-origin-response";

function mockRes() {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    locals: { marker: 1 },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      stampState.order.push("respond");
      this.body = body;
      return this;
    },
  };
  return res;
}

const ctx = { tenantId: "t1", userId: "u1", pageChannel: "chatgpt_ads", agentSlug: "chatgpt_ads", pageChannelActionId: null };
const TID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  stampState.calls = [];
  stampState.never = false;
  stampState.order = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("holdResponseForPageOrigin", () => {
  it("passes every response straight through when no page origin was set", async () => {
    const raw = mockRes();
    const hold = holdResponseForPageOrigin(raw as unknown as Response);
    hold.res.status(202).json({ thread_id: TID });
    expect(raw.statusCode).toBe(202);
    await hold.release();
    expect(stampState.calls).toHaveLength(0);
  });

  it("holds a 2xx until the thread is stamped, then answers", async () => {
    const raw = mockRes();
    const hold = holdResponseForPageOrigin(raw as unknown as Response);
    hold.setOrigin(ctx);
    hold.res.status(200).json({ thread_id: TID, ok: true });
    expect(raw.statusCode).toBeUndefined();
    await hold.release();
    expect(stampState.calls).toEqual([{ ...ctx, threadId: TID }]);
    expect(stampState.order).toEqual(["stamp", "respond"]);
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toEqual({ thread_id: TID, ok: true });
  });

  it("never holds an error response", async () => {
    const raw = mockRes();
    const hold = holdResponseForPageOrigin(raw as unknown as Response);
    hold.setOrigin(ctx);
    hold.res.status(503).json({ error: { code: "x" } });
    expect(raw.statusCode).toBe(503);
    await hold.release();
    expect(stampState.calls).toHaveLength(0);
  });

  it("answers anyway once a stalled stamp passes its deadline", async () => {
    vi.useFakeTimers();
    stampState.never = true;
    const raw = mockRes();
    const hold = holdResponseForPageOrigin(raw as unknown as Response);
    hold.setOrigin(ctx);
    hold.res.status(202).json({ thread_id: TID });
    const done = hold.release();
    await vi.advanceTimersByTimeAsync(PAGE_ORIGIN_STAMP_DEADLINE_MS - 1);
    expect(raw.statusCode).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(raw.statusCode).toBe(202);
  });

  it("other properties read through to the real response", () => {
    const raw = mockRes();
    const hold = holdResponseForPageOrigin(raw as unknown as Response);
    expect((hold.res as unknown as { locals: unknown }).locals).toEqual({ marker: 1 });
  });
});
