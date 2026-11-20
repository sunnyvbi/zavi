
import { describe, expect, it, vi } from "vitest";
import { isDatabaseConnectionFailure, isNpmNetworkFailure, isTransientPlatformError, POSTGREST_PRE_EXECUTION_CODES } from "../platform-errors";
import { createSiteStore, SITE_STORE_RETRY_DELAYS_MS, type SiteStoreDeps } from "../store";

const T1 = "11111111-1111-4111-8111-111111111111";
const SITE = "aaaaaaaa-0000-4000-8000-000000000001";

describe("isTransientPlatformError", () => {
  it.each([
    "SiteStore: site_provider_set failed (PGRST002): Could not query the database for the schema cache. Retrying.",
    "SiteStore: site_update failed (PGRST003): Timed out acquiring connection from connection pool.",
    "SiteStore: read failed (PGRST000): Database connection error. Retrying the connection.",
    "fetch failed",
    "read ECONNRESET",
    "socket hang up",
    "kv write failed (503)",
    "r2 list failed (502)",
    "GitHub answered 502 listing commits",
    "supabase database/query failed (network)",
    "remaining connection slots are reserved for non-replication superuser connections",
    "Connection terminated unexpectedly",
    "the sandbox abc was not found",
  ])("transient: %s", (msg) => {
    expect(isTransientPlatformError(new Error(msg))).toBe(true);
  });

  it.each([
    'relation "orders" does not exist',
    "npm ERR! code ERESOLVE",
    "npm ERR! code E404 - Not Found - GET https://registry.npmjs.org/not-a-real-pkg",
    "src/App.tsx(4,1): error TS2304: Cannot find name 'Foo'.",
    "routing: cloudflare answered 400",
    "build produced no dist/index.html",
    "HTTP 404 for /menu",
    "SiteStore: site_update failed (PGRST116): no rows",
  ])("not transient: %s", (msg) => {
    expect(isTransientPlatformError(new Error(msg))).toBe(false);
  });

  it("reads a code or a 5xx status on the error and its cause", () => {
    expect(isTransientPlatformError(Object.assign(new Error("x"), { code: "PGRST002" }))).toBe(true);
    expect(isTransientPlatformError(Object.assign(new Error("x"), { code: "57P01" }))).toBe(true);
    expect(isTransientPlatformError(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isTransientPlatformError(Object.assign(new Error("x"), { status: 409 }))).toBe(false);
    expect(isTransientPlatformError(new Error("wrapped", { cause: Object.assign(new Error("y"), { code: "ECONNREFUSED" }) }))).toBe(true);
    expect(isTransientPlatformError(null)).toBe(false);
  });
});

describe("npm ci output: only npm's own code line says the registry failed", () => {
  it("registry / network codes", () => {
    expect(isNpmNetworkFailure("npm ERR! code ECONNRESET\nnpm ERR! network aborted")).toBe(true);
    expect(isNpmNetworkFailure("npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/react")).toBe(true);
    expect(isNpmNetworkFailure("npm warn deprecated x\nnpm ERR! code ETIMEDOUT")).toBe(true);
    for (const code of ["E408", "E429", "ENETUNREACH", "EHOSTUNREACH"]) expect(isNpmNetworkFailure(`npm error code ${code}`)).toBe(true);
  });
  it("the site's own packages or code never match, even when they quote those words", () => {
    expect(isNpmNetworkFailure("npm ERR! code ERESOLVE")).toBe(false);
    expect(isNpmNetworkFailure("npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/not-a-real-pkg")).toBe(false);
    expect(isNpmNetworkFailure("npm ERR! code EUSAGE\nnpm ci can only install packages when your package.json and package-lock.json are in sync")).toBe(false);
    expect(isNpmNetworkFailure("src/api.ts(3,7): error TS2322: Type '\"fetch failed\"' is not assignable to type 'number'. status 503")).toBe(false);
    expect(isNpmNetworkFailure("console.log('npm ERR! code ECONNRESET')")).toBe(false);
  });
});

describe("Postgres connection failures (a migration that never ran)", () => {
  it("connection wording only", () => {
    expect(isDatabaseConnectionFailure("remaining connection slots are reserved for non-replication superuser connections")).toBe(true);
    expect(isDatabaseConnectionFailure("the database system is starting up")).toBe(true);
    expect(isDatabaseConnectionFailure("terminating connection due to administrator command")).toBe(true);
    expect(isDatabaseConnectionFailure("ERROR: 57P01: terminating connection")).toBe(true);
    expect(isDatabaseConnectionFailure("08006 connection failure")).toBe(true);
    expect(isDatabaseConnectionFailure('relation "orders" does not exist')).toBe(false);
    expect(isDatabaseConnectionFailure('syntax error at or near "tabel"')).toBe(false);
  });
});

describe("SiteStore retries a call PostgREST refused before running it", () => {
  function store(answers: Array<{ data: unknown; error: { code?: string; message?: string } | null }>) {
    type Rpc = SiteStoreDeps["rpc"];
    const rpc = vi.fn<Parameters<Rpc>, ReturnType<Rpc>>(async () => answers.shift() ?? { data: null, error: { code: "PGRST002", message: "schema cache" } });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const s = createSiteStore({ rpc, table: () => { throw new Error("no table reads here"); }, sleep });
    return { s, rpc, sleep };
  }

  it("a PGRST002 blip is re-sent and the write lands, so the publish never fails for it", async () => {
    const t = store([
      { data: null, error: { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." } },
      { data: null, error: { code: "PGRST003", message: "Timed out acquiring connection" } },
      { data: null, error: null },
    ]);
    await t.s.setProviderState(T1, SITE, "r2_prefix", "created");
    expect(t.rpc).toHaveBeenCalledTimes(3);
    expect(t.sleep.mock.calls.map((c) => c[0])).toEqual(SITE_STORE_RETRY_DELAYS_MS.slice(0, 2));
  });

  it("is bounded: after every retry it throws with the code (the deploy step then retries)", async () => {
    const t = store([]);
    await expect(t.s.setProviderState(T1, SITE, "r2_prefix", "created")).rejects.toThrow(/PGRST002/);
    expect(t.rpc).toHaveBeenCalledTimes(SITE_STORE_RETRY_DELAYS_MS.length + 1);
  });

  it("never re-sends any other error (it may have run)", async () => {
    for (const code of ["PGRST116", "P0002", "23505", "57014"]) {
      const t = store([{ data: null, error: { code, message: "no" } }]);
      await expect(t.s.claimProvider(T1, SITE, "r2_prefix", {})).rejects.toThrow(code);
      expect(t.rpc).toHaveBeenCalledTimes(1);
      expect(t.sleep).not.toHaveBeenCalled();
    }
  });

  it("only the four pre-execution codes are replayable", () => {
    expect([...POSTGREST_PRE_EXECUTION_CODES].sort()).toEqual(["PGRST000", "PGRST001", "PGRST002", "PGRST003"]);
  });
});
