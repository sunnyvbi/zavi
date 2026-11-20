
import { describe, it, expect } from "vitest";
import {
  runAcceptanceBattery,
  type FetchLike,
  type Invariant,
} from "../acceptance-gate";

type Spec = { status: number; body?: string; location?: string; setCookie?: string };
type Req = { method: string; path: string; cookie?: string; contentType?: string; body?: string };

const BASE = "https://acme.test";

function mkFetch(handler: (req: Req) => Spec): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const spec = handler({
      method: (init?.method ?? "GET").toUpperCase(),
      path: u.pathname,
      cookie: headers.cookie,
      contentType: headers["content-type"],
      body: init?.body,
    });
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

const HEALTHY = (req: Req): Spec => {
  if (req.path === "/") return { status: 200, body: "<title>Acme Marketplace</title><main>real listings</main>" };
  if (req.path === "/browse") return { status: 200, body: "<ul>listings</ul>" };
  if (req.path === "/api/signup" && req.method === "POST")
    return { status: 303, location: "/dashboard", setCookie: "session=valid-abc; Path=/; HttpOnly" };
  if (req.path === "/dashboard") {
    if (req.cookie === "session=valid-abc") return { status: 200, body: "<h1>Dashboard</h1>" };
    return { status: 303, location: "/login" };
  }
  return { status: 404 };
};

describe("acceptance battery — all invariants pass on a healthy app", () => {
  it("overall pass with every invariant green", async () => {
    const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "acme" }, mkFetch(HEALTHY));
    expect(res.pass).toBe(true);
    expect(res.firstFailure).toBe("");
    for (const name of ["REAL_APP", "NO_500_CORE", "AUTH_ROUNDTRIP", "PROTECTED_GATING", "NO_FORGED_SESSION"]) {
      expect(inv(res, name).pass).toBe(true);
    }
  });

  it("tolerates a trailing slash in baseUrl", async () => {
    const res = await runAcceptanceBattery({ baseUrl: `${BASE}/`, appSlug: "acme" }, mkFetch(HEALTHY));
    expect(res.pass).toBe(true);
  });
});

describe("REAL_APP", () => {
  it("FAILS when the homepage still serves the seed placeholder", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE },
      mkFetch((req) =>
        req.path === "/"
          ? { status: 200, body: "<title>Your Company</title>Your company app is live." }
          : { status: 404 },
      ),
    );
    expect(inv(res, "REAL_APP").pass).toBe(false);
    expect(res.pass).toBe(false);
    expect(res.firstFailure).toBe("REAL_APP");
  });

  it("FAILS on a __next_error__ runtime crash page", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE },
      mkFetch((req) =>
        req.path === "/" ? { status: 200, body: "<title>Acme</title><div id=__next_error__></div>" } : { status: 404 },
      ),
    );
    expect(inv(res, "REAL_APP").pass).toBe(false);
  });
});

describe("NO_500_CORE", () => {
  it("FAILS when the homepage 500s", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE },
      mkFetch((req) => (req.path === "/" ? { status: 500, body: "err" } : { status: 404 })),
    );
    expect(inv(res, "NO_500_CORE").pass).toBe(false);
  });

  it("FAILS when the browse route 500s", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE },
      mkFetch((req) => {
        if (req.path === "/") return { status: 200, body: "<title>Acme</title>" };
        if (req.path === "/browse") return { status: 500, body: "boom" };
        return { status: 404 };
      }),
    );
    expect(inv(res, "NO_500_CORE").pass).toBe(false);
  });

  it("passes when core routes are non-5xx (no browse route present)", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE },
      mkFetch((req) => (req.path === "/" ? { status: 200, body: "<title>Acme</title>" } : { status: 404 })),
    );
    expect(inv(res, "NO_500_CORE").pass).toBe(true);
  });
});

describe("AUTH_ROUNDTRIP", () => {
  it("FAILS (#10) when signup sets a cookie but every protected route still bounces", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE },
      mkFetch((req) => {
        if (req.path === "/") return { status: 200, body: "<title>Acme</title>" };
        if (req.path === "/api/signup" && req.method === "POST")
          return { status: 303, location: "/dashboard", setCookie: "session=valid-abc; HttpOnly" };
        if (["/dashboard", "/account", "/app", "/home", "/profile", "/settings", "/admin", "/my", "/me", "/inbox"].includes(req.path))
          return { status: 303, location: "/login" };
        return { status: 404 };
      }),
    );
    expect(inv(res, "AUTH_ROUNDTRIP").pass).toBe(false);
  });

  it("inconclusive PASS when no signup endpoint exists (app may have no auth)", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE },
      mkFetch((req) => (req.path === "/" ? { status: 200, body: "<title>Acme</title>" } : { status: 404 })),
    );
    expect(inv(res, "AUTH_ROUNDTRIP").pass).toBe(true);
    expect(inv(res, "PROTECTED_GATING").pass).toBe(true);
    expect(inv(res, "NO_FORGED_SESSION").pass).toBe(true);
    expect(res.pass).toBe(true);
  });

  it("retries the signup POST as JSON when form-encoding is rejected", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE },
      mkFetch((req) => {
        if (req.path === "/") return { status: 200, body: "<title>Acme</title>" };
        if (req.path === "/api/signup" && req.method === "POST") {
          if (req.contentType === "application/x-www-form-urlencoded") return { status: 415 };
          return { status: 303, location: "/dashboard", setCookie: "session=valid-abc; HttpOnly" };
        }
        if (req.path === "/dashboard") return req.cookie === "session=valid-abc" ? { status: 200, body: "ok" } : { status: 303, location: "/login" };
        return { status: 404 };
      }),
    );
    expect(inv(res, "AUTH_ROUNDTRIP").pass).toBe(true);
  });
});

describe("PROTECTED_GATING", () => {
  it("FAILS when a known-protected route serves 200 to an unauthenticated request", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE },
      mkFetch((req) => {
        if (req.path === "/") return { status: 200, body: "<title>Acme</title>" };
        if (req.path === "/api/signup" && req.method === "POST")
          return { status: 303, location: "/dashboard", setCookie: "session=valid-abc; HttpOnly" };
        if (req.path === "/dashboard") return { status: 200, body: "<h1>open</h1>" };
        return { status: 404 };
      }),
    );
    expect(inv(res, "PROTECTED_GATING").pass).toBe(false);
  });
});

describe("NO_FORGED_SESSION (#9 account-takeover-by-default)", () => {
  it("FAILS when a forged default-secret cookie is accepted on the protected route", async () => {
    const res = await runAcceptanceBattery(
      { baseUrl: BASE, appSlug: "acme" },
      mkFetch((req) => {
        if (req.path === "/") return { status: 200, body: "<title>Acme</title>" };
        if (req.path === "/api/signup" && req.method === "POST")
          return { status: 303, location: "/dashboard", setCookie: "session=valid-abc; HttpOnly" };
        if (req.path === "/dashboard") {
          if (req.cookie && req.cookie.startsWith("session=")) return { status: 200, body: "in" };
          return { status: 303, location: "/login" };
        }
        return { status: 404 };
      }),
    );
    expect(inv(res, "AUTH_ROUNDTRIP").pass).toBe(true);
    expect(inv(res, "PROTECTED_GATING").pass).toBe(true);
    expect(inv(res, "NO_FORGED_SESSION").pass).toBe(false);
    expect(res.pass).toBe(false);
    expect(res.firstFailure).toBe("NO_FORGED_SESSION");
  });

  it("passes when forged cookies are rejected (only the real session works)", async () => {
    const res = await runAcceptanceBattery({ baseUrl: BASE, appSlug: "acme" }, mkFetch(HEALTHY));
    expect(inv(res, "NO_FORGED_SESSION").pass).toBe(true);
  });
});
