import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileWorker, readConfig, runSetup, type SetupConfig } from "../../../../scripts/setup-static-host";

const ROOT = resolve(__dirname, "../../../..");
const cfg: SetupConfig = {
  accountId: "acct1",
  token: "tok",
  bucket: "zavi-static",
  workerName: "zavi-static-host",
  kvTitle: "zavi-static-host-hosts",
  zaviApi: "https://api.zaviagent.com",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Route = (method: string, url: string, init: RequestInit) => Response | undefined;

function fakeFetch(route: Route) {
  const calls: { method: string; url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ method, url, init });
    const res = route(method, url, init);
    if (!res) throw new Error(`unexpected ${method} ${url}`);
    return res;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("setup-static-host", () => {
  it("dry run makes no network calls and prints every planned call", async () => {
    const { fn, calls } = fakeFetch(() => undefined);
    const lines: string[] = [];
    const res = await runSetup(cfg, { fetch: fn, log: (l) => lines.push(l), workerSource: () => "export default {}" }, true);
    expect(res).toBeNull();
    expect(calls).toEqual([]);
    const out = lines.join("\n");
    expect(out).toContain("GET /accounts/acct1/r2/buckets/zavi-static");
    expect(out).toContain('POST /accounts/acct1/r2/buckets {"name":"zavi-static"}');
    expect(out).toContain('GET /accounts/acct1/storage/kv/namespaces?per_page=100  (find title "zavi-static-host-hosts"');
    expect(out).toContain("PUT /accounts/acct1/workers/scripts/zavi-static-host");
    expect(out).toContain("SITES=r2:zavi-static");
    expect(out).not.toContain("tok");
  });

  it("dry run CLI works with no creds and never needs the network", () => {
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const out = execFileSync(resolve(ROOT, "node_modules/.bin/tsx"), ["scripts/setup-static-host.ts", "--dry-run"], {
      cwd: ROOT,
      env,
      encoding: "utf8",
    });
    expect(out).toContain("dry run: no Cloudflare calls will be made");
    expect(out).toContain("PUT /accounts/<CLOUDFLARE_ACCOUNT_ID>/workers/scripts/<ZAVI_STATIC_WORKER_NAME>");
    expect(out).toMatch(/worker\.js compiled: \d+ bytes/);
  });

  it("non dry run refuses to start without creds", () => {
    expect(() => readConfig({}, false)).toThrow(/CLOUDFLARE_ACCOUNT_ID.*CLOUDFLARE_STATIC_API_TOKEN.*ZAVI_STATIC_R2_BUCKET.*ZAVI_STATIC_WORKER_NAME/);
  });

  it("is idempotent: existing bucket and namespace are reused, only the worker is uploaded", async () => {
    const { fn, calls } = fakeFetch((method, url) => {
      if (method === "GET" && url.endsWith("/r2/buckets/zavi-static")) return json(200, { success: true, result: { name: "zavi-static" } });
      if (method === "GET" && url.includes("/storage/kv/namespaces?per_page=100&page=1"))
        return json(200, { success: true, result: [{ id: "x", title: "other" }], result_info: { page: 1, total_pages: 2 } });
      if (method === "GET" && url.includes("/storage/kv/namespaces?per_page=100&page=2"))
        return json(200, { success: true, result: [{ id: "kv123", title: "zavi-static-host-hosts" }], result_info: { page: 2, total_pages: 2 } });
      if (method === "PUT" && url.endsWith("/workers/scripts/zavi-static-host")) return json(200, { success: true, result: {} });
      return undefined;
    });
    const res = await runSetup(cfg, { fetch: fn, log: () => {}, workerSource: () => "export default {}" }, false);
    expect(res?.kvNamespaceId).toBe("kv123");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    const put = calls.find((c) => c.method === "PUT")!;
    expect((put.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const form = put.init.body as FormData;
    const meta = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(meta).toMatchObject({
      main_module: "worker.js",
      bindings: [
        { type: "r2_bucket", name: "SITES", bucket_name: "zavi-static" },
        { type: "kv_namespace", name: "HOSTS", namespace_id: "kv123" },
        { type: "plain_text", name: "ZAVI_API", text: "https://api.zaviagent.com" },
      ],
      keep_bindings: ["secret_text"],
    });
    const mod = form.get("worker.js") as File;
    expect(mod.type).toBe("application/javascript+module");
    expect(await mod.text()).toBe("export default {}");
  });

  it("creates missing bucket and namespace before uploading", async () => {
    const { fn, calls } = fakeFetch((method, url, init) => {
      if (method === "GET" && url.endsWith("/r2/buckets/zavi-static")) return json(404, { success: false, errors: [{ code: 10006, message: "not found" }], result: null });
      if (method === "POST" && url.endsWith("/r2/buckets")) {
        expect(JSON.parse(String(init.body))).toEqual({ name: "zavi-static" });
        return json(200, { success: true, result: {} });
      }
      if (method === "GET" && url.includes("/storage/kv/namespaces?")) return json(200, { success: true, result: [], result_info: { page: 1, total_pages: 1 } });
      if (method === "POST" && url.endsWith("/storage/kv/namespaces")) return json(200, { success: true, result: { id: "newkv", title: "zavi-static-host-hosts" } });
      if (method === "PUT") return json(200, { success: true, result: {} });
      return undefined;
    });
    const res = await runSetup(cfg, { fetch: fn, log: () => {}, workerSource: () => "w" }, false);
    expect(res?.kvNamespaceId).toBe("newkv");
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://api.cloudflare.com/client/v4", "")}`)).toEqual([
      "GET /accounts/acct1/r2/buckets/zavi-static",
      "POST /accounts/acct1/r2/buckets",
      "GET /accounts/acct1/storage/kv/namespaces?per_page=100&page=1",
      "POST /accounts/acct1/storage/kv/namespaces",
      "PUT /accounts/acct1/workers/scripts/zavi-static-host",
    ]);
  });

  it("does not upload the worker when the bucket check fails with a non-404", async () => {
    const { fn, calls } = fakeFetch((method, url) => {
      if (method === "GET" && url.endsWith("/r2/buckets/zavi-static")) return json(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null });
      return json(200, { success: true, result: {} });
    });
    await expect(runSetup(cfg, { fetch: fn, log: () => {}, workerSource: () => "w" }, false)).rejects.toThrow(/get r2 bucket failed: HTTP 403: 10000 Authentication error/);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("verifies a configured namespace id instead of creating one", async () => {
    const { fn, calls } = fakeFetch((method, url) => {
      if (url.endsWith("/r2/buckets/zavi-static")) return json(200, { success: true, result: {} });
      if (url.endsWith("/storage/kv/namespaces/fixed")) return json(200, { success: true, result: { id: "fixed" } });
      if (method === "PUT") return json(200, { success: true, result: {} });
      return undefined;
    });
    const res = await runSetup({ ...cfg, kvNamespaceId: "fixed" }, { fetch: fn, log: () => {}, workerSource: () => "w" }, false);
    expect(res?.kvNamespaceId).toBe("fixed");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("compiles the real worker to a module with no type syntax", () => {
    const js = compileWorker();
    expect(js).toContain("export default");
    expect(js).not.toMatch(/interface |: Env|as HostRecord/);
  });
});
