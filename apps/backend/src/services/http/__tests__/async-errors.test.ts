import { describe, expect, it } from "vitest";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";

import { forwardAsyncErrors } from "../async-errors";

async function serve(app: express.Express) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  return {
    get: (path: string) => fetch(`http://127.0.0.1:${port}${path}`),
    close: () => new Promise((r) => server.close(r)),
  };
}

function appWithErrorHandler() {
  const app = forwardAsyncErrors(express());
  return {
    app,
    finish: () => {
      app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
        res.status(500).json({ error: { code: "internal", message: err.message } });
      });
    },
  };
}

describe("forwardAsyncErrors", () => {
  it("a rejected async route answers 500 instead of crashing the process", async () => {
    const { app, finish } = appWithErrorHandler();
    app.get("/boom", async () => {
      throw new Error("upstream request timeout");
    });
    finish();
    const s = await serve(app);
    const res = await s.get("/boom");
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toBe("upstream request timeout");
    app.get("/ok", (_req, res) => void res.json({ ok: true }));
    expect((await s.get("/boom")).status).toBe(500);
    await s.close();
  });

  it("a rejection from a later async middleware also reaches the error handler", async () => {
    const { app, finish } = appWithErrorHandler();
    app.use(async () => {
      throw new Error("mw failed");
    });
    finish();
    const s = await serve(app);
    const res = await s.get("/anything");
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toBe("mw failed");
    await s.close();
  });

  it("keeps normal responses, sync throws, and mounted routers working", async () => {
    const { app, finish } = appWithErrorHandler();
    const r = forwardAsyncErrors(Router());
    r.get("/sub", async (_req, res) => void res.json({ from: "router" }));
    r.get("/sub-boom", async () => {
      throw new Error("router boom");
    });
    app.use("/r", r);
    app.get("/plain", (_req, res) => void res.json({ ok: true }));
    app.get("/sync-boom", () => {
      throw new Error("sync boom");
    });
    finish();
    const s = await serve(app);
    expect(await (await s.get("/plain")).json()).toEqual({ ok: true });
    expect(await (await s.get("/r/sub")).json()).toEqual({ from: "router" });
    expect((await s.get("/r/sub-boom")).status).toBe(500);
    expect((await s.get("/sync-boom")).status).toBe(500);
    expect((await s.get("/missing")).status).toBe(404);
    await s.close();
  });
});
