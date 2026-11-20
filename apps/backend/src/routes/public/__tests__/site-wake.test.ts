
import { describe, it, expect } from "vitest";
import {
  createSiteWakeHandler,
  signWake,
  WAKE_SIG_HEADER,
  WAKE_TS_HEADER,
  WAKE_MAX_SKEW_MS,
} from "../site-wake";

const SECRET = "wake-secret-for-tests";
const NOW = Date.parse("2026-09-30T12:00:00Z");
const HOST = "shop-1a2b3c4d-aaaaaa.zaviagent.com";

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

function setup(opts: { secret?: string | undefined; wakeStatus?: string; throws?: boolean } = {}) {
  const woken: string[] = [];
  const handler = createSiteWakeHandler({
    secret: () => ("secret" in opts ? opts.secret : SECRET),
    wake: async (h) => {
      woken.push(h);
      if (opts.throws) throw new Error("tenant 1111 project abc restore failed body={secret}");
      return { status: opts.wakeStatus ?? "waking", done: Promise.resolve() };
    },
    now: () => NOW,
  });
  async function call(body: unknown, headers: Record<string, string>) {
    const res = makeRes();
    await handler({ body, headers } as any, res as any);
    return res;
  }
  return { call, woken };
}

const signed = (host = HOST, tsMs = NOW, secret = SECRET) => {
  const ts = String(Math.floor(tsMs / 1000));
  return { [WAKE_TS_HEADER]: ts, [WAKE_SIG_HEADER]: signWake(secret, host, ts) };
};

describe("site wake route", () => {
  it("a valid signature wakes and returns only {status}", async () => {
    const { call, woken } = setup();
    const res = await call({ hostname: HOST }, signed());
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "waking" });
    expect(woken).toEqual([HOST]);
  });

  it("missing signature is 401 and never wakes", async () => {
    const { call, woken } = setup();
    const res = await call({ hostname: HOST }, {});
    expect(res.statusCode).toBe(401);
    expect(woken).toHaveLength(0);
  });

  it("a signature made with another secret is 401", async () => {
    const { call, woken } = setup();
    const res = await call({ hostname: HOST }, signed(HOST, NOW, "wrong-secret"));
    expect(res.statusCode).toBe(401);
    expect(woken).toHaveLength(0);
  });

  it("a signature for another hostname is 401", async () => {
    const { call, woken } = setup();
    const res = await call({ hostname: "victim.zaviagent.com" }, signed(HOST));
    expect(res.statusCode).toBe(401);
    expect(woken).toHaveLength(0);
  });

  it("a timestamp outside 5 minutes is 401", async () => {
    const { call } = setup();
    expect((await call({ hostname: HOST }, signed(HOST, NOW - WAKE_MAX_SKEW_MS - 2000))).statusCode).toBe(401);
    expect((await call({ hostname: HOST }, signed(HOST, NOW + WAKE_MAX_SKEW_MS + 2000))).statusCode).toBe(401);
  });

  it("a malformed signature header is 401 (no throw)", async () => {
    const { call } = setup();
    const res = await call({ hostname: HOST }, { [WAKE_TS_HEADER]: String(NOW / 1000), [WAKE_SIG_HEADER]: "zz" });
    expect(res.statusCode).toBe(401);
  });

  it("no configured secret fails closed with 503", async () => {
    const { call, woken } = setup({ secret: undefined });
    const res = await call({ hostname: HOST }, signed());
    expect(res.statusCode).toBe(503);
    expect(woken).toHaveLength(0);
  });

  it("an unknown host is 404 {status:'unknown'}", async () => {
    const { call } = setup({ wakeStatus: "unknown" });
    const res = await call({ hostname: HOST }, signed());
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ status: "unknown" });
  });

  it("an internal error never echoes detail", async () => {
    const { call } = setup({ throws: true });
    const res = await call({ hostname: HOST }, signed());
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ status: "error" });
  });
});
