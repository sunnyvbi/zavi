import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => {
    throw new Error("the tenant lookup must not run when the sign-in check did not pass");
  },
}));

import { authMiddleware } from "../middleware";
import { _clearTokenCacheForTests, verifyBearer } from "../jwt";

type Mode = "ok" | "hang" | "error503" | "garbage";
let mode: Mode = "ok";
let jwks: unknown;
let server: Server;
let base = "";
let deadPort = 0;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let otherKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
const savedUrl = process.env.SUPABASE_URL;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
  server = createServer((req, res) => {
    if (mode === "hang") return;
    if (mode === "error503") {
      res.writeHead(503).end("upstream timeout");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(mode === "garbage" ? "<html>" : JSON.stringify(jwks));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  process.env.SUPABASE_URL = savedUrl;
});

afterEach(() => {
  _clearTokenCacheForTests();
  mode = "ok";
});

async function token(key = privateKey, issuer = `${base}/auth/v1`) {
  return new SignJWT({ email: "a@b.co" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject("user-1")
    .setIssuer(issuer)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

function res() {
  const r = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(c: number) {
      r.statusCode = c;
      return r;
    },
    json(b: unknown) {
      r.body = b;
      return r;
    },
    setHeader(k: string, v: string) {
      r.headers[k.toLowerCase()] = v;
    },
  };
  return r;
}

async function call(bearer: string) {
  const out = res();
  const next = vi.fn();
  await authMiddleware({ headers: { authorization: `Bearer ${bearer}` } } as never, out as never, next);
  return { out, next };
}

describe("a sign-in check that cannot reach the key server is not a signed-out user", () => {
  it("answers 503 auth_unavailable, not 401, when the key server never answers", async () => {
    process.env.SUPABASE_URL = base;
    const t = await token();
    mode = "hang";
    const { out, next } = await call(t);
    expect(out.statusCode).toBe(503);
    expect((out.body as { error: { code: string } }).error.code).toBe("auth_unavailable");
    expect(out.headers["retry-after"]).toBe("5");
    expect(next).not.toHaveBeenCalled();
  }, 15_000);

  it("answers 503 when the key server itself is down (5xx)", async () => {
    process.env.SUPABASE_URL = base;
    mode = "error503";
    const { out, next } = await call(await token());
    expect(out.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("answers 503 when the key server answers with something that is not a key set", async () => {
    process.env.SUPABASE_URL = base;
    mode = "garbage";
    const { out } = await call(await token());
    expect(out.statusCode).toBe(503);
  });

  it("answers 503 when the key server refuses the connection", async () => {
    process.env.SUPABASE_URL = `http://127.0.0.1:${deadPort}`;
    const { out } = await call(await token(privateKey, `http://127.0.0.1:${deadPort}/auth/v1`));
    expect(out.statusCode).toBe(503);
  });

  it("still answers 401 for a token signed by another key, a wrong issuer, or garbage", async () => {
    process.env.SUPABASE_URL = base;
    expect((await call(await token(otherKey))).out.statusCode).toBe(401);
    expect((await call(await token(privateKey, "https://evil.example/auth/v1"))).out.statusCode).toBe(401);
    expect((await call("not-a-jwt")).out.statusCode).toBe(401);
  });

  it("other callers of verifyBearer keep the old contract: null, never a throw", async () => {
    process.env.SUPABASE_URL = base;
    mode = "error503";
    await expect(verifyBearer({ headers: { authorization: `Bearer ${await token()}` } } as never)).resolves.toBeNull();
  });

  it("a good token against a healthy key server verifies", async () => {
    process.env.SUPABASE_URL = base;
    const v = await verifyBearer({ headers: { authorization: `Bearer ${await token()}` } } as never, { throwWhenUnavailable: true });
    expect(v?.user_id).toBe("user-1");
  });
});
