import type { SandboxExec, SandboxRunResult, StaticFetch, StaticFetchResponse } from "../static-publish";

export const FULL_ENV = {
  CLOUDFLARE_ACCOUNT_ID: "acct1",
  CLOUDFLARE_STATIC_API_TOKEN: "tok1",
  CLOUDFLARE_ZONE_ID: "zone1",
  ZAVI_STATIC_R2_BUCKET: "bucket1",
  ZAVI_STATIC_KV_NAMESPACE_ID: "kv1",
  ZAVI_STATIC_WORKER_NAME: "zavi-static-host",
};

export type CallLog = { seq: number; method: string; url: string; headers: Record<string, string>; body?: string | Uint8Array };

function resp(status: number, body: string, headers: Record<string, string> = {}): StaticFetchResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (n: string) => lower[n.toLowerCase()] ?? null }, text: async () => body };
}

function cfOk(result: unknown): StaticFetchResponse {
  return resp(200, JSON.stringify({ success: true, result, errors: [] }), { "content-type": "application/json" });
}

export type DnsRec = { id: string; name: string; type: string; content: string; proxied: boolean; ttl: number };
export type RouteRec = { id: string; pattern: string; script: string | null };

export class FakeCloudflare {
  calls: CallLog[] = [];
  seq = 0;
  r2 = new Map<string, { body: Buffer; contentType: string; seq: number }>();
  kv = new Map<string, string>();
  dns: DnsRec[] = [];
  routes: RouteRec[] = [];
  failUploadKey: ((key: string) => boolean) | null = null;
  kvReadStatus: number | null = null;
  site: (host: string) => StaticFetchResponse = (host) => {
    const deployId = JSON.parse(this.kv.get(`host:${host}`) ?? "{}") as { deploy_id?: string };
    return resp(200, "<html></html>", {
      "content-type": "text/html; charset=utf-8",
      ...(deployId.deploy_id ? { "x-zavi-deploy-id": deployId.deploy_id } : {}),
    });
  };
  uploadDelayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  nextId = 1;

  fetch: StaticFetch = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const seq = ++this.seq;
    this.calls.push({ seq, method, url, headers: init.headers ?? {}, body: init.body });
    const u = new URL(url);
    if (u.hostname !== "api.cloudflare.com") return this.site(u.hostname);
    const p = u.pathname.replace("/client/v4", "");
    const r2 = p.match(/^\/accounts\/acct1\/r2\/buckets\/bucket1\/objects\/(.+)$/);
    if (r2 && method === "PUT") {
      const key = decodeURIComponent(r2[1]);
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      await new Promise((r) => setTimeout(r, this.uploadDelayMs));
      this.inFlight--;
      if (this.failUploadKey?.(key)) return resp(500, "boom");
      const body = init.body;
      this.r2.set(key, {
        body: typeof body === "string" ? Buffer.from(body) : Buffer.from(body ?? new Uint8Array()),
        contentType: init.headers?.["Content-Type"] ?? "",
        seq,
      });
      return cfOk({});
    }
    const kv = p.match(/^\/accounts\/acct1\/storage\/kv\/namespaces\/kv1\/values\/(.+)$/);
    if (kv) {
      const key = decodeURIComponent(kv[1]);
      if (method === "GET") {
        if (this.kvReadStatus) return resp(this.kvReadStatus, "err");
        const v = this.kv.get(key);
        return v === undefined ? resp(404, "not found") : resp(200, v);
      }
      if (method === "PUT") {
        this.kv.set(key, String(init.body));
        return cfOk(null);
      }
      if (method === "DELETE") {
        this.kv.delete(key);
        return cfOk(null);
      }
    }
    if (p === "/zones/zone1/workers/routes" && method === "GET") return cfOk(this.routes.map((r) => ({ ...r })));
    if (p === "/zones/zone1/workers/routes" && method === "POST") {
      const b = JSON.parse(String(init.body)) as { pattern: string; script: string };
      const rec = { id: `route${this.nextId++}`, pattern: b.pattern, script: b.script };
      this.routes.push(rec);
      return cfOk(rec);
    }
    const route = p.match(/^\/zones\/zone1\/workers\/routes\/(.+)$/);
    if (route) {
      const idx = this.routes.findIndex((r) => r.id === route[1]);
      if (idx < 0) return resp(404, JSON.stringify({ success: false, errors: [{ message: "nf" }] }));
      if (method === "PUT") {
        const b = JSON.parse(String(init.body)) as { pattern: string; script?: string };
        this.routes[idx] = { id: route[1], pattern: b.pattern, script: b.script ?? null };
        return cfOk(this.routes[idx]);
      }
      if (method === "DELETE") {
        this.routes.splice(idx, 1);
        return cfOk({ id: route[1] });
      }
    }
    if (p === "/zones/zone1/dns_records" && method === "GET") {
      const name = u.searchParams.get("name");
      return cfOk(this.dns.filter((d) => d.name === name).map((d) => ({ ...d })));
    }
    if (p === "/zones/zone1/dns_records" && method === "POST") {
      const b = JSON.parse(String(init.body)) as Omit<DnsRec, "id">;
      const rec = { id: `dns${this.nextId++}`, ...b };
      this.dns.push(rec);
      return cfOk(rec);
    }
    const dns = p.match(/^\/zones\/zone1\/dns_records\/(.+)$/);
    if (dns) {
      const idx = this.dns.findIndex((d) => d.id === dns[1]);
      if (idx < 0) return resp(404, JSON.stringify({ success: false, errors: [{ message: "nf" }] }));
      if (method === "PATCH") {
        this.dns[idx] = { ...this.dns[idx], ...(JSON.parse(String(init.body)) as Partial<DnsRec>) };
        return cfOk(this.dns[idx]);
      }
      if (method === "DELETE") {
        this.dns.splice(idx, 1);
        return cfOk({ id: dns[1] });
      }
    }
    return resp(599, `unhandled ${method} ${url}`);
  };

  mutations(): CallLog[] {
    return this.calls.filter((c) => c.url.startsWith("https://api.cloudflare.com") && c.method !== "GET");
  }
}

export type RunCall = { cmd: string; cwd?: string };

export class FakeSandbox implements SandboxExec {
  runs: RunCall[] = [];
  files = new Map<string, Buffer | string>();
  configFiles: string[] = ["package.json", "next.config.mjs"];
  fail: Partial<Record<"archive" | "npm" | "build" | "list", SandboxRunResult>> = {};
  grepHits = "";
  lsFiles = "";

  async run(cmd: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<SandboxRunResult> {
    this.runs.push({ cmd, cwd: opts.cwd });
    const ok = (stdout = ""): SandboxRunResult => ({ exitCode: 0, stdout, stderr: "" });
    if (cmd.includes("git -C /home/user/repo archive")) return this.fail.archive ?? ok();
    if (cmd === "ls -1a") return ok([".", "..", ...this.configFiles].join("\n"));
    if (cmd.startsWith("npm ci")) return this.fail.npm ?? ok();
    if (cmd.includes("next build")) return this.fail.build ?? ok();
    if (cmd.startsWith("test -d out")) {
      if (this.fail.list) return this.fail.list;
      const prefix = `${opts.cwd}/out/`;
      const listed = [...this.files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
      return ok(listed.join("\n") + "\n");
    }
    if (cmd.startsWith("grep -rlE")) return ok(this.grepHits);
    if (cmd === "git ls-files") return ok(this.lsFiles);
    return ok();
  }

  async readFile(path: string): Promise<Buffer | string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT ${path}`);
    return v;
  }
}
