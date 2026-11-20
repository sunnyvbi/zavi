
import express from "express";
import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function makeMetaDeauthorizeLimiter() {
  return rateLimit({
    windowMs: 15 * 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "too many deauthorize callbacks" },
      }),
  });
}

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const app = express();
  app.post("/deauthorize", makeMetaDeauthorizeLimiter(), (_req, res) => {
    res.status(401).json({ error: { code: "invalid_signed_request" } });
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(): Promise<number> {
  const r = await fetch(`${baseUrl}/deauthorize`, { method: "POST" });
  return r.status;
}

describe("meta deauthorize limiter", () => {
  it("cuts off an unauthenticated 401 flood at the cap, so bad signatures cannot be used for unbounded log writes", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push(await post());

    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect(statuses[61]).toBe(429);
  });

  it("429s without invoking the handler, so a throttled caller costs no log write", async () => {
    let handlerCalls = 0;
    const app = express();
    app.post("/deauthorize", makeMetaDeauthorizeLimiter(), (_req, res) => {
      handlerCalls++;
      res.status(401).json({ error: { code: "invalid_signed_request" } });
    });
    const s = createServer(app);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const addr = s.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const url = `http://127.0.0.1:${addr.port}/deauthorize`;

    for (let i = 0; i < 61; i++) await fetch(url, { method: "POST" });

    expect(handlerCalls).toBe(60);
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });
});
