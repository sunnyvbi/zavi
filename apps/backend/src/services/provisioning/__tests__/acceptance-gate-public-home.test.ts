import { describe, it, expect } from "vitest";
import { runAcceptanceBattery, type FetchLike, type Invariant } from "../acceptance-gate";

type Req = { method: string; path: string; cookie?: string };
type Spec = { status: number; body?: string; location?: string; setCookie?: string };

const BASE = "https://acme.test";

function mkFetch(handler: (req: Req) => Spec, log: Req[]): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const req = { method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, cookie: headers.cookie };
    log.push(req);
    const spec = handler(req);
    return {
      status: spec.status,
      headers: {
        get: (n: string) => {
          const k = n.toLowerCase();
          if (k === "location") return spec.location ?? null;
          if (k === "set-cookie") return spec.setCookie ?? null;
          return null;
        },
      },
      text: async () => spec.body ?? "",
    };
  };
}

function inv(res: { invariants: Invariant[] }, name: string): Invariant {
  const i = res.invariants.find((x) => x.name === name);
  if (!i) throw new Error(`invariant ${name} not found`);
  return i;
}

const signup = (req: Req): Spec | null =>
  req.path === "/api/signup" && req.method === "POST"
    ? { status: 303, location: "/profile", setCookie: "session=valid-abc; HttpOnly" }
    : null;

describe.each(["/home", "/app"])("acceptance battery with a public %s page", (publicPath) => {
  it("passes a healthy app whose protected area is /profile", async () => {
    const log: Req[] = [];
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "acme" },
      mkFetch((req) => {
        const s = signup(req);
        if (s) return s;
        if (req.path === "/") return { status: 200, body: "<title>Acme</title>" };
        if (req.path === publicPath) return { status: 200, body: "<h1>Welcome</h1>" };
        if (req.path === "/profile") {
          if (req.cookie === "session=valid-abc") return { status: 200, body: "me" };
          return { status: 303, location: "/login" };
        }
        return { status: 404 };
      }, log),
    );
    expect(inv(res, "AUTH_ROUNDTRIP").pass).toBe(true);
    expect(inv(res, "PROTECTED_GATING").pass).toBe(true);
    expect(inv(res, "NO_FORGED_SESSION").pass).toBe(true);
    expect(inv(res, "NO_FORGED_SESSION").evidence).toContain("/profile");
    expect(res.pass).toBe(true);
    const forgedOnPublic = log.filter(
      (r) => r.path === publicPath && r.cookie && r.cookie !== "session=valid-abc",
    );
    expect(forgedOnPublic).toHaveLength(0);
  });

  it("still fails a forged default-secret cookie on the real protected route", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "acme" },
      mkFetch((req) => {
        const s = signup(req);
        if (s) return s;
        if (req.path === "/") return { status: 200, body: "<title>Acme</title>" };
        if (req.path === publicPath) return { status: 200, body: "<h1>Welcome</h1>" };
        if (req.path === "/profile") {
          if (req.cookie?.startsWith("session=")) return { status: 200, body: "me" };
          return { status: 303, location: "/login" };
        }
        return { status: 404 };
      }, []),
    );
    expect(res.firstFailure).toBe("NO_FORGED_SESSION");
    expect(inv(res, "PROTECTED_GATING").pass).toBe(true);
  });

  it("passes as inconclusive when the only 200 with the cookie is the public page", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "acme" },
      mkFetch((req) => {
        const s = signup(req);
        if (s) return s;
        if (req.path === "/") return { status: 200, body: "<title>Acme</title>" };
        if (req.path === publicPath) return { status: 200, body: "<h1>Welcome</h1>" };
        return { status: 404 };
      }, []),
    );
    expect(inv(res, "AUTH_ROUNDTRIP").pass).toBe(true);
    expect(res.pass).toBe(true);
  });

  it("still fails #10 when the protected route bounces with the cookie", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "acme" },
      mkFetch((req) => {
        const s = signup(req);
        if (s) return s;
        if (req.path === "/") return { status: 200, body: "<title>Acme</title>" };
        if (req.path === publicPath) return { status: 200, body: "<h1>Welcome</h1>" };
        if (req.path === "/profile") return { status: 303, location: "/login" };
        return { status: 404 };
      }, []),
    );
    expect(inv(res, "AUTH_ROUNDTRIP").pass).toBe(false);
  });

  it("still treats the page as protected when it gates anonymous requests", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "acme" },
      mkFetch((req) => {
        const s = signup(req);
        if (s) return s;
        if (req.path === "/") return { status: 200, body: "<title>Acme</title>" };
        if (req.path === publicPath) {
          if (req.cookie?.startsWith("session=")) return { status: 200, body: "in" };
          return { status: 303, location: "/login" };
        }
        return { status: 404 };
      }, []),
    );
    expect(res.firstFailure).toBe("NO_FORGED_SESSION");
    expect(inv(res, "NO_FORGED_SESSION").evidence).toContain(publicPath);
  });
});
