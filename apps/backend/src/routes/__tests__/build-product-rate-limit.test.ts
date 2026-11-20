
import express from "express";
import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function makeBuildProductLimiter() {
  return rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req: Request) => {
      const auth = req.headers.authorization;
      if (auth && auth.length > 16) {
        return "b:" + auth.slice(7, 39);
      }
      return "ip:" + (req.ip ?? "unknown");
    },
    handler: (_req: Request, res: Response) =>
      res.status(429).json({
        error: { code: "rate_limited", message: "5 builds/min. Slow down" },
      }),
  });
}

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  const limiter = makeBuildProductLimiter();

  app.post("/fail401", limiter, (_req, res) => {
    res.status(401).json({ error: { code: "unauthorized" } });
  });

  app.post("/ok200", limiter, (_req, res) => {
    res.status(200).json({ ok: true });
  });

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("buildProductLimiter — skipFailedRequests:true contract", () => {
  it("does NOT 429 after 10 sequential 401 responses (bucket is not consumed by failed requests)", async () => {
    const headers = {
      authorization: "Bearer " + "x".repeat(50),
      "content-type": "application/json",
    };
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${baseUrl}/fail401`, {
        method: "POST",
        headers,
        body: "{}",
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual(Array(10).fill(401));
    expect(statuses).not.toContain(429);
  });

  it("does NOT 429 after 10 sequential 401s from an UNAUTH'd caller (the original w43 attack — same egress IP, no bearer)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${baseUrl}/fail401`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual(Array(10).fill(401));
    expect(statuses).not.toContain(429);
  });
});

describe("buildProductLimiter — 5/min cap STILL fires on successful requests", () => {
  it("returns 200 for the first 5 successful requests and 429 for the 6th (cap intact for happy path)", async () => {
    const headers = {
      authorization: "Bearer " + "y".repeat(50),
      "content-type": "application/json",
    };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${baseUrl}/ok200`, {
        method: "POST",
        headers,
        body: "{}",
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  it("isolates buckets per bearer — one bearer's 6th 429 does NOT fence another bearer's first request", async () => {
    const headersA = {
      authorization: "Bearer " + "a".repeat(50),
      "content-type": "application/json",
    };
    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/ok200`, { method: "POST", headers: headersA, body: "{}" });
    }
    const aFenced = await fetch(`${baseUrl}/ok200`, {
      method: "POST",
      headers: headersA,
      body: "{}",
    });
    expect(aFenced.status).toBe(429);

    const headersB = {
      authorization: "Bearer " + "b".repeat(50),
      "content-type": "application/json",
    };
    const bFirst = await fetch(`${baseUrl}/ok200`, {
      method: "POST",
      headers: headersB,
      body: "{}",
    });
    expect(bFirst.status).toBe(200);
  });

  it("composes safely: 10 failing requests then 5 successful all 200, the 6th success is the 429 (failed traffic does NOT pre-fill the bucket)", async () => {
    const headers = {
      authorization: "Bearer " + "c".repeat(50),
      "content-type": "application/json",
    };
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${baseUrl}/fail401`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(r.status).toBe(401);
    }
    const okStatuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${baseUrl}/ok200`, {
        method: "POST",
        headers,
        body: "{}",
      });
      okStatuses.push(r.status);
    }
    expect(okStatuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(okStatuses[5]).toBe(429);
  });
});
