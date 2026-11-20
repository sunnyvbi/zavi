import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createLocalJWKSet, jwtVerify, SignJWT, type JWK } from "jose";
import type { Pool, PoolClient } from "pg";

export interface FrontOpts {
  gotrueUrl: string;
  postgrestUrl: string;
  pool: Pool;
  jwks: JWK[];
  apiKeys: string[];
}

export interface Front {
  url: string;
  close(): Promise<void>;
}

const ROLE_SQL: Record<string, string> = { anon: "anon", authenticated: "authenticated", service_role: "service_role" };

async function readBody(req: IncomingMessage, max = 12 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", ...headers, "content-length": String(buf.length) });
  res.end(buf);
}

function storageError(res: ServerResponse, logical: number, error: string, message: string): void {
  send(res, logical === 401 || logical === 403 ? 400 : logical === 404 ? 400 : logical, { statusCode: String(logical), error, message });
}

async function proxy(req: IncomingMessage, res: ServerResponse, base: string, rest: string): Promise<void> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k === "host" || k === "connection" || k === "content-length") continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const up = await fetch(`${base}${rest}`, { method: req.method, headers, body, redirect: "manual" });
  const out: Record<string, string> = {};
  up.headers.forEach((v, k) => {
    if (k !== "content-length" && k !== "content-encoding" && k !== "transfer-encoding" && k !== "connection") out[k] = v;
  });
  const buf = Buffer.from(await up.arrayBuffer());
  res.writeHead(up.status, { ...out, "content-length": String(buf.length) });
  res.end(buf);
}

export async function startFront(opts: FrontOpts): Promise<Front> {
  const jwks = createLocalJWKSet({ keys: opts.jwks });
  const urlSecret = new Uint8Array(randomBytes(32));
  const bytes = new Map<string, { data: Buffer; type: string }>();

  async function principal(req: IncomingMessage): Promise<{ role: string; claims: Record<string, unknown> } | null> {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
    if (!m) return null;
    try {
      const { payload } = await jwtVerify(m[1], jwks, { algorithms: ["ES256"] });
      const role = typeof payload.role === "string" ? ROLE_SQL[payload.role] : undefined;
      return role ? { role, claims: payload as Record<string, unknown> } : null;
    } catch {
      return null;
    }
  }

  async function asUser<T>(p: { role: string; claims: Record<string, unknown> }, fn: (c: PoolClient) => Promise<T>, commit = true): Promise<T> {
    const c = await opts.pool.connect();
    try {
      await c.query("begin");
      await c.query(`set local role ${p.role}`);
      await c.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', $3, true)", [
        JSON.stringify(p.claims), typeof p.claims.sub === "string" ? p.claims.sub : "", p.role,
      ]);
      const out = await fn(c);
      await c.query(commit ? "commit" : "rollback");
      return out;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async function signUrl(claims: Record<string, unknown>, ttlS: number): Promise<string> {
    return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${ttlS}s`).sign(urlSecret);
  }
  async function readUrlToken(token: string | null, want: string): Promise<Record<string, unknown> | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, urlSecret, { algorithms: ["HS256"] });
      return payload.url === want ? (payload as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  const ownerOf = (claims: Record<string, unknown>) =>
    typeof claims.sub === "string" && /^[0-9a-f-]{36}$/.test(claims.sub) ? claims.sub : null;

  async function storage(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
    const u = new URL(rest, "http://storage.local");
    const path = decodeURIComponent(u.pathname);
    let m: RegExpExecArray | null;
    const method = req.method ?? "GET";

    if ((m = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(path)) && method === "PUT") {
      const [, bucket, name] = m;
      const t = await readUrlToken(u.searchParams.get("token"), `${bucket}/${name}`);
      if (!t) return storageError(res, 400, "InvalidSignature", "invalid signature");
      const data = await readBody(req);
      const type = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();
      const c = await opts.pool.connect();
      try {
        const exists = (await c.query("select 1 from storage.objects where bucket_id = $1 and name = $2", [bucket, name])).rowCount;
        if (exists && t.upsert !== true) return storageError(res, 409, "Duplicate", "The resource already exists");
        await c.query(
          `insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3::text::uuid, $3::text, $4)
           on conflict (bucket_id, name) do update set metadata = excluded.metadata, updated_at = now()`,
          [bucket, name, t.owner ?? null, JSON.stringify({ size: data.length, mimetype: type })],
        );
      } finally {
        c.release();
      }
      bytes.set(`${bucket}/${name}`, { data, type });
      return send(res, 200, { Key: `${bucket}/${name}` });
    }
    if ((m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(path)) && method === "GET") {
      const [, bucket, name] = m;
      const t = await readUrlToken(u.searchParams.get("token"), `${bucket}/${name}`);
      if (!t) return storageError(res, 400, "InvalidSignature", "invalid signature");
      const b = bytes.get(`${bucket}/${name}`);
      if (!b) return storageError(res, 404, "not_found", "Object not found");
      res.writeHead(200, { "content-type": b.type, "content-length": String(b.data.length) });
      res.end(b.data);
      return;
    }

    const p = await principal(req);
    if (!p) return storageError(res, 403, "Unauthorized", "invalid jwt");

    if ((m = /^\/object\/list\/([^/]+)$/.exec(path)) && method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const prefix = String(body.prefix ?? "");
      const limit = Math.min(1000, Number(body.limit ?? 100));
      const offset = Number(body.offset ?? 0);
      const like = prefix.replace(/[\\%_]/g, (x) => `\\${x}`) + "%";
      const rows = await asUser(p, async (c) => (await c.query(
        `select name, id, metadata, created_at, updated_at from storage.objects
          where bucket_id = $1 and name like $2 escape '\\' order by created_at desc, name limit $3 offset $4`,
        [m![1], like, limit, offset],
      )).rows);
      return send(res, 200, rows
        .filter((r) => !String(r.name).slice(prefix.length).includes("/"))
        .map((r) => ({ ...r, name: String(r.name).slice(prefix.length) })));
    }
    if ((m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(path)) && method === "POST") {
      const [, bucket, name] = m;
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const ttl = Math.max(1, Math.min(604800, Number(body.expiresIn ?? 60)));
      const seen = await asUser(p, async (c) => (await c.query("select 1 from storage.objects where bucket_id = $1 and name = $2", [bucket, name])).rowCount);
      if (!seen) return storageError(res, 404, "not_found", "Object not found");
      const token = await signUrl({ url: `${bucket}/${name}` }, ttl);
      return send(res, 200, { signedURL: `/object/sign/${bucket}/${name}?token=${token}` });
    }
    if ((m = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(path)) && method === "POST") {
      const [, bucket, name] = m;
      await readBody(req);
      const upsert = String(req.headers["x-upsert"] ?? "") === "true";
      const owner = ownerOf(p.claims);
      try {
        await asUser(p, async (c) => {
          const exists = (await c.query("select 1 from storage.objects where bucket_id = $1 and name = $2", [bucket, name])).rowCount;
          if (exists && upsert) {
            const r = await c.query("update storage.objects set updated_at = now() where bucket_id = $1 and name = $2", [bucket, name]);
            if (!r.rowCount) throw Object.assign(new Error("new row violates row-level security policy"), { code: "42501" });
          } else {
            await c.query("insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3::text::uuid, $3::text, '{}')", [bucket, name, owner]);
          }
        }, false);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "42501") return storageError(res, 403, "Unauthorized", "new row violates row-level security policy");
        if (code === "23505") return storageError(res, 409, "Duplicate", "The resource already exists");
        throw e;
      }
      const token = await signUrl({ url: `${bucket}/${name}`, owner: owner ?? undefined, upsert }, 7200);
      return send(res, 200, { url: `/object/upload/sign/${bucket}/${name}?token=${token}`, token });
    }
    if ((m = /^\/object\/([^/]+)\/(.+)$/.exec(path)) && method === "DELETE") {
      const [, bucket, name] = m;
      const n = await asUser(p, async (c) => (await c.query("delete from storage.objects where bucket_id = $1 and name = $2 returning name", [bucket, name])).rowCount);
      if (!n) return storageError(res, 404, "not_found", "Object not found");
      bytes.delete(`${bucket}/${name}`);
      return send(res, 200, { message: "Successfully deleted" });
    }
    if ((m = /^\/object\/([^/]+)$/.exec(path)) && method === "DELETE") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const names = Array.isArray(body.prefixes) ? body.prefixes.map(String) : [];
      const rows = await asUser(p, async (c) => (await c.query(
        "delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning name, id, metadata",
        [m![1], names],
      )).rows);
      for (const r of rows) bytes.delete(`${m![1]}/${r.name}`);
      return send(res, 200, rows);
    }
    return storageError(res, 404, "not_found", "route not found");
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = req.url ?? "/";
      if (raw === "/auth/v1/.well-known/jwks.json" && req.method === "GET") return proxy(req, res, opts.gotrueUrl, "/.well-known/jwks.json");
      const signedUrl = (req.method === "GET" && raw.startsWith("/storage/v1/object/sign/"))
        || (req.method === "PUT" && raw.startsWith("/storage/v1/object/upload/sign/"));
      const key = String(req.headers.apikey ?? "");
      if (!signedUrl && !opts.apiKeys.includes(key)) return send(res, 401, { message: "Invalid API key" });
      if (raw.startsWith("/auth/v1/")) return proxy(req, res, opts.gotrueUrl, raw.slice("/auth/v1".length));
      if (raw.startsWith("/rest/v1/")) return proxy(req, res, opts.postgrestUrl, raw.slice("/rest/v1".length));
      if (raw.startsWith("/storage/v1/")) return storage(req, res, raw.slice("/storage/v1".length));
      return send(res, 404, { message: "no route" });
    })().catch((e) => {
      if (process.env.ZSI_DEBUG) console.error(`[zsi front] ${req.method} ${req.url}: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, { message: String((e as Error).message).slice(0, 200) });
      else res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

