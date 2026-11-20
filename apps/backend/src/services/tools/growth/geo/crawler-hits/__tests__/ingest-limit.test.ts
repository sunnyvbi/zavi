
import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GEO_INGEST_NO_TOKEN_PER_MIN, geoIngestLimiters, tokenBucketKey } from "../ingest-limit";

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const app = express();
  app.post("/ingest", ...geoIngestLimiters(), (_req, res) => {
    res.status(401).json({ error: { code: "unauthenticated" } });
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

const post = (auth?: string) =>
  fetch(`${baseUrl}/ingest`, { method: "POST", headers: auth ? { authorization: auth } : {} });

const tokenA = `Bearer zgeo_${"a".repeat(64)}`;
const tokenB = `Bearer zgeo_${"b".repeat(64)}`;

describe("geo ingest limiters", () => {
  it("keys a well-formed token by its hash, never the token itself", () => {
    const key = tokenBucketKey({ headers: { authorization: tokenA } })!;
    expect(key).toMatch(/^geo-token:[0-9a-f]{32}$/);
    expect(key).not.toContain("aaaa");
    expect(tokenBucketKey({ headers: { authorization: "Bearer nope" } })).toBeNull();
  });

  it("caps callers without a token tightly, and counts rejected requests", async () => {
    for (let i = 0; i < GEO_INGEST_NO_TOKEN_PER_MIN; i++) expect((await post()).status).toBe(401);
    expect((await post()).status).toBe(429);
  });

  it("gives two tokens from the SAME IP separate buckets", async () => {
    for (let i = 0; i < GEO_INGEST_NO_TOKEN_PER_MIN; i++) await post();
    expect((await post()).status).toBe(429);
    expect((await post(tokenA)).status).toBe(401);
    expect((await post(tokenB)).status).toBe(401);
  });
});
