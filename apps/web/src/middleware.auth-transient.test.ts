import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isValidElement } from "react";

const nav = vi.hoisted(() => ({ cookie: "" as string }));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (name === "sb-wmyc-auth-token" && nav.cookie ? { value: nav.cookie } : undefined),
    getAll: () => (nav.cookie ? [{ name: "sb-wmyc-auth-token", value: nav.cookie }] : []),
    set: () => {},
    remove: () => {},
  }),
}));

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    redirect: (url: string) => {
      throw new Error(`NEXT_REDIRECT:${url}`);
    },
  };
});

import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { WorkspacePage } from "@/app/workspace/WorkspacePage";
import { WorkspaceBackendDown } from "@/app/workspace/WorkspaceBackendDown";

function sessionCookieValue(): string {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    access_token: "header.payload.signature",
    refresh_token: "refresh-token-value",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3000,
    user: { id: "11111111-1111-1111-1111-111111111111", aud: "authenticated", email: "founder@example.com" },
  };
  return "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
}

type UserEndpoint = () => Promise<Response>;
let userEndpoint: UserEndpoint;
const userCalls: string[] = [];
const otherCalls: string[] = [];

const outages: Array<[string, UserEndpoint]> = [
  ["a 503 from the auth gateway", async () => new Response("Service Unavailable", { status: 503 })],
  [
    "a 500 'Database error' from GoTrue while its database is down",
    async () =>
      new Response(JSON.stringify({ code: 500, error_code: "unexpected_failure", msg: "Database error querying schema" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  ],
  ["a dropped connection", async () => Promise.reject(new TypeError("fetch failed"))],
  ["a non-JSON 500 from a proxy", async () => new Response("<html>oops</html>", { status: 500 })],
];

const definiteSignOuts: Array<[string, UserEndpoint]> = [
  [
    "a 401 bad_jwt",
    async () =>
      new Response(JSON.stringify({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  ],
  [
    "a 403 session_not_found",
    async () =>
      new Response(JSON.stringify({ code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
  ],
];

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  process.env.NEXT_PUBLIC_API_URL = "http://backend.test";
  userCalls.length = 0;
  otherCalls.length = 0;
  nav.cookie = sessionCookieValue();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/user")) {
        userCalls.push(url);
        return userEndpoint();
      }
      otherCalls.push(url);
      return new Response(JSON.stringify({ code: 503, msg: "unexpected call in test" }), { status: 503 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function signedInRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { cookie: `sb-wmyc-auth-token=${nav.cookie}` },
  });
}

describe("middleware: a transient auth failure for a signed-in user is not a sign-out", () => {
  for (const [label, endpoint] of outages) {
    it(`does not send /workspace?tab=build to /login on ${label}`, async () => {
      userEndpoint = endpoint;
      const res = await middleware(signedInRequest("/workspace?tab=build"));
      expect(userCalls.length).toBeGreaterThan(0);
      expect(res.headers.get("location")).toBeNull();
      expect(res.status).toBe(200);
      expect(res.cookies.get("sb-wmyc-auth-token")?.value ?? "untouched").not.toBe("");
    });
  }

  for (const [label, endpoint] of definiteSignOuts) {
    it(`still sends the user to /login on ${label}`, async () => {
      userEndpoint = endpoint;
      const res = await middleware(signedInRequest("/workspace?tab=build"));
      expect(userCalls.length).toBeGreaterThan(0);
      expect(res.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fworkspace%3Ftab%3Dbuild");
    });
  }

  it("still sends a visitor with no session cookie to /login during an outage", async () => {
    userEndpoint = outages[0][1];
    const res = await middleware(new NextRequest("http://localhost:3000/workspace?tab=build"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fworkspace%3Ftab%3Dbuild");
  });
});

describe("/workspace page: a transient auth failure shows the trouble screen, not /login", () => {
  for (const [label, endpoint] of outages) {
    it(`renders WorkspaceBackendDown on ${label}`, async () => {
      userEndpoint = endpoint;
      const out = await WorkspacePage({ searchParams: { tab: "build" } });
      expect(userCalls.length).toBeGreaterThan(0);
      expect(isValidElement(out)).toBe(true);
      expect((out as { type: unknown }).type).toBe(WorkspaceBackendDown);
      expect(otherCalls).toEqual([]);
    });
  }

  for (const [label, endpoint] of definiteSignOuts) {
    it(`still redirects to /login on ${label}`, async () => {
      userEndpoint = endpoint;
      await expect(WorkspacePage({ searchParams: { tab: "build" } })).rejects.toThrow(
        "NEXT_REDIRECT:/login?next=%2Fworkspace%3Ftab%3Dbuild",
      );
    });
  }
});
