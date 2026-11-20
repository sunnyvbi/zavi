import { describe, it, expect } from "vitest";
import { parseEnv, projectLabel, unsafeUrl, checkSdk, runChecks, STAGING_REF, PROD_REF } from "../check-local-env.mjs";

const STAGING = `https://${STAGING_REF}.supabase.co`;
const PROD = `https://${PROD_REF}.supabase.co`;

const reply = (status, body = {}) => ({ ok: status < 300, status, json: async () => body });

function fakeSupabase({ goodKeys, goodPassword }) {
  return async (url, init) => {
    if (!goodKeys.includes(init.headers.apikey)) return reply(401, { message: "Invalid API key" });
    if (url.endsWith("/auth/v1/settings")) return reply(200);
    const { password } = JSON.parse(init.body);
    return password === goodPassword ? reply(200) : reply(400, { error_code: "invalid_credentials", msg: "Invalid login credentials" });
  };
}

const status = (checks) => Object.fromEntries(checks.map((c) => [c.name, c.status]));

describe("check-local-env", () => {
  it("parses env files: quotes, comments, export prefix, CRLF", () => {
    expect(parseEnv('A=1\r\n# c\nexport B="x y"\nC=z # note\nD=\'q#r\'')).toEqual({ A: "1", B: "x y", C: "z", D: "q#r" });
  });

  it("labels the Supabase project", () => {
    expect(projectLabel(PROD)).toBe("PROD");
    expect(projectLabel(PROD.toUpperCase())).toBe("PROD");
    expect(projectLabel(`${STAGING}/`)).toBe("staging");
    expect(projectLabel("http://127.0.0.1:54321")).toBe("local supabase");
  });

  it("fails a stale Agent SDK install and passes a matching one", () => {
    expect(checkSdk("0.3.284", "0.3.200").status).toBe("fail");
    expect(checkSdk("0.3.284", undefined).status).toBe("fail");
    expect(checkSdk("0.3.284", "0.3.284").status).toBe("ok");
  });

  it("all green when both anon keys and the test password work on staging", async () => {
    const checks = await runChecks({
      backend: { SUPABASE_URL: STAGING, SUPABASE_ANON_KEY: "good", QA_TEST_EMAIL: "qa@x", QA_TEST_PASSWORD: "pw" },
      web: { NEXT_PUBLIC_SUPABASE_URL: STAGING, NEXT_PUBLIC_SUPABASE_ANON_KEY: "good" },
      pinned: "0.3.284", installed: "0.3.284",
      fetchImpl: fakeSupabase({ goodKeys: ["good"], goodPassword: "pw" }),
    });
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("reports the week's three failures: rejected web key, stale password, stale SDK", async () => {
    const checks = await runChecks({
      backend: { SUPABASE_URL: STAGING, SUPABASE_ANON_KEY: "good", QA_TEST_EMAIL: "qa@x", QA_TEST_PASSWORD: "pw-SECRET-9f2" },
      web: { NEXT_PUBLIC_SUPABASE_URL: STAGING, NEXT_PUBLIC_SUPABASE_ANON_KEY: "key-SECRET-7c1" },
      pinned: "0.3.284", installed: "0.3.100",
      fetchImpl: fakeSupabase({ goodKeys: ["good"], goodPassword: "pw" }),
    });
    expect(status(checks)).toMatchObject({ "agent sdk": "fail", "backend anon key": "ok", "web anon key": "fail", "test sign-in": "fail" });
    const detail = checks.map((c) => c.detail).join("\n");
    expect(detail).toMatch(/Invalid API key/);
    expect(detail).toMatch(/Invalid login credentials/);
    expect(detail).not.toMatch(/SECRET/);
  });

  it("flags web and backend on different projects, fails on PROD and never signs in there", async () => {
    const calls = [];
    const fake = fakeSupabase({ goodKeys: ["good"], goodPassword: "pw" });
    const checks = await runChecks({
      backend: { SUPABASE_URL: PROD, SUPABASE_ANON_KEY: "good", QA_TEST_EMAIL: "qa@x", QA_TEST_PASSWORD: "pw" },
      web: { NEXT_PUBLIC_SUPABASE_URL: STAGING, NEXT_PUBLIC_SUPABASE_ANON_KEY: "good" },
      pinned: "0.3.284", installed: "0.3.284",
      fetchImpl: (url, init) => { calls.push(url); return fake(url, init); },
    });
    expect(status(checks)).toMatchObject({ "backend project": "fail", "web project": "fail", "test sign-in": "skip" });
    expect(calls.some((u) => u.includes("/token"))).toBe(false);
  });

  it("labels by exact parsed hostname, so spelling tricks cannot hide PROD", () => {
    for (const u of [PROD.toUpperCase(), `${PROD}.`, `${PROD}/`, ` ${PROD} `, `${PROD}:443`, `${PROD}/x?y#z`]) expect(projectLabel(u)).toBe("PROD");
    for (const u of [`https://${PROD_REF}.supabase.co.evil.com`, "https://evil.com/" + PROD_REF + ".supabase.co", "not a url", undefined]) expect(projectLabel(u)).not.toBe("PROD");
  });

  it("blocks guard-bypass URLs before any request, and never signs in to a disguised PROD", async () => {
    const bypass = ["http://localhost@evil.com", "http://127.0.0.1.evil.com", "http://localhost:80@evil", "http://[::1]x", "https://user:pw@" + STAGING_REF + ".supabase.co", "ftp://localhost"];
    for (const u of bypass) expect(unsafeUrl(u)).not.toBeNull();
    for (const u of ["http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321", "HTTP://LOCALHOST:54321", STAGING]) expect(unsafeUrl(u)).toBeNull();
    for (const u of [...bypass, `${PROD}.`, PROD.toUpperCase()]) {
      const calls = [];
      await runChecks({
        backend: { SUPABASE_URL: u, SUPABASE_ANON_KEY: "good", QA_TEST_EMAIL: "qa@x", QA_TEST_PASSWORD: "pw" },
        web: {}, pinned: "0.3.284", installed: "0.3.284",
        fetchImpl: async (url, init) => { calls.push({ url, init }); return reply(200); },
      });
      expect(calls.filter((c) => c.url.includes("/token"))).toEqual([]);
      for (const c of calls) expect(new URL(c.url).hostname.replace(/\.$/, "")).toBe(`${PROD_REF}.supabase.co`);
    }
  });

  it("sends requests to the parsed origin only, with redirects refused", async () => {
    const calls = [];
    await runChecks({
      backend: { SUPABASE_URL: `${STAGING}/rest?x=1#frag`, SUPABASE_ANON_KEY: "good", QA_TEST_EMAIL: "qa@x", QA_TEST_PASSWORD: "pw" },
      web: {}, pinned: "0.3.284", installed: "0.3.284",
      fetchImpl: async (url, init) => { calls.push({ url, init }); return reply(200); },
    });
    expect(calls.map((c) => c.url)).toEqual([`${STAGING}/auth/v1/settings`, `${STAGING}/auth/v1/token?grant_type=password`]);
    expect(calls.every((c) => c.init.redirect === "error")).toBe(true);
  });

  it("sends the QA password only to staging or local supabase", async () => {
    for (const u of ["https://otherref.supabase.co", "https://example.com", "http://localhost:54321"]) {
      const calls = [];
      const checks = await runChecks({
        backend: { SUPABASE_URL: u, SUPABASE_ANON_KEY: "good", QA_TEST_EMAIL: "qa@x", QA_TEST_PASSWORD: "pw" },
        web: {}, pinned: "0.3.284", installed: "0.3.284",
        fetchImpl: async (url) => { calls.push(url); return reply(200); },
      });
      const signedIn = calls.some((c) => c.includes("/token"));
      expect(signedIn).toBe(u.startsWith("http://localhost"));
      if (!signedIn) expect(status(checks)["test sign-in"]).toBe("skip");
    }
  });

  it("refuses to send keys or passwords over plain http to another host", async () => {
    const calls = [];
    const checks = await runChecks({
      backend: { SUPABASE_URL: "http://proxy.example.com", SUPABASE_ANON_KEY: "good", QA_TEST_EMAIL: "qa@x", QA_TEST_PASSWORD: "pw" },
      web: {}, pinned: "0.3.284", installed: "0.3.284",
      fetchImpl: async (url) => { calls.push(url); return reply(200); },
    });
    expect(status(checks)).toMatchObject({ "backend anon key": "fail", "test sign-in": "fail" });
    expect(calls).toEqual([]);
  });

  it("turns a network error into a failed check instead of a crash", async () => {
    const checks = await runChecks({
      backend: { SUPABASE_URL: STAGING, SUPABASE_ANON_KEY: "k" }, web: {},
      pinned: "0.3.284", installed: "0.3.284", signin: false,
      fetchImpl: async () => { throw new Error("ENOTFOUND"); },
    });
    expect(checks.find((c) => c.name === "backend anon key")).toMatchObject({ status: "fail", detail: expect.stringMatching(/ENOTFOUND/) });
    expect(status(checks)["web project"]).toBe("fail");
  });
});
