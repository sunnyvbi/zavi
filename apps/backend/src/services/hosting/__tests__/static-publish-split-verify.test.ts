import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => { throw new Error("no db in this test"); } }));

import { publishStatic, restoreStaticKv, verifyStaticHost } from "../static-publish";
import { FULL_ENV, FakeCloudflare, FakeSandbox } from "./static-fakes";

const HOST = "acme-1234abcd.zaviagent.com";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DEPLOY = "dtest-1";
const DIR = `/tmp/static-${DEPLOY}`;
const KEY = `host:${HOST}`;

const deps = (cf: FakeCloudflare) => ({
  env: FULL_ENV,
  fetchFn: cf.fetch,
  newDeployId: () => DEPLOY,
  now: () => 1_700_000_000_000,
  sleep: async () => undefined,
  verifyAttempts: 3,
});

const input = (sb: FakeSandbox) => ({ tenant_id: "t-1", hostname: HOST, repo_full_name: "zavi-apps/acme", sha: SHA, sandbox: sb });

describe("publishStatic with verify: false", () => {
  let cf: FakeCloudflare;
  let sb: FakeSandbox;
  beforeEach(() => {
    cf = new FakeCloudflare();
    sb = new FakeSandbox();
    sb.files.set(`${DIR}/out/index.html`, "<html>home</html>");
  });

  it("uploads and flips KV but never fetches the hostname, and returns the previous KV value", async () => {
    const old = JSON.stringify({ deploy_id: "old", sha: "aaa", tenant_id: "t-1", published_at: "x" });
    cf.kv.set(KEY, old);
    cf.site = () => {
      throw new Error("verify must not run");
    };
    const r = await publishStatic({ ...input(sb), verify: false }, deps(cf));
    expect(r).toEqual({ ok: true, deploy_id: DEPLOY, file_count: 1, ms: 0, kv_previous: old });
    expect(cf.calls.some((c) => c.url === `https://${HOST}/`)).toBe(false);
    const upload = cf.calls.find((c) => c.method === "PUT" && c.url.includes("/r2/buckets/"));
    expect(upload?.url).toContain(`/objects/sites/${HOST}/${DEPLOY}/index.html`);
    expect(upload?.url).not.toContain("%2F");
    expect(JSON.parse(cf.kv.get(KEY)!)).toMatchObject({ deploy_id: DEPLOY, sha: SHA });
  });

  it("first publish reports kv_previous null", async () => {
    const r = await publishStatic({ ...input(sb), verify: false }, deps(cf));
    expect(r).toMatchObject({ ok: true, kv_previous: null });
  });

  it("default (verify on) still verifies and restores KV on a failed verify", async () => {
    const old = JSON.stringify({ deploy_id: "old" });
    cf.kv.set(KEY, old);
    cf.site = () => ({ status: 404, headers: { get: () => "text/plain" }, text: async () => "nope" });
    const r = await publishStatic(input(sb), deps(cf));
    expect(r).toMatchObject({ ok: false, stage: "verify" });
    expect(cf.kv.get(KEY)).toBe(old);
  });
});

describe("restoreStaticKv / verifyStaticHost", () => {
  let cf: FakeCloudflare;
  beforeEach(() => {
    cf = new FakeCloudflare();
  });

  it("puts the previous value back", async () => {
    cf.kv.set(KEY, "new");
    expect(await restoreStaticKv(HOST, "old", deps(cf))).toEqual({ ok: true });
    expect(cf.kv.get(KEY)).toBe("old");
  });

  it("deletes the key when there was no previous value", async () => {
    cf.kv.set(KEY, "new");
    expect(await restoreStaticKv(HOST.toUpperCase(), null, deps(cf))).toEqual({ ok: true });
    expect(cf.kv.has(KEY)).toBe(false);
  });

  it("verify passes on 200 html and retries up to the attempt limit otherwise", async () => {
    cf.site = () => ({
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "text/html" : name.toLowerCase() === "x-zavi-deploy-id" ? DEPLOY : null },
      text: async () => "<html></html>",
    });
    expect(await verifyStaticHost(HOST, DEPLOY, deps(cf))).toEqual({ ok: true });
    let n = 0;
    cf.site = () => {
      n++;
      return {
        status: 404,
        headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "text/html" : null },
        text: async () => "This site is not published yet",
      };
    };
    expect(await verifyStaticHost(HOST, DEPLOY, deps(cf))).toEqual({ ok: false, error: `GET https://${HOST}/ returned 404 text/html deploy=none` });
    expect(n).toBe(3);
  });

  it("does not certify an older deployment that still returns 200 HTML", async () => {
    cf.site = () => ({
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "text/html" : name.toLowerCase() === "x-zavi-deploy-id" ? "old" : null },
      text: async () => "<html>old</html>",
    });
    expect(await verifyStaticHost(HOST, DEPLOY, deps(cf))).toEqual({
      ok: false,
      error: `GET https://${HOST}/ returned 200 text/html deploy=old`,
    });
  });
});
