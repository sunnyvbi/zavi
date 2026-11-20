
import { createHash } from "crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  inngestDrainMiddleware,
  quiesce,
  isQuiesced,
  __resetQuiesceForTest,
} from "@/services/agents/inngest-drain";
import { internalQuiesce, internalUnquiesce } from "@/routes/internal/quiesce";

const h = (id: string) => createHash("sha1").update(id).digest("hex");

function makeRes() {
  const res: Record<string, unknown> = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined as unknown,
  };
  res.setHeader = (k: string, v: string) => {
    (res.headers as Record<string, string>)[k] = v;
  };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
}

beforeEach(() => __resetQuiesceForTest());

describe("inngestDrainMiddleware", () => {
  it("passes POST through when not quiesced", () => {
    const next = vi.fn();
    const res = makeRes();
    inngestDrainMiddleware({ method: "POST" } as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it("503s NEW POST invocations while quiesced, with Retry-After", () => {
    quiesce();
    const next = vi.fn();
    const res = makeRes();
    inngestDrainMiddleware({ method: "POST" } as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect((res.headers as Record<string, string>)["Retry-After"]).toBe("30");
  });

  it("admits the next step of an in-flight run (non-empty stack) while quiesced", () => {
    quiesce();
    const next = vi.fn();
    const res = makeRes();
    inngestDrainMiddleware(
      {
        method: "POST",
        body: { steps: {}, ctx: { stack: { stack: [h("claim"), h("load-context"), h("dispatch")] } } },
      } as never,
      res as never,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it("admits a large-state continuation (use_api, steps emptied, stack kept) while quiesced", () => {
    quiesce();
    const next = vi.fn();
    inngestDrainMiddleware(
      { method: "POST", body: { steps: {}, ctx: { use_api: true, stack: { stack: [h("claim"), h("dispatch")] } } } } as never,
      makeRes() as never,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("still 503s a continuation that has not run dispatch yet while quiesced", () => {
    quiesce();
    const next = vi.fn();
    const res = makeRes();
    inngestDrainMiddleware(
      {
        method: "POST",
        body: { steps: { [h("claim")]: {} }, ctx: { stack: { stack: [h("claim"), h("load-context")] } } },
      } as never,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it("still 503s a fresh large-event invocation (use_api, empty history) while quiesced", () => {
    quiesce();
    const next = vi.fn();
    const res = makeRes();
    inngestDrainMiddleware(
      { method: "POST", body: { steps: {}, ctx: { use_api: true, stack: { stack: [] } } } } as never,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it("still 503s a fresh invocation (empty history) while quiesced", () => {
    quiesce();
    const next = vi.fn();
    const res = makeRes();
    inngestDrainMiddleware(
      { method: "POST", body: { steps: {}, ctx: { attempt: 0, stack: { stack: [] } } } } as never,
      res as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it("GET/PUT (introspection/registration) pass even while quiesced", () => {
    quiesce();
    for (const method of ["GET", "PUT"]) {
      const next = vi.fn();
      inngestDrainMiddleware({ method } as never, makeRes() as never, next);
      expect(next).toHaveBeenCalledOnce();
    }
  });
});

describe("POST /internal/quiesce handler", () => {
  it("flips the flag and is idempotent", () => {
    expect(isQuiesced()).toBe(false);
    const res1 = makeRes();
    internalQuiesce({} as never, res1 as never);
    expect(isQuiesced()).toBe(true);
    expect(res1.statusCode).toBe(200);
    expect((res1.body as Record<string, unknown>).already).toBe(false);

    const res2 = makeRes();
    internalQuiesce({} as never, res2 as never);
    expect(isQuiesced()).toBe(true);
    expect((res2.body as Record<string, unknown>).already).toBe(true);
  });
});

describe("POST /internal/unquiesce handler (deploy abort path)", () => {
  it("re-opens admission after a quiesce, and new invocations pass again", () => {
    quiesce();
    const res = makeRes();
    internalUnquiesce({} as never, res as never);
    expect(isQuiesced()).toBe(false);
    expect(res.statusCode).toBe(200);
    expect((res.body as Record<string, unknown>).was).toBe(true);

    const next = vi.fn();
    inngestDrainMiddleware({ method: "POST" } as never, makeRes() as never, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("is idempotent when not quiesced", () => {
    const res = makeRes();
    internalUnquiesce({} as never, res as never);
    expect(isQuiesced()).toBe(false);
    expect((res.body as Record<string, unknown>).was).toBe(false);
  });
});
