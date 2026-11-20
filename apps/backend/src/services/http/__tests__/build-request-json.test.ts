import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_REQUEST_JSON_LIMIT_BYTES, buildRequestJson } from "../build-request-json";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(buildRequestJson());
  app.use(express.json({ limit: "1mb" }));
  app.post("*", (req, res) => {
    res.json({ bytes: String((req.body as { blob?: string }).blob ?? "").length });
  });
  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({});
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const post = (path: string, chars: number) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blob: "a".repeat(chars) }),
  });

describe("build request JSON body limit", () => {
  it("takes a multi-image body on build-start and build-product", async () => {
    for (const path of ["/api/onboarding/build-start", "/api/workspace/autopilot/build-product"]) {
      const res = await post(path, 4 * 1024 * 1024);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ bytes: 4 * 1024 * 1024 });
    }
  });

  it("still refuses a body past its own limit", async () => {
    const res = await post("/api/onboarding/build-start", BUILD_REQUEST_JSON_LIMIT_BYTES + 1024);
    expect(res.status).toBe(413);
  });

  it("leaves every other route on the 1 MB global limit", async () => {
    for (const path of ["/api/workspace/autopilot/refine-product", "/api/onboarding/build-start/extra", "/api/chat/whatever"]) {
      const res = await post(path, 2 * 1024 * 1024);
      expect(res.status).toBe(413);
    }
  });

  it("app.ts mounts it before the global parser, and nginx lets that much through", () => {
    const src = readFileSync(join(process.cwd(), "src/app.ts"), "utf8");
    const mounted = src.indexOf("app.use(buildRequestJson())");
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(src.indexOf('limit: "1mb",\n      verify'));
    const conf = readFileSync(join(process.cwd(), "../../infra/nginx/api.zaviagent.com.conf"), "utf8");
    const serverCap = /client_max_body_size\s+(\d+)M;/.exec(conf.slice(0, conf.search(/^\s*location\s/m)));
    expect(Number(serverCap?.[1]) * 1024 * 1024).toBeGreaterThanOrEqual(BUILD_REQUEST_JSON_LIMIT_BYTES);
  });
});
