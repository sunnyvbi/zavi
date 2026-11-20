import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadReal } from "./paths.mjs";

export const isDev = (base) => base.startsWith("dev:");

function wrap(status, headers, text) {
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status, headers, text, json, code: json?.error?.code ?? null };
}

const devSites = new Map();

export async function connect(base, opts = {}) {
  const real = await loadReal();
  if (!isDev(base)) {
    const u = new URL(base);
    if (u.protocol !== "https:" || u.pathname !== "/" || u.search || u.hash) throw new Error(`base must be https://<host> (got ${base})`);
    const origin = u.origin;
    const send = async (method, path, { headers = {}, body } = {}) => {
      const url = new URL(path, origin);
      const res = await fetch(url, { method, headers: { origin, ...headers }, body, redirect: "manual" });
      return res;
    };
    return {
      base, origin, real, dev: false,
      fetch: (url, init) => send(init.method, url, { headers: init.headers, body: init.body }),
      async raw(method, path, { headers = {}, body, token } = {}) {
        const h = { accept: "application/json", ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        let b = body;
        if (body !== undefined && typeof body !== "string" && !(body instanceof Blob) && !(body instanceof Uint8Array)) {
          b = JSON.stringify(body);
          h["content-type"] ??= "application/json";
        }
        const res = await send(method, path, { headers: h, body: b });
        return wrap(res.status, res.headers, await res.text());
      },
    };
  }

  const label = base.slice(4);
  if (!devSites.has(label)) {
    const manifestText = opts.manifestText ?? readFileSync(opts.manifestPath, "utf8");
    const checked = real.validateManifest(manifestText);
    if (!checked.ok) throw new Error(`dev site ${label}: manifest invalid: ${JSON.stringify(checked.issues)}`);
    const store = new real.DevStore({ manifest: checked.value, quotas: opts.devQuotas });
    const blobs = new Map();
    const admin = opts.devAdmin ?? { email: "admin@example.com", password: "dev-admin-password-1" };
    const siteId = randomUUID();
    const server = real.createLocalServer({
      store,
      siteId,
      seed: { users: [{ email: admin.email, password: admin.password, role: "admin" }] },
      persist: null,
      objectUrl: (body) => { const id = randomUUID(); blobs.set(id, body); return `/__dev_blob/${id}`; },
    });
    const origin = `https://${label}.dev.invalid`;
    const fetchLike = async (url, init) => {
      const p = new URL(url, origin);
      if (p.origin !== origin) throw new Error(`dev transport: off-site request ${p.origin}`);
      const m = /^\/__dev_blob\/([0-9a-f-]{36})$/.exec(p.pathname);
      if (m && init.method === "GET") {
        const b = blobs.get(m[1]);
        const text = b === undefined ? "" : typeof b === "string" ? b : await b.text();
        return { status: b === undefined ? 404 : 200, headers: { get: () => null }, text: async () => text };
      }
      return server.fetch(p.pathname + p.search, init);
    };
    devSites.set(label, { base, origin, siteId, admin, fetchLike });
  }
  const site = devSites.get(label);
  return {
    base, origin: site.origin, real, dev: true, devAdmin: site.admin,
    fetch: site.fetchLike,
    async raw(method, path, { headers = {}, body, token } = {}) {
      const h = { accept: "application/json", ...headers };
      if (token) h.authorization = `Bearer ${token}`;
      let b = body;
      if (body !== undefined && typeof body !== "string" && !(body instanceof Blob)) {
        b = JSON.stringify(body);
        h["content-type"] ??= "application/json";
      }
      const res = await site.fetchLike(path, { method, headers: h, body: b });
      return wrap(res.status, res.headers, await res.text());
    },
  };
}

export function client(conn) {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  return conn.real.createZavi({
    fetch: conn.fetch,
    origin: conn.origin,
    siteId: async () => {
      const r = await conn.raw("GET", "/api/site");
      if (r.status !== 200 || typeof r.json?.data?.site_id !== "string") throw new Error(`GET /api/site -> ${r.status} ${r.code ?? ""}`);
      return r.json.data.site_id;
    },
    storage,
    locks: null,
  });
}
