import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { importJWK, SignJWT, type JWK } from "jose";
import { applyQuotaOverrides } from "../../site-settings";
import { LIMITS } from "@/services/site-auth/broker";
import type { ShardSql } from "../../contract";
import { api, claims, newIdem, sessionFromLocation, waitForMail, type ApiResult, type SiteWorld, type World } from "./world";
import type { ShardTarget } from "./target";

export interface Attack {
  id: string;
  title: string;
  hermeticOnly?: boolean;
  run(w: World): Promise<void>;
}

export class CrossSiteBreach extends Error {
  constructor(id: string, detail: string) {
    super(`CROSS-SITE BREACH [${id}]: ${detail}`);
    this.name = "CrossSiteBreach";
  }
}

export class ControlFailed extends Error {
  constructor(id: string, detail: string) {
    super(`control failed [${id}]: ${detail}`);
    this.name = "ControlFailed";
  }
}

const j = (x: unknown) => JSON.stringify(x ?? null).slice(0, 400);

function markers(v: SiteWorld): string[] {
  return [
    v.siteId, ...Object.values(v.ids), v.member.uid, v.admin.uid, v.member.email, v.admin.email, v.file.bytes,
    ...(v.shared ? [v.shared.uid] : []),
    `secret note of ${v.spec.key}`, `post on ${v.spec.key}`, `request on ${v.spec.key}`,
  ];
}

function assertNoLeak(id: string, what: string, r: { body: unknown; headers?: Headers } | string, victim: SiteWorld): void {
  let text = typeof r === "string" ? r : JSON.stringify(r.body ?? "");
  if (typeof r !== "string" && r.headers) r.headers.forEach((v, k) => (text += `\n${k}: ${v}`));
  const hit = markers(victim).filter((m) => m && text.includes(m));
  if (hit.length) throw new CrossSiteBreach(id, `${what} leaked ${victim.spec.key}'s ${hit.length} identifier(s): ${text.slice(0, 300)}`);
}

function denied(id: string, what: string, r: ApiResult, victim: SiteWorld, statuses: number[], code?: string | string[]): void {
  if (r.status >= 200 && r.status < 300) throw new CrossSiteBreach(id, `${what} succeeded: ${r.status} ${j(r.body)}`);
  assertNoLeak(id, what, r, victim);
  if (!statuses.includes(r.status)) throw new ControlFailed(id, `${what}: refused but with ${r.status} (expected ${statuses.join("/")}): ${j(r.body)}`);
  if (code !== undefined) {
    const want = Array.isArray(code) ? code : [code];
    const got = r.body?.error?.code;
    if (!want.includes(got)) throw new ControlFailed(id, `${what}: refused with code ${got} (expected ${want.join("/")})`);
  }
}

function control(id: string, what: string, r: ApiResult, statuses = [200, 201]): any {
  if (!statuses.includes(r.status)) throw new ControlFailed(id, `${what}: ${r.status} ${j(r.body)}`);
  return r.body?.data ?? r.body;
}

async function rpc(w: World, shard: ShardTarget, token: string | null, fn: string, args: Record<string, unknown>): Promise<ApiResult> {
  const headers: Record<string, string> = { "content-type": "application/json", "content-profile": "api", "accept-profile": "api" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await w.edge.direct(shard, `/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
  }
  return { status: res.status, body, headers: res.headers };
}

async function storageDirect(w: World, shard: ShardTarget, token: string, path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
  const res = await w.edge.direct(shard, `/storage/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

function storageRefused(id: string, what: string, r: ApiResult, victim: SiteWorld): void {
  assertNoLeak(id, what, r, victim);
  if (r.status < 300) throw new CrossSiteBreach(id, `${what}: ${r.status} ${j(r.body)}`);
  if (r.status < 400 || r.status >= 500) throw new ControlFailed(id, `${what}: Storage answered ${r.status}, not a 4xx refusal`);
}

function storageEmpty(id: string, what: string, r: ApiResult, victim: SiteWorld): void {
  assertNoLeak(id, what, r, victim);
  if (r.status < 300) {
    if (!Array.isArray(r.body)) throw new ControlFailed(id, `${what}: 2xx without a list: ${j(r.body)}`);
    if (r.body.length) throw new CrossSiteBreach(id, `${what} returned ${r.body.length} of ${victim.spec.key}'s objects`);
    return;
  }
  if (r.status < 400 || r.status >= 500) throw new ControlFailed(id, `${what}: Storage answered ${r.status}, not a 4xx refusal`);
}

function rpcDenied(id: string, what: string, r: ApiResult, victim: SiteWorld, kind: "one" | "list" = "one"): void {
  assertNoLeak(id, what, r, victim);
  if (kind === "one" && r.status >= 200 && r.status < 300) {
    const b = r.body;
    const zero = b && typeof b === "object" && ((b as { count?: unknown }).count === 0 || (b as { value?: unknown }).value === 0);
    if (!(b === null || b === false || zero)) {
      throw new CrossSiteBreach(id, `${what} returned data: ${j(b)}`);
    }
  }
}

async function victimState(w: World, v: SiteWorld): Promise<string> {
  const recs = await w.sql(v.shard, "select collection, id, owner_id, data, state from zsite.records where site_id = $1 order by collection, id", [v.siteId]);
  const members = await w.sql(v.shard, "select user_id, role, status from zsite.members where site_id = $1 order by user_id", [v.siteId]);
  const idents = await w.sql(v.shard, "select auth_user_id, state from zsite.identities where site_id = $1 order by auth_user_id", [v.siteId]);
  const files = await w.sql(v.shard, "select name, owner_id, metadata from storage.objects where bucket_id = 'site-files' and name like $1 order by name", [`${v.siteId}/%`]);
  const users = await w.sql(v.shard, `select u.id, u.email, u.encrypted_password, u.email_confirmed_at, u.banned_until, u.deleted_at, u.raw_app_meta_data
      from auth.users u join zsite.identities i on i.auth_user_id = u.id where i.site_id = $1 order by u.id`, [v.siteId]);
  const epochs = await w.sql(v.shard, "select user_id, valid_after from zsite_auth.session_epochs where site_id = $1 order by user_id", [v.siteId]);
  const quotas = await w.sql(v.shard, "select to_jsonb(q) - 'updated_at' as q from zsite.quotas q where site_id = $1", [v.siteId]);
  return JSON.stringify({ recs, members, idents, files, users, epochs, quotas });
}

async function unchanged(id: string, w: World, v: SiteWorld, before: string, after: string): Promise<void> {
  if (before !== after) throw new CrossSiteBreach(id, `${v.spec.key}'s data changed: before ${before.slice(0, 300)} | after ${after.slice(0, 300)}`);
}

async function guarded(id: string, w: World, v: SiteWorld, fn: () => Promise<void>): Promise<void> {
  const before = await victimState(w, v);
  await fn();
  await unchanged(id, w, v, before, await victimState(w, v));
}

const shardSqlOf = (w: World, sh: ShardTarget): ShardSql => ({
  async query(_ref, q) {
    return w.sql(sh, q);
  },
});

async function login(w: World, v: SiteWorld, who: "member" | "shared"): Promise<{ access_token: string; refresh_token: string }> {
  const email = who === "member" ? v.member.email : v.shared!.email;
  const r = await api(w.edge, v.host, "/api/auth/login", { body: { email, password: v.passwords[who] } });
  const d = control("login", `${who} login on ${v.spec.key}`, r);
  return d.session;
}

async function forge(priv: JWK, kid: string, payload: Record<string, unknown>, alg: "ES256" | "HS256" = "ES256", secret?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now - 5, exp: now + 300, ...payload };
  if (alg === "HS256") return new SignJWT(body).setProtectedHeader({ alg: "HS256", kid, typ: "JWT" }).sign(new TextEncoder().encode(secret));
  return new SignJWT(body).setProtectedHeader({ alg: "ES256", kid, typ: "JWT" }).sign(await importJWK(priv, "ES256"));
}

function b64urlJson(x: unknown): string {
  return Buffer.from(JSON.stringify(x)).toString("base64url");
}

const WRONG_SITE: Record<Victim, string> = { B: "session_wrong_site", C: "invalid_session" };
type Victim = "B" | "C";
const victims = (make: (vk: Victim) => Attack): Attack[] => [make("B"), make("C")];

export const ATTACKS: Attack[] = [
  ...victims((vk) => ({
    id: `H1-${vk}`,
    title: `A's session on ${vk}'s hostname is refused on every data, kernel, file and member route`,
    async run(w) {
      const A = w.A;
      const B = w[vk];
      const t = A.member.access_token;
      const ta = A.admin.access_token;
      const own = control("H1", "B's member lists B's notes", await api(w.edge, B.host, "/api/data/notes", { token: B.member.access_token }));
      if (!JSON.stringify(own).includes(B.ids.note)) throw new ControlFailed("H1", "B's own note missing from B's list");
      await guarded("H1", w, B, async () => {
        const calls: Array<[string, string, Parameters<typeof api>[3]]> = [
          ["list notes", "/api/data/notes", { token: t }],
          ["get B note", `/api/data/notes/${B.ids.note}`, { token: t }],
          ["create note", "/api/data/notes", { token: t, body: { data: { title: "x" } } }],
          ["update B note", `/api/data/notes/${B.ids.note}`, { token: ta, method: "PATCH", body: { patch: { title: "pwned" } } }],
          ["delete B note", `/api/data/notes/${B.ids.note}`, { token: ta, method: "DELETE" }],
          ["transition B listing", `/api/data/listings/${B.ids.listing}/transition`, { token: ta, body: { to: "archived" } }],
          ["reserve B slot", "/api/actions/reserve_slot", { token: t, body: { target_id: B.ids.slot }, idem: newIdem() }],
          ["cancel B booking", "/api/actions/cancel_slot", { token: ta, body: { record_id: B.ids.booking }, idem: newIdem() }],
          ["aggregate", "/api/aggregates/booking_count", { token: ta, body: { filter: { slot_id: B.ids.slot } } }],
          ["list files", "/api/storage/uploads/list", { token: ta }],
          ["download-url B file", "/api/storage/uploads/download-url", { token: ta, body: { name: B.file.name } }],
          ["upload-url", "/api/storage/uploads/upload-url", { token: t, body: { name: B.file.name, content_type: "text/plain", size: 4, upsert: true } }],
          ["delete B file", `/api/storage/uploads/${B.file.name}`, { token: ta, method: "DELETE" }],
          ["members list", "/api/members/list", { token: ta }],
          ["members set-role", "/api/members/set-role", { token: ta, body: { user_id: B.member.uid, role: "admin" } }],
          ["members remove", "/api/members/remove", { token: ta, body: { user_id: B.admin.uid } }],
        ];
        for (const [what, path, o] of calls) denied("H1", what, await api(w.edge, B.host, path, o), B, [401], WRONG_SITE[vk]);
      });
    },
  })),
  {
    id: "H2",
    title: "spoofed site headers, params and body fields never move a request to another site",
    async run(w) {
      const { A, B } = w;
      const spoof = {
        "x-forwarded-host": B.host, "x-original-host": B.host, forwarded: `host=${B.host}`, "x-zavi-site": B.siteId,
        "x-zavi-gw-site-id": B.siteId, "x-zavi-gw-host": B.host, "x-zavi-gw-shard-id": B.shard.ref, "x-host": B.host,
      };
      const list = await api(w.edge, A.host, "/api/data/notes", { token: A.admin.access_token, headers: spoof });
      const mine = control("H2", "A's admin lists A's notes with spoofed headers", list);
      if (!JSON.stringify(mine).includes(A.ids.note)) throw new ControlFailed("H2", "A's note missing (spoof headers changed the site?)");
      assertNoLeak("H2", "list with spoofed headers", list, B);
      denied("H2", "get B note with spoofed headers", await api(w.edge, A.host, `/api/data/notes/${B.ids.note}`, { token: A.admin.access_token, headers: spoof }), B, [404], "not_found");
      for (const q of [`site_id=${B.siteId}`, `shard_id=${B.shard.ref}`, `host=${B.host}`]) {
        denied("H2", `list with ?${q.split("=")[0]}`, await api(w.edge, A.host, `/api/data/notes?${q}`, { token: A.admin.access_token }), B, [400]);
      }
      denied("H2", "create with site_id in the body", await api(w.edge, A.host, "/api/data/notes", {
        token: A.member.access_token, body: { data: { title: "x", site_id: B.siteId } },
      }), B, [400]);
      const posts = await api(w.edge, A.host, "/api/data/posts", { headers: spoof });
      control("H2", "anonymous list of A's posts", posts);
      assertNoLeak("H2", "anonymous list with spoofed headers", posts, B);
    },
  },
  {
    id: "H3",
    title: "hostname spelling (case, trailing dot, port, look-alike subdomains) cannot alias another site",
    async run(w) {
      const { A, B } = w;
      const t = A.member.access_token;
      for (const url of [`https://${B.host.toUpperCase()}/api/data/notes`, `https://${B.host}./api/data/notes`, `https://${B.host}:8443/api/data/notes`]) {
        const r = await w.edge.gw(B.host, "", { url, headers: { authorization: `Bearer ${t}` } });
        const body = await r.json().catch(() => null);
        denied("H3", `A's token at ${new URL(url).host}`, { status: r.status, body, headers: r.headers }, B, [401], "session_wrong_site");
      }
      for (const host of [`${A.host}.${B.host}`, `x${B.host}`, `${B.host}.evil.test`, B.host.replace(/^zsi-b-/, "zsi-b0-")]) {
        const r = await api(w.edge, host, "/api/data/notes", { token: t });
        denied("H3", `unbound ${host}`, r, B, [404], "site_not_found");
      }
    },
  },
  {
    id: "H4",
    title: "a browser request from another site's origin is refused before any shard call",
    async run(w) {
      const { A, B } = w;
      const r = await api(w.edge, B.host, "/api/data/posts", { headers: { origin: `https://${A.host}` } });
      denied("H4", "cross-origin read", r, B, [403], "cross_origin_forbidden");
      const pre = await w.edge.gw(B.host, "/api/data/notes", { method: "OPTIONS", headers: { origin: `https://${A.host}`, "access-control-request-method": "POST" } });
      if (pre.status !== 403 || pre.headers.get("access-control-allow-origin")) throw new CrossSiteBreach("H4", `preflight from A's origin answered ${pre.status}`);
      denied("H4", "same-site fetch metadata", await api(w.edge, B.host, "/api/data/posts", { headers: { "sec-fetch-site": "same-site" } }), B, [403], "cross_origin_forbidden");
      const ok = await w.edge.gw(B.host, "/api/data/notes", { method: "OPTIONS", headers: { origin: `https://${B.host}`, "access-control-request-method": "POST" } });
      if (ok.status !== 204) throw new ControlFailed("H4", `B's own preflight: ${ok.status}`);
    },
  },

  {
    id: "H5",
    title: "a replayed session cookie authenticates nothing: only the bearer header counts",
    async run(w) {
      const { A, B } = w;
      const jar = [
        `sb-access-token=${A.admin.access_token}`, `sb-${A.shard.ref}-auth-token=${encodeURIComponent(JSON.stringify([A.admin.access_token, A.admin.refresh_token]))}`,
        `zavi_session=${A.admin.access_token}`, `access_token=${A.admin.access_token}`,
      ].join("; ");
      for (const [host, victim] of [[B.host, B], [w.C.host, w.C], [A.host, B]] as const) {
        const notes = await api(w.edge, host, "/api/data/notes", { headers: { cookie: jar } });
        const items = control("H5", `notes with only A's cookies on ${host}`, notes)?.items;
        if (!Array.isArray(items) || items.length) throw new CrossSiteBreach("H5", `a cookie authenticated a notes list on ${host}: ${j(notes.body)}`);
        assertNoLeak("H5", "notes with cookies", notes, victim);
        denied("H5", `members with only A's cookies on ${host}`, await api(w.edge, host, "/api/members/list", { headers: { cookie: jar } }), victim, [401], "sign_in_required");
        denied("H5", `logout with only A's cookies on ${host}`, await api(w.edge, host, "/api/auth/logout", { headers: { cookie: jar }, body: { scope: "global" } }), victim, [401], "unauthorized");
      }
    },
  },

  {
    id: "T1",
    title: "A's access token straight at the shard's Data API cannot read or change B's records",
    async run(w) {
      const { A, B } = w;
      const sh = B.shard;
      const own = await rpc(w, sh, B.member.access_token, "get_record", { p_collection: "notes", p_id: B.ids.note });
      if (own.status !== 200 || !JSON.stringify(own.body).includes(B.ids.note)) throw new ControlFailed("T1", `B's member reads B's note directly: ${own.status} ${j(own.body)}`);
      await guarded("T1", w, B, async () => {
        for (const tok of [A.member.access_token, A.admin.access_token]) {
          rpcDenied("T1", "get_record B note", await rpc(w, sh, tok, "get_record", { p_collection: "notes", p_id: B.ids.note }), B);
          rpcDenied("T1", "get_record B post", await rpc(w, sh, tok, "get_record", { p_collection: "posts", p_id: B.ids.post }), B);
          rpcDenied("T1", "get_record B listing", await rpc(w, sh, tok, "get_record", { p_collection: "listings", p_id: B.ids.listing }), B);
          rpcDenied("T1", "list notes", await rpc(w, sh, tok, "list_records", { p_collection: "notes", p_filter: {}, p_limit: 100, p_cursor: null, p_sort: null }), B, "list");
          rpcDenied("T1", "list posts", await rpc(w, sh, tok, "list_records", { p_collection: "posts", p_filter: {}, p_limit: 100, p_cursor: null, p_sort: null }), B, "list");
          rpcDenied("T1", "update B note", await rpc(w, sh, tok, "update_record", { p_collection: "notes", p_id: B.ids.note, p_patch: { title: "pwned" } }), B);
          rpcDenied("T1", "delete B note", await rpc(w, sh, tok, "delete_record", { p_collection: "notes", p_id: B.ids.note }), B);
          rpcDenied("T1", "transition B listing", await rpc(w, sh, tok, "transition_record", { p_collection: "listings", p_id: B.ids.listing, p_to: "archived" }), B);
          rpcDenied("T1", "reserve B slot", await rpc(w, sh, tok, "run_action", { p_action: "reserve_slot", p_target_id: B.ids.slot, p_record_id: null, p_data: {}, p_idempotency_key: newIdem() }), B);
          rpcDenied("T1", "cancel B booking", await rpc(w, sh, tok, "run_action", { p_action: "cancel_slot", p_target_id: null, p_record_id: B.ids.booking, p_data: {}, p_idempotency_key: newIdem() }), B);
          rpcDenied("T1", "aggregate B slot", await rpc(w, sh, tok, "aggregate", { p_name: "booking_count", p_filter: { slot_id: B.ids.slot } }), B);
          const sv = await rpc(w, sh, tok, "session_valid_for", { p_sub: B.member.uid, p_started: 0 });
          if (sv.body === true) throw new CrossSiteBreach("T1", "session_valid_for vouched for B's member under A's token");
        }
        const made = await rpc(w, sh, A.member.access_token, "create_record", { p_collection: "notes", p_data: { title: "steer" }, p_idempotency_key: null });
        const mid = made.body?.id;
        if (typeof mid === "string") {
          const where = await w.sql(sh, "select site_id from zsite.records where id = $1", [mid]);
          if (where[0]?.site_id !== A.siteId) throw new CrossSiteBreach("T1", `a create under A's token landed on ${where[0]?.site_id}`);
          await w.sql(sh, "delete from zsite.records where id = $1", [mid]);
        }
      });
    },
  },
  {
    id: "T2",
    title: "A's anonymous token (exactly as the signer mints it) sees none of B, not even B's public posts",
    async run(w) {
      const { A, B } = w;
      const mint = async (site: SiteWorld) => {
        const r = await w.edge.signer({ shard_id: site.shard.ref, site_id: site.siteId });
        const b = (await r.json()) as { token?: string };
        if (r.status !== 200 || !b.token) throw new ControlFailed("T2", `signer mint: ${r.status}`);
        return b.token;
      };
      const anonA = await mint(A);
      const anonB = await mint(B);
      const own = await rpc(w, B.shard, anonB, "get_record", { p_collection: "posts", p_id: B.ids.post });
      if (own.status !== 200 || !JSON.stringify(own.body).includes(B.ids.post)) throw new ControlFailed("T2", `B's anon reads B's post: ${own.status} ${j(own.body)}`);
      const listA = await rpc(w, A.shard, anonA, "list_records", { p_collection: "posts", p_filter: {}, p_limit: 100, p_cursor: null, p_sort: null });
      if (!JSON.stringify(listA.body).includes(A.ids.post)) throw new ControlFailed("T2", "A's anon token does not list A's own post");
      rpcDenied("T2", "A anon get B post", await rpc(w, B.shard, anonA, "get_record", { p_collection: "posts", p_id: B.ids.post }), B);
      rpcDenied("T2", "A anon list posts", await rpc(w, B.shard, anonA, "list_records", { p_collection: "posts", p_filter: {}, p_limit: 100, p_cursor: null, p_sort: null }), B, "list");
      rpcDenied("T2", "A anon list listings", await rpc(w, B.shard, anonA, "list_records", { p_collection: "listings", p_filter: {}, p_limit: 100, p_cursor: null, p_sort: null }), B, "list");
      rpcDenied("T2", "no token at all", await rpc(w, B.shard, null, "get_record", { p_collection: "posts", p_id: B.ids.post }), B);
    },
  },
  ...victims((vk) => ({
    id: `T3-${vk}`,
    title: `A's refresh token cannot mint a session on ${vk}'s hostname`,
    async run(w) {
      const A = w.A;
      const B = w[vk];
      const s = await login(w, A, "member");
      const r = await api(w.edge, B.host, "/api/auth/refresh", { body: { refresh_token: s.refresh_token } });
      denied("T3", "refresh on B", r, B, [401], "unauthorized");
      if (JSON.stringify(r.body).includes("access_token")) throw new CrossSiteBreach("T3", "a session came back");
      const vs = await login(w, B, "member");
      const vr = control("T3", `${B.spec.key}'s own refresh`, await api(w.edge, B.host, "/api/auth/refresh", { body: { refresh_token: vs.refresh_token } }));
      if (claims(vr.session.access_token).site_id !== B.siteId) throw new ControlFailed("T3", "the victim's refresh minted another site's token");
      const again = await login(w, A, "member");
      const ok = await api(w.edge, A.host, "/api/auth/refresh", { body: { refresh_token: again.refresh_token } });
      const d = control("T3", "A's refresh on A", ok);
      if (claims(d.session.access_token).site_id !== A.siteId) throw new ControlFailed("T3", "A's refresh minted a token for another site");
    },
  })),
  ...victims((vk) => ({
    id: `T4-${vk}`,
    title: `A's session cannot drive ${vk}'s account routes (password, email, delete, logout) through ${vk}'s hostname`,
    async run(w) {
      const A = w.A;
      const B = w[vk];
      const s = await login(w, A, "shared");
      await guarded("T4", w, B, async () => {
        for (const [what, path, body] of [
          ["password", "/api/auth/password", { password: "attacker-chosen-1" }],
          ["email", "/api/auth/email", { new_email: `attacker-${randomUUID().slice(0, 6)}@zsi-gate.test` }],
          ["delete", "/api/auth/delete", {}],
          ["logout global", "/api/auth/logout", { scope: "global" }],
        ] as const) {
          denied("T4", what, await api(w.edge, B.host, path, { token: s.access_token, body }), B, [401], "unauthorized");
        }
      });
      const own = await login(w, B, "member");
      control("T4", `${B.spec.key}'s own logout`, await api(w.edge, B.host, "/api/auth/logout", { token: own.access_token, body: {} }));
      if (B.shared) await login(w, B, "shared");
    },
  })),
  {
    id: "T5",
    title: "the same email on A and B is two accounts: A's password never signs in on B",
    async run(w) {
      const { A, B } = w;
      const r = await api(w.edge, B.host, "/api/auth/login", { body: { email: A.shared!.email, password: A.passwords.shared } });
      denied("T5", "A's password on B", r, B, [401], "invalid_credentials");
      const onA = await login(w, A, "shared");
      const onB = await login(w, B, "shared");
      const ca = claims(onA.access_token);
      const cb = claims(onB.access_token);
      if (ca.site_id !== A.siteId || cb.site_id !== B.siteId) throw new ControlFailed("T5", "sessions carry the wrong site");
      if (ca.sub === cb.sub) throw new CrossSiteBreach("T5", "one auth user serves the same email on two sites");
    },
  },
  {
    id: "T6",
    title: "tokens never cross the shard boundary to or from the dedicated kernel site C",
    async run(w) {
      const { A, B, C } = w;
      const own = await api(w.edge, C.host, "/api/data/notes", { token: C.member.access_token });
      if (!JSON.stringify(control("T6", "C's member on C", own)).includes(C.ids.note)) throw new ControlFailed("T6", "C's note missing");
      await guarded("T6", w, C, async () => {
        for (const tok of [A.member.access_token, A.admin.access_token, B.admin.access_token]) {
          denied("T6", "pooled token on C's hostname", await api(w.edge, C.host, "/api/data/notes", { token: tok }), C, [401], "invalid_session");
          denied("T6", "pooled token on C's members", await api(w.edge, C.host, "/api/members/list", { token: tok }), C, [401], "invalid_session");
          const d = await rpc(w, C.shard, tok, "list_records", { p_collection: "notes", p_filter: {}, p_limit: 100, p_cursor: null, p_sort: null });
          if (d.status < 400) throw new CrossSiteBreach("T6", `C's Data API accepted a pooled token: ${d.status} ${j(d.body)}`);
          assertNoLeak("T6", "C's Data API", d, C);
        }
      });
      denied("T6", "C's token on A's hostname", await api(w.edge, A.host, "/api/data/notes", { token: C.admin.access_token }), A, [401], "invalid_session");
      const toPooled = await rpc(w, A.shard, C.admin.access_token, "list_records", { p_collection: "notes", p_filter: {}, p_limit: 100, p_cursor: null, p_sort: null });
      if (toPooled.status < 400) throw new CrossSiteBreach("T6", `the pooled Data API accepted C's token: ${toPooled.status}`);
      const r = await w.edge.signer({ shard_id: C.shard.ref, site_id: A.siteId });
      const tok = ((await r.json()) as { token: string }).token;
      rpcDenied("T6", "kernel anon token naming A", await rpc(w, C.shard, tok, "list_records", { p_collection: "posts", p_filter: {}, p_limit: 100, p_cursor: null, p_sort: null }), C, "list");
    },
  },
  {
    id: "T7",
    title: "forged, re-signed and algorithm-confused tokens are refused at the gateway and the shard",
    async run(w) {
      const { A, B } = w;
      const real = A.admin.access_token;
      const [h, p, s] = real.split(".");
      const header = JSON.parse(Buffer.from(h, "base64url").toString());
      const rogue = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const rogueJwk = rogue.privateKey.export({ format: "jwk" }) as JWK;
      const asB = { ...claims(real), site_id: B.siteId, site_role: "admin", sub: B.admin.uid, role: "authenticated" };
      const tokens: Record<string, string> = {
        "rogue key, real kid": await forge(rogueJwk, header.kid, asB),
        "payload swapped, real signature": `${h}.${b64urlJson(asB)}.${s}`,
        "alg none": `${b64urlJson({ alg: "none", typ: "JWT" })}.${b64urlJson(asB)}.`,
        "HS256 keyed with the publishable key": await forge(rogueJwk, header.kid, asB, "HS256", B.shard.publishableKey),
        "HS256 keyed with the service key": await forge(rogueJwk, header.kid, asB, "HS256", B.shard.serviceKey),
        "service_role claim, rogue key": await forge(rogueJwk, header.kid, { role: "service_role", site_id: B.siteId }),
      };
      for (const site of [A, B]) {
        const r = await w.edge.signer({ shard_id: site.shard.ref, site_id: site.siteId });
        const anon = ((await r.json()) as { token: string }).token;
        if (JSON.parse(Buffer.from(anon.split(".")[0], "base64url").toString()).kid !== header.kid) {
          throw new ControlFailed("T7", "the signer and Auth do not share the shard's current key (the production key model)");
        }
        denied("T7", `${site.spec.key}'s anon token as a bearer on B`, await api(w.edge, B.host, "/api/data/notes", { token: anon }), B, [401], "invalid_session");
        denied("T7", `${site.spec.key}'s anon token on B's members`, await api(w.edge, B.host, "/api/members/list", { token: anon }), B, [401], "invalid_session");
      }
      await guarded("T7", w, B, async () => {
        for (const [what, tok] of Object.entries(tokens)) {
          denied("T7", `${what} at B's hostname`, await api(w.edge, B.host, "/api/data/notes", { token: tok }), B, [401], "invalid_session");
          denied("T7", `${what} at B's members`, await api(w.edge, B.host, "/api/members/list", { token: tok }), B, [401], "invalid_session");
          storageRefused("T7", `${what}: Storage sign`, await storageDirect(w, B.shard, tok, `object/sign/site-files/${B.siteId}/uploads/${B.file.name}`, "POST", { expiresIn: 60 }), B);
          const d = await rpc(w, B.shard, tok, "list_records", { p_collection: "notes", p_filter: {}, p_limit: 100, p_cursor: null, p_sort: null });
          if (d.status < 400) throw new CrossSiteBreach("T7", `${what}: the shard Data API accepted it (${d.status} ${j(d.body)})`);
          storageRefused("T7", `${what}: Storage list`, await storageDirect(w, B.shard, tok, "object/list/site-files", "POST", { prefix: `${B.siteId}/uploads/`, limit: 100, offset: 0 }), B);
        }
      });
    },
  },

  {
    id: "T8",
    title: "calling the shard's Auth directly (bypassing the broker) never yields a token for another site",
    async run(w) {
      const { A, B } = w;
      const auth = async (path: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
        const res = await w.edge.direct(B.shard, `/auth/v1${path}`, {
          method: init.method ?? (init.body === undefined ? "GET" : "POST"),
          headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        const text = await res.text();
        let body: any = text;
        try {
          body = JSON.parse(text);
        } catch {
        }
        return { status: res.status, body, headers: res.headers } as ApiResult;
      };
      const onB = async (what: string, token: string) =>
        denied("T8", `${what} on B's hostname`, await api(w.edge, B.host, "/api/data/notes", { token }), B, [401], ["session_wrong_site", "invalid_session"]);
      await guarded("T8", w, B, async () => {
        const me = await auth("/user", { token: A.member.access_token });
        const alias = me.body?.email;
        if (me.status !== 200 || typeof alias !== "string") throw new ControlFailed("T8", `GET /user: ${me.status}`);
        const pw = await auth("/token?grant_type=password", { body: { email: alias, password: A.passwords.member } });
        if (pw.status !== 200) throw new ControlFailed("T8", `direct password sign-in for A's own account: ${pw.status}`);
        if (claims(pw.body.access_token).site_id !== A.siteId) throw new CrossSiteBreach("T8", "a direct sign-in minted a token for another site");
        await onB("direct password sign-in", pw.body.access_token);
        const put = await auth("/user", { method: "PUT", token: A.member.access_token, body: { data: { site_id: B.siteId, site_role: "admin" } } });
        if (put.status !== 200) throw new ControlFailed("T8", `metadata edit: ${put.status}`);
        const fresh = await login(w, A, "member");
        const c = claims(fresh.access_token);
        if (c.site_id !== A.siteId || c.site_role === "admin") throw new CrossSiteBreach("T8", `metadata changed the token: ${j(c)}`);
        await onB("token after metadata edit", fresh.access_token);
        const direct = `direct-${randomUUID().slice(0, 8)}@zsi-gate.test`;
        w.edge.strayAuthEmails.add(direct);
        const su = await auth("/signup", { body: { email: direct, password: "direct-signup-1" } });
        if (su.body?.access_token) await onB("direct sign-up session", su.body.access_token);
        const anon = await auth("/signup", { body: {} });
        if (anon.body?.access_token) await onB("anonymous sign-in session", anon.body.access_token);
        const ch = await auth("/user", { method: "PUT", token: A.member.access_token, body: { email: B.member.email } });
        if (process.env.ZSI_DEBUG) {
          const orphans = await w.sql(B.shard, "select count(*)::int as n from auth.users where email like 'direct-%'");
          console.log(`[zsi T8] direct signup ${su.status} (orphan auth users: ${orphans[0].n}), anonymous ${anon.status}, email change ${ch.status}`);
        }
        const now = await w.sql(A.shard, "select email from auth.users where id = $1", [A.member.uid]);
        if (now[0]?.email !== alias) throw new CrossSiteBreach("T8", `A's auth email changed to ${now[0]?.email} (status ${ch.status})`);
      });
    },
  },

  ...victims((vk) => ({
    id: `L1-${vk}`,
    title: `A's magic link opened on ${vk}'s hostname yields no session on ${vk}`,
    async run(w) {
      const A = w.A;
      const B = w[vk];
      const deps = { directory: w.edge.directory, aliasKey: w.edge.brokerDeps.aliasKey };
      const { siteOwnerMagicLink } = await import("@/services/site-auth/admin");
      const mk = async () => new URL(await siteOwnerMagicLink(deps, { shardId: A.shard.ref, siteId: A.siteId, email: A.admin.email, redirectTo: `https://${A.host}/` }));
      const link = await mk();
      if (link.hostname !== A.host) throw new CrossSiteBreach("L1", `A's link points at ${link.hostname}`);
      const land = await w.edge.gw(B.host, `${link.pathname}${link.search}`);
      if (sessionFromLocation(land.headers.get("location"))) throw new CrossSiteBreach("L1", "the landing hop returned a session");
      const r = await w.edge.gw(B.host, `${link.pathname}${link.search}&confirm=1`);
      const loc = r.headers.get("location") ?? "";
      if (sessionFromLocation(loc)) throw new CrossSiteBreach("L1", `B returned a session for A's link: ${loc.slice(0, 120)}`);
      if (r.status !== 303 || !/error=invalid_link/.test(loc)) throw new ControlFailed("L1", `expected a 303 to #error=invalid_link, got ${r.status} ${loc.slice(0, 120)}`);
      const fresh = await mk();
      const okr = await w.edge.gw(A.host, `${fresh.pathname}${fresh.search}&confirm=1`);
      const sess = sessionFromLocation(okr.headers.get("location"));
      if (!sess || claims(sess.access_token).site_id !== A.siteId) throw new ControlFailed("L1", "A's own link did not sign in to A");
    },
  })),
  {
    id: "L2",
    title: "A's signup confirmation link confirms nothing on B and stays usable on A",
    async run(w) {
      const { A, B } = w;
      const email = `late-${randomUUID().slice(0, 8)}@zsi-gate.test`;
      const before = w.edge.mails.length;
      control("L2", "signup on A", await api(w.edge, A.host, "/api/auth/signup", { body: { email }, turnstileHost: A.host }));
      const { link } = await waitForMail(w.edge, email, /confirm|verify|account/i, before);
      if (link.hostname !== A.host) throw new CrossSiteBreach("L2", `A's signup link points at ${link.hostname}`);
      const form = `type=signup&token_hash=${encodeURIComponent(link.searchParams.get("token_hash") ?? "")}`;
      const onB = await w.edge.gw(B.host, "/api/auth/confirm", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
      const locB = onB.headers.get("location") ?? "";
      if (sessionFromLocation(locB)) throw new CrossSiteBreach("L2", "B confirmed A's signup and returned a session");
      const ids = await w.sql(B.shard, "select count(*)::int as n from zsite.identities where site_id = $1 and email_norm = $2", [B.siteId, email]);
      if (ids[0].n) throw new CrossSiteBreach("L2", "B gained an identity from A's link");
      const onA = await w.edge.gw(A.host, "/api/auth/confirm", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
      const sess = sessionFromLocation(onA.headers.get("location"));
      if (!sess || claims(sess.access_token).site_id !== A.siteId) throw new ControlFailed("L2", `A's link on A after B's attempt: ${onA.status} ${onA.headers.get("location")}`);
    },
  },
  {
    id: "L3",
    hermeticOnly: true,
    title: "links Supabase Auth mails (magic link, recovery) point at the site's own hostname and give no session on B",
    async run(w) {
      const { A, B } = w;
      for (const [action, kind] of [["magic-link", /sign in|magic|link/i], ["recover", /reset|password|recover/i]] as const) {
        const before = w.edge.mails.length;
        control("L3", `${action} on A`, await api(w.edge, A.host, `/api/auth/${action}`, { body: { email: A.member.email }, turnstileHost: A.host }));
        const { link } = await waitForMail(w.edge, A.member.email, kind, before);
        if (link.hostname !== A.host) throw new CrossSiteBreach("L3", `${action} mail points at ${link.hostname}`);
        const r = await w.edge.gw(B.host, `${link.pathname}${link.search}&confirm=1`);
        if (sessionFromLocation(r.headers.get("location"))) throw new CrossSiteBreach("L3", `B returned a session for A's ${action} link`);
      }
      const before = w.edge.mails.length;
      control("L3", "magic-link on B for A's member", await api(w.edge, B.host, "/api/auth/magic-link", { body: { email: A.member.email }, turnstileHost: B.host }));
      await w.edge.settle();
      await new Promise((r) => setTimeout(r, 1500));
      await w.edge.settle();
      const sent = w.edge.mails.slice(before).filter((m) => m.to === A.member.email);
      if (sent.length) throw new CrossSiteBreach("L3", `B mailed ${sent.length} link(s) for an account that exists only on A`);
    },
  },

  ...victims((vk) => ({
    id: `G1-${vk}`,
    title: `${vk}'s record ids are not found through A's hostname, even for A's admin`,
    async run(w) {
      const A = w.A;
      const B = w[vk];
      const t = A.admin.access_token;
      control("G1", "A's admin reads A's note", await api(w.edge, A.host, `/api/data/notes/${A.ids.note}`, { token: t }));
      await guarded("G1", w, B, async () => {
        for (const [c, id] of [["notes", B.ids.note], ["posts", B.ids.post], ["listings", B.ids.listing], ["slots", B.ids.slot], ["requests", B.ids.request], ["bookings", B.ids.booking]] as const) {
          denied("G1", `get ${c}`, await api(w.edge, A.host, `/api/data/${c}/${id}`, { token: t }), B, [404], "not_found");
          denied("G1", `get ${c} anonymously`, await api(w.edge, A.host, `/api/data/${c}/${id}`), B, [404], "not_found");
        }
        denied("G1", "update B note", await api(w.edge, A.host, `/api/data/notes/${B.ids.note}`, { token: t, method: "PATCH", body: { patch: { title: "pwned" } } }), B, [404, 403], ["not_found", "forbidden"]);
        denied("G1", "delete B note", await api(w.edge, A.host, `/api/data/notes/${B.ids.note}`, { token: t, method: "DELETE" }), B, [404, 403], ["not_found", "forbidden"]);
        denied("G1", "delete B request", await api(w.edge, A.host, `/api/data/requests/${B.ids.request}`, { token: t, method: "DELETE" }), B, [404, 403], ["not_found", "forbidden"]);
        denied("G1", "transition B listing", await api(w.edge, A.host, `/api/data/listings/${B.ids.listing}/transition`, { token: t, body: { to: "archived" } }), B, [404, 403, 409], ["not_found", "forbidden", "transition_conflict"]);
        denied("G1", "transition B request", await api(w.edge, A.host, `/api/data/requests/${B.ids.request}/transition`, { token: t, body: { to: "accepted" } }), B, [404, 403, 409], ["not_found", "forbidden", "transition_conflict"]);
      });
    },
  })),
  ...victims((vk) => ({
    id: `G2-${vk}`,
    title: `${vk}'s user ids mean nothing to A's member admin`,
    async run(w) {
      const A = w.A;
      const B = w[vk];
      const t = A.admin.access_token;
      const own = control("G2", "A's admin lists A's members", await api(w.edge, A.host, "/api/members/list", { token: t }));
      assertNoLeak("G2", "A's member list", JSON.stringify(own), B);
      await guarded("G2", w, B, async () => {
        for (const uid of [B.member.uid, B.admin.uid]) {
          for (const [op, body] of [
            ["set-role", { user_id: uid, role: "admin" }],
            ["disable", { user_id: uid }],
            ["reenable", { user_id: uid }],
            ["remove", { user_id: uid }],
            ["delete-data", { user_id: uid, confirm: true }],
          ] as const) {
            denied("G2", `${op} B user`, await api(w.edge, A.host, `/api/members/${op}`, { token: t, body }), B, [404], "member_not_found");
          }
          denied("G2", "reassign A's note to B's user", await api(w.edge, A.host, "/api/members/reassign-owner", { token: t, body: { collection: "notes", id: A.ids.note, to_user_id: uid } }), B, [404, 400], ["member_not_found", "not_found", "bad_request"]);
        }
        denied("G2", "reassign B's note to A's member", await api(w.edge, A.host, "/api/members/reassign-owner", { token: t, body: { collection: "notes", id: B.ids.note, to_user_id: A.member.uid } }), B, [404], ["not_found", "member_not_found"]);
      });
    },
  })),
  {
    id: "G3",
    title: "A cannot reference, book, cancel or count B's records (kernel references, actions, aggregates)",
    async run(w) {
      const { A, B } = w;
      await guarded("G3", w, B, async () => {
        denied("G3", "request referencing B's listing", await api(w.edge, A.host, "/api/data/requests", {
          token: A.member.access_token, body: { data: { listing_id: B.ids.listing, message: "x", status: "pending" } },
        }), B, [400], "invalid_reference");
        denied("G3", "slot referencing B's listing", await api(w.edge, A.host, "/api/data/slots", {
          token: A.admin.access_token, body: { data: { listing_id: B.ids.listing, starts_at: "2027-02-01T10:00:00Z", capacity: 1, booked_count: 0 } },
        }), B, [400], "invalid_reference");
        denied("G3", "reserve B's slot", await api(w.edge, A.host, "/api/actions/reserve_slot", { token: A.member.access_token, body: { target_id: B.ids.slot }, idem: newIdem() }), B, [404, 400], ["not_found", "invalid_reference"]);
        denied("G3", "cancel B's booking", await api(w.edge, A.host, "/api/actions/cancel_slot", { token: A.admin.access_token, body: { record_id: B.ids.booking }, idem: newIdem() }), B, [404, 400], ["not_found", "invalid_reference"]);
        const agg = await api(w.edge, A.host, "/api/aggregates/booking_count", { token: A.admin.access_token, body: { filter: { slot_id: B.ids.slot } } });
        const out = control("G3", "aggregate on A", agg);
        if (Number(out?.count ?? out?.value ?? 0) !== 0) throw new CrossSiteBreach("G3", `A's aggregate counted B's bookings: ${j(out)}`);
      });
      const mine = control("G3", "aggregate of A's own slot", await api(w.edge, A.host, "/api/aggregates/booking_count", { token: A.admin.access_token, body: { filter: { slot_id: A.ids.slot } } }));
      if (Number(mine?.count ?? mine?.value ?? 0) < 1) throw new ControlFailed("G3", `A's own booking count is ${j(mine)}`);
    },
  },
  {
    id: "G4",
    title: "filters, sorts and forged cursors cannot reach B's rows",
    async run(w) {
      const { A, B } = w;
      const t = A.admin.access_token;
      const probes = [
        `/api/data/notes?filter=${encodeURIComponent(JSON.stringify({ title: `secret note of ${B.spec.key}` }))}`,
        `/api/data/notes?filter=${encodeURIComponent(JSON.stringify({ title: { prefix: "secret" } }))}`,
        `/api/data/notes?sort=-title&limit=100`,
        `/api/data/notes?cursor=${encodeURIComponent(`9999999999999999:${B.ids.note}`)}`,
        `/api/data/notes?cursor=${encodeURIComponent(`0:${B.ids.note}`)}`,
      ];
      for (const p of probes) {
        const r = await api(w.edge, A.host, p, { token: t });
        assertNoLeak("G4", p, r, B);
        if (r.status >= 500) throw new ControlFailed("G4", `${p}: ${r.status}`);
      }
      const ownf = await api(w.edge, A.host, `/api/data/notes?filter=${encodeURIComponent(JSON.stringify({ title: `secret note of ${A.spec.key}` }))}`, { token: t });
      if (!JSON.stringify(control("G4", "A's own filter", ownf)).includes(A.ids.note)) throw new ControlFailed("G4", "A's filter does not find A's note");
    },
  },
  {
    id: "G5",
    title: "idempotency keys are per site: B reusing A's key gets B's own new record, never A's",
    async run(w) {
      const { A, B } = w;
      const key = newIdem();
      const a = control("G5", "anon post on A", await api(w.edge, A.host, "/api/data/posts", { body: { data: { title: `idem A ${key}` } }, idem: key, turnstileHost: A.host }));
      const b = await api(w.edge, B.host, "/api/data/posts", { body: { data: { title: `idem B ${key}` } }, idem: key, turnstileHost: B.host });
      const bd = control("G5", "anon post on B with A's key", b);
      if (bd.id === a.id || JSON.stringify(b.body).includes(`idem A ${key}`)) throw new CrossSiteBreach("G5", "B's create replayed A's record");
      const where = await w.sql(B.shard, "select site_id from zsite.records where id = $1", [bd.id]);
      if (where[0]?.site_id !== B.siteId) throw new CrossSiteBreach("G5", "B's create landed elsewhere");
    },
  },

  {
    id: "F1",
    title: "path traversal from A's hostname never reaches B's folder",
    async run(w) {
      const { A, B } = w;
      const t = A.admin.access_token;
      const target = `${B.siteId}/uploads/${B.file.name}`;
      await guarded("F1", w, B, async () => {
        for (const name of [`../../${target}`, `..%2F..%2F${encodeURIComponent(target)}`, `${B.file.name}/../../${target}`, target, `.${B.file.name}`, `%2e%2e/${target}`]) {
          denied("F1", `download-url ${name}`, await api(w.edge, A.host, "/api/storage/uploads/download-url", { token: t, body: { name } }), B, [400, 404], ["invalid_name", "not_found"]);
          denied("F1", `upload-url ${name}`, await api(w.edge, A.host, "/api/storage/uploads/upload-url", { token: t, body: { name, content_type: "text/plain", size: 4, upsert: true } }), B, [400, 404], ["invalid_name", "not_found"]);
        }
        for (const path of [
          `/api/storage/uploads/..%2F..%2F${B.siteId}%2Fuploads%2F${B.file.name}`,
          `/api/storage/${B.siteId}/list`,
          `/api/storage/uploads/%2e%2e%2f${B.siteId}%2fuploads%2f${B.file.name}`,
          `/api/storage/uploads/${encodeURIComponent(target)}`,
        ]) {
          for (const method of ["GET", "DELETE"]) {
            const r = await api(w.edge, A.host, path, { token: t, method });
            denied("F1", `${method} ${path}`, r, B, [400, 401, 403, 404, 405]);
          }
        }
        denied("F1", "byte proxy without a token", await api(w.edge, A.host, `/api/storage/uploads/object/${B.file.name}`), B, [403], "invalid_file_token");
      });
      const d = control("F1", "B's download-url", await api(w.edge, B.host, "/api/storage/uploads/download-url", { token: B.member.access_token, body: { name: B.file.name } }));
      const got = await w.edge.gw(B.host, d.url);
      const bytes = await got.text();
      if (bytes !== B.file.bytes) throw new ControlFailed("F1", `B's own file did not download intact: ${got.status} ${bytes.slice(0, 200)}`);
    },
  },
  ...victims((vk) => ({
    id: `F2-${vk}`,
    title: `A's token straight at Storage cannot list, read, sign, overwrite or delete ${vk}'s files`,
    async run(w) {
      const A = w.A;
      const B = w[vk];
      const path = `${B.siteId}/uploads/${B.file.name}`;
      const own = await storageDirect(w, B.shard, B.member.access_token, `object/sign/site-files/${path}`, "POST", { expiresIn: 60 });
      if (own.status !== 200) throw new ControlFailed("F2", `B's member signs B's file directly: ${own.status} ${j(own.body)}`);
      const ownList = await storageDirect(w, B.shard, B.member.access_token, "object/list/site-files", "POST", { prefix: `${B.siteId}/uploads/`, limit: 100, offset: 0 });
      if (ownList.status !== 200 || !JSON.stringify(ownList.body).includes(B.file.name)) throw new ControlFailed("F2", `B's member lists B's folder directly: ${ownList.status} ${j(ownList.body)}`);
      await guarded("F2", w, B, async () => {
        for (const tok of [A.member.access_token, A.admin.access_token]) {
          storageEmpty("F2", "list B's folder", await storageDirect(w, B.shard, tok, "object/list/site-files", "POST", { prefix: `${B.siteId}/uploads/`, limit: 100, offset: 0 }), B);
          storageRefused("F2", "sign B's file", await storageDirect(w, B.shard, tok, `object/sign/site-files/${path}`, "POST", { expiresIn: 60 }), B);
          for (const upsert of ["false", "true"]) {
            storageRefused("F2", `upload-sign over B's file (upsert ${upsert})`, await storageDirect(w, B.shard, tok, `object/upload/sign/site-files/${path}`, "POST", undefined, { "x-upsert": upsert }), B);
            storageRefused("F2", `upload-sign a new object in B's folder (upsert ${upsert})`,
              await storageDirect(w, B.shard, tok, `object/upload/sign/site-files/${B.siteId}/uploads/planted-${randomUUID().slice(0, 6)}.txt`, "POST", undefined, { "x-upsert": upsert }), B);
          }
          storageRefused("F2", "delete B's file", await storageDirect(w, B.shard, tok, `object/site-files/${path}`, "DELETE"), B);
          storageEmpty("F2", "batch-remove B's file", await storageDirect(w, B.shard, tok, "object/site-files", "DELETE", { prefixes: [path] }), B);
        }
      });
    },
  })),
  ...victims((vk) => ({
    id: `F3-${vk}`,
    title: `a file capability minted on A never works on ${vk}, and a tampered one works nowhere`,
    async run(w) {
      const A = w.A;
      const B = w[vk];
      const d = control("F3", "A's download-url", await api(w.edge, A.host, "/api/storage/uploads/download-url", { token: A.member.access_token, body: { name: A.file.name } }));
      const u = new URL(d.url, `https://${A.host}`);
      const t = u.searchParams.get("t")!;
      const okBytes = await (await w.edge.gw(A.host, d.url)).text();
      if (okBytes !== A.file.bytes) throw new ControlFailed("F3", "A's capability on A did not return A's file");
      const up = control("F3", "A's upload-url", await api(w.edge, A.host, "/api/storage/uploads/upload-url", { token: A.member.access_token, body: { name: "cap.txt", content_type: "text/plain", size: 4 } }));
      const ut = new URL(up.url, `https://${A.host}`).searchParams.get("t")!;
      const [body, mac] = t.split(".");
      const c = JSON.parse(Buffer.from(body, "base64url").toString());
      const forged = (patch: Record<string, unknown>) => `${b64urlJson({ ...c, ...patch })}.${mac}`;
      const reMac = (patch: Record<string, unknown>) => {
        const nb = b64urlJson({ ...c, ...patch });
        return `${nb}.${createHmac("sha256", "guessed-secret").update(`zavi-storage-v1.${nb}`).digest("hex")}`;
      };
      await guarded("F3", w, B, async () => {
        const tries: Array<[string, string, string]> = [
          ["A's download capability on B", B.host, `/api/storage/uploads/object/${A.file.name}?t=${encodeURIComponent(t)}`],
          ["A's capability for B's file name", B.host, `/api/storage/uploads/object/${B.file.name}?t=${encodeURIComponent(t)}`],
          ["site swapped, old MAC", B.host, `/api/storage/uploads/object/${B.file.name}?t=${encodeURIComponent(forged({ s: B.siteId, p: `${B.siteId}/uploads/${B.file.name}` }))}`],
          ["site swapped, guessed MAC", B.host, `/api/storage/uploads/object/${B.file.name}?t=${encodeURIComponent(reMac({ s: B.siteId, p: `${B.siteId}/uploads/${B.file.name}` }))}`],
          ["path swapped on A, old MAC", A.host, `/api/storage/uploads/object/${A.file.name}?t=${encodeURIComponent(forged({ p: `${B.siteId}/uploads/${B.file.name}` }))}`],
        ];
        for (const [what, host, path] of tries) {
          const r = await w.edge.gw(host, path);
          const text = await r.text();
          if (r.status < 300) throw new CrossSiteBreach("F3", `${what}: ${r.status} ${text.slice(0, 120)}`);
          assertNoLeak("F3", what, text, B);
          if (r.status !== 403) throw new ControlFailed("F3", `${what}: refused with ${r.status} (expected 403)`);
        }
        const put = await w.edge.gw(B.host, `/api/storage/uploads/object/cap.txt?t=${encodeURIComponent(ut)}`, { method: "PUT", headers: { "content-type": "text/plain", "content-length": "4" }, body: "pwnd" });
        if (put.status < 300) throw new CrossSiteBreach("F3", "A's upload capability wrote through B's hostname");
        if (put.status !== 403) throw new ControlFailed("F3", `A's upload capability on B: refused with ${put.status} (expected 403)`);
      });
    },
  })),

  ...victims((vk) => ({
    id: `E1-${vk}`,
    title: `A's admin is nobody on ${vk}: invite, role and member routes refuse it`,
    async run(w) {
      const A = w.A;
      const B = w[vk];
      const t = A.admin.access_token;
      await guarded("E1", w, B, async () => {
        denied("E1", "invite on B", await api(w.edge, B.host, "/api/members/invite", { token: t, body: { email: `x-${randomUUID().slice(0, 6)}@zsi-gate.test`, role: "admin" } }), B, [401], WRONG_SITE[vk]);
        denied("E1", "promote self on B", await api(w.edge, B.host, "/api/members/set-role", { token: t, body: { user_id: A.admin.uid, role: "admin" } }), B, [401], WRONG_SITE[vk]);
        denied("E1", "aggregate on B", await api(w.edge, B.host, "/api/aggregates/booking_count", { token: t, body: {} }), B, [401], WRONG_SITE[vk]);
      });
      const own = control("E1", "B's admin lists B's members", await api(w.edge, B.host, "/api/members/list", { token: B.admin.access_token }));
      if (JSON.stringify(own).includes(A.admin.uid) || JSON.stringify(own).includes(A.member.uid)) throw new CrossSiteBreach("E1", "B's member list contains an account of A");
    },
  })),
  {
    id: "E2",
    title: "inviting A's member to B as admin makes a separate B account; A's session stays nobody on B",
    async run(w) {
      const { A, B } = w;
      control("E2", "B's admin invites A's member email as admin", await api(w.edge, B.host, "/api/members/invite", { token: B.admin.access_token, body: { email: A.member.email, role: "admin" } }));
      await w.edge.settle();
      const rows = await w.sql(B.shard, "select auth_user_id from zsite.identities where site_id = $1 and email_norm = $2", [B.siteId, A.member.email]);
      for (const r of rows) if (r.auth_user_id === A.member.uid) throw new CrossSiteBreach("E2", "the invite on B reused A's auth user");
      const m = await w.sql(B.shard, "select count(*)::int as n from zsite.members where site_id = $1 and user_id = $2", [B.siteId, A.member.uid]);
      if (m[0].n) throw new CrossSiteBreach("E2", "A's auth user became a member of B");
      denied("E2", "A's member session on B after the invite", await api(w.edge, B.host, "/api/data/notes", { token: A.member.access_token }), B, [401], "session_wrong_site");
      const onA = await w.sql(A.shard, "select role from zsite.members where site_id = $1 and user_id = $2", [A.siteId, A.member.uid]);
      if (onA[0]?.role !== "user") throw new CrossSiteBreach("E2", `A's member role on A changed to ${onA[0]?.role}`);
    },
  },
  {
    id: "E3",
    title: "membership slots cannot span sites: the shard refuses an A account as a member of B even from the broker",
    async run(w) {
      const { A, B } = w;
      const h = await w.edge.directory.shard(B.shard.ref);
      if (!h) throw new ControlFailed("E3", "no broker handle for the pooled shard");
      await guarded("E3", w, B, async () => {
        const must = async (what: string, p: Promise<unknown>) => {
          let out: unknown;
          try {
            out = await p;
          } catch {
            return;
          }
          if (out === true || (out && typeof out === "object" && (out as { user_id?: string }).user_id === A.member.uid)) {
            throw new CrossSiteBreach("E3", `${what} accepted A's account on B: ${j(out)}`);
          }
        };
        await must("bootstrapAdmin(B, A member)", h.store.bootstrapAdmin(B.siteId, A.member.uid));
        await must("memberSetRole(B, B admin, A member, admin)", h.store.memberSetRole(B.siteId, B.admin.uid, A.member.uid, "admin"));
        await must("memberEnable(B, B admin, A member)", h.store.memberEnable(B.siteId, B.admin.uid, A.member.uid));
        await must("memberSetRole(B, A admin as actor)", h.store.memberSetRole(B.siteId, A.admin.uid, B.member.uid, "admin"));
        await must("memberReassignRecord(B note -> A member)", h.store.memberReassignRecord(B.siteId, B.admin.uid, "notes", B.ids.note, A.member.uid));
        await must("memberReassignRecord(A note via B)", h.store.memberReassignRecord(B.siteId, B.admin.uid, "notes", A.ids.note, B.member.uid));
        const idB = await h.store.identityByUser(A.member.uid);
        if (idB && idB.siteId !== A.siteId) throw new CrossSiteBreach("E3", "A's auth user resolves to another site");
        let inserted = false;
        try {
          await w.sql(B.shard, "insert into zsite.members (site_id, user_id, role, status) values ($1, $2, 'admin', 'active')", [B.siteId, A.member.uid]);
          inserted = true;
        } catch {
        }
        if (inserted) {
          await w.sql(B.shard, "delete from zsite.members where site_id = $1 and user_id = $2", [B.siteId, A.member.uid]);
          throw new CrossSiteBreach("E3", "the shard schema accepted a membership of A's account on B");
        }
      });
    },
  },

  {
    id: "Q1",
    title: "A exhausting its write quota and record cap does not throttle B",
    async run(w) {
      const { A, B } = w;
      const sql = shardSqlOf(w, A.shard);
      try {
        await applyQuotaOverrides(sql, A.shard.ref, A.siteId, { max_records: null, max_bytes: null, max_writes_per_min: 3, recipient_creates_per_min: null });
        let limited = false;
        for (let i = 0; i < 8 && !limited; i++) {
          const r = await api(w.edge, A.host, "/api/data/posts", { body: { data: { title: `flood ${i}` } }, idem: newIdem(), turnstileHost: A.host, ip: "203.0.113.11" });
          if (r.status === 429) limited = true;
          else control("Q1", `A flood ${i}`, r);
        }
        if (!limited) throw new ControlFailed("Q1", "A's write quota never engaged");
        control("Q1", "B anon create while A is throttled", await api(w.edge, B.host, "/api/data/posts", { body: { data: { title: "B still writes" } }, idem: newIdem(), turnstileHost: B.host, ip: "203.0.113.11" }));
        control("Q1", "B member create while A is throttled", await api(w.edge, B.host, "/api/data/notes", { token: B.member.access_token, body: { data: { title: "B note while A throttled" } } }));
        const cnt = await w.sql(A.shard, "select count(*)::int as n from zsite.records where site_id = $1", [A.siteId]);
        await applyQuotaOverrides(sql, A.shard.ref, A.siteId, { max_records: cnt[0].n, max_bytes: null, max_writes_per_min: null, recipient_creates_per_min: null });
        const full = await api(w.edge, A.host, "/api/data/notes", { token: A.member.access_token, body: { data: { title: "over cap" } } });
        if (full.status !== 429) throw new ControlFailed("Q1", `A's record cap did not engage: ${full.status}`);
        control("Q1", "B create while A is full", await api(w.edge, B.host, "/api/data/notes", { token: B.member.access_token, body: { data: { title: "B note while A full" } } }));
      } finally {
        await applyQuotaOverrides(sql, A.shard.ref, A.siteId, null);
      }
    },
  },
  {
    id: "Q2",
    title: "edge rate limits are per site: A's flood from one IP leaves B open to that IP",
    async run(w) {
      const { A, B } = w;
      const ip = "203.0.113.22";
      let limited = false;
      for (let i = 0; i < 320 && !limited; i++) {
        const r = await w.edge.gw(A.host, "/api/site", { ip });
        if (r.status === 429) limited = true;
      }
      if (!limited) throw new ControlFailed("Q2", "A's read limit never engaged");
      const r = await w.edge.gw(B.host, "/api/site", { ip });
      if (r.status !== 200) throw new CrossSiteBreach("Q2", `B was throttled by A's flood: ${r.status}`);
    },
  },
  {
    id: "Q3",
    title: "broker sign-in limits are per site: failed logins on A do not lock the same email on B",
    async run(w) {
      const { A, B } = w;
      const ip = "203.0.113.33";
      let limited = false;
      const attempts = 2 * LIMITS.loginEmail[1] + 2;
      for (let i = 0; i < attempts && !limited; i++) {
        const r = await api(w.edge, A.host, "/api/auth/login", { body: { email: A.shared!.email, password: `wrong-${i}-xxxx` }, ip });
        if (r.status === 429) limited = true;
      }
      if (!limited) throw new ControlFailed("Q3", "A's login limit never engaged");
      const r = await api(w.edge, B.host, "/api/auth/login", { body: { email: B.shared!.email, password: B.passwords.shared }, ip });
      if (r.status !== 200) throw new CrossSiteBreach("Q3", `B's sign-in for the same email was blocked by A's lockout: ${r.status} ${j(r.body)}`);
    },
  },

  ...victims((vk) => ({
    id: `X1-${vk}`,
    title: `the broker refuses any request the gateway did not sign for that exact site`,
    async run(w) {
      const A = w.A;
      const B = w[vk];
      const before = w.edge.brokerCalls.length;
      await login(w, A, "member");
      const call = w.edge.brokerCalls.slice(before).find((c) => c.url.endsWith("/login"));
      if (!call) throw new ControlFailed("X1", "no captured gateway->broker login call");
      const path = "/login";
      const send = (headers: Record<string, string>, body = call.body) => w.edge.brokerDirect(path, { method: "POST", headers, body });
      const check = async (what: string, res: Response) => {
        const text = await res.text();
        if (res.status < 300 || /access_token/.test(text)) throw new CrossSiteBreach("X1", `${what}: ${res.status} ${text.slice(0, 160)}`);
        if (res.status !== 401) throw new ControlFailed("X1", `${what}: refused with ${res.status}`);
      };
      await check("exact replay", await send(call.headers));
      await check("site swapped to B", await send({ ...call.headers, "x-zavi-gw-site-id": B.siteId, "x-zavi-gw-request-id": randomUUID() }));
      await check("host swapped to B", await send({ ...call.headers, "x-zavi-gw-host": B.host, "x-zavi-gw-request-id": randomUUID() }));
      await check("shard swapped", await send({ ...call.headers, "x-zavi-gw-shard-id": C_REF(w), "x-zavi-gw-request-id": randomUUID() }));
      await check("body swapped", await send({ ...call.headers, "x-zavi-gw-request-id": randomUUID() }, new TextEncoder().encode(JSON.stringify({ email: B.member.email, password: B.passwords.member }))));
      const { "x-zavi-gw-sig": _s, ...noSig } = call.headers;
      await check("no signature", await send({ ...noSig, "x-zavi-gw-request-id": randomUUID() }));
      await check("no gateway headers", await send({ "content-type": "application/json" }));
      const ts = String(Math.floor(Date.now() / 1000));
      const fields = [ "zavi-gw-v1", ts, randomUUID(), B.siteId, B.host, B.shard.ref, "POST", "login", "", "198.51.100.7", "x" ].join("\n");
      await check("wrong secret", await send({ ...call.headers, "x-zavi-gw-ts": ts, "x-zavi-gw-site-id": B.siteId, "x-zavi-gw-host": B.host, "x-zavi-gw-sig": createHmac("sha256", "not-the-secret").update(fields).digest("hex") }));
    },
  })),
  {
    id: "X2",
    title: "the signer mints only the fixed anonymous template, for nothing but (shard, site)",
    async run(w) {
      const { A } = w;
      for (const body of [
        { shard_id: A.shard.ref, site_id: A.siteId, role: "service_role" },
        { shard_id: A.shard.ref, site_id: A.siteId, sub: A.admin.uid },
        { shard_id: A.shard.ref, site_id: A.siteId, claims: { site_role: "admin" } },
        { shard_id: A.shard.ref, site_id: A.siteId, ttl: 86400 },
        { shard_id: A.shard.ref },
        { shard_id: "aaaaaaaaaaaaaaaaaaaa", site_id: A.siteId },
      ]) {
        const r = await w.edge.signer(body);
        if (r.status < 300) throw new CrossSiteBreach("X2", `signer minted for ${j(body)}`);
      }
      const r = await w.edge.signer({ shard_id: A.shard.ref, site_id: A.siteId });
      const tok = ((await r.json()) as { token: string }).token;
      const c = claims(tok);
      if (Object.keys(c).sort().join() !== "exp,iat,jti,role,site_id" || c.role !== "anon" || c.site_id !== A.siteId || c.exp - c.iat > 300) {
        throw new CrossSiteBreach("X2", `signer token is not the anon template: ${j(c)}`);
      }
    },
  },
  {
    id: "X3",
    title: "a Turnstile solve on A's page is refused on B",
    async run(w) {
      const { A, B } = w;
      denied("X3", "anon create on B with A's solve", await api(w.edge, B.host, "/api/data/posts", { body: { data: { title: "x" } }, idem: newIdem(), turnstileHost: A.host }), B, [403], "turnstile_failed");
      denied("X3", "signup on B with A's solve", await api(w.edge, B.host, "/api/auth/signup", { body: { email: `t-${randomUUID().slice(0, 6)}@zsi-gate.test` }, turnstileHost: A.host }), B, [403], "turnstile_failed");
      control("X3", "B's own solve", await api(w.edge, B.host, "/api/data/posts", { body: { data: { title: "solved on B" } }, idem: newIdem(), turnstileHost: B.host }));
    },
  },
];

const C_REF = (w: World) => w.C.shard.ref;

export const ATTACK_IDS = ATTACKS.map((a) => a.id);
