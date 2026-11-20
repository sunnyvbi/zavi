import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Pool } from "pg";
import { EMPTY_SITE_CONTRACT, type ShardSql } from "../../contract";
import { applySitePlanSql, readCollectionsV2, readSiteContract, roleHolders } from "../../apply-v2";
import { planSite } from "../../collections-plan";
import { collectionsOf, siteContractOf } from "../../manifest-adapter";
import { deleteRecordBatch, deleteShardSiteRows, ensureShardSite, shardSiteLeftovers, siteAuthUserIds } from "../../shard-ops";
import { ensureSiteAdmin, siteOwnerMagicLink } from "@/services/site-auth/admin";
import type { Edge, SiteSpec } from "./edge";
import type { ShardTarget } from "./target";

const req = createRequire(__filename);

export const MANIFEST = {
  schemaVersion: 2,
  roles: ["seller", "moderator"],
  capabilities: [],
  collections: {
    notes: {
      kind: "records",
      rules: { list: ["owner", "admin"], get: ["owner", "admin"], create: ["signed_in"], update: ["owner", "admin"], delete: ["owner", "admin"] },
      schema: { type: "object", required: ["title"], properties: { title: { type: "string", maxLength: 80 }, body: { type: "string", maxLength: 500 } } },
      fields: {}, indexes: { title: { type: "text", ops: ["eq", "in", "prefix"], sort: true } }, unique: [], references: {},
    },
    posts: {
      kind: "records",
      rules: { list: ["anyone"], get: ["anyone"], create: ["anyone"], update: ["admin"], delete: ["admin"] },
      schema: { type: "object", required: ["title"], properties: { title: { type: "string", maxLength: 80 } } },
      fields: {}, indexes: {}, unique: [], references: {},
    },
    listings: {
      kind: "records",
      rules: { list: ["anyone"], get: ["anyone"], create: ["admin", "role:seller"], update: ["owner", "admin"], delete: ["owner", "admin"] },
      schema: { type: "object", required: ["title", "status"], properties: { title: { type: "string", maxLength: 120 }, status: { type: "string", maxLength: 9, enum: ["draft", "published", "archived"] } } },
      fields: {}, indexes: {}, unique: [], references: {},
      states: {
        field: "status", values: ["draft", "published", "archived"], initial: "draft",
        read: { draft: ["owner", "admin"], published: ["anyone"], archived: ["owner", "admin"] },
        transitions: [{ from: "draft", to: "published", principals: ["owner", "admin"] }, { from: "published", to: "archived", principals: ["owner", "admin"] }],
      },
    },
    requests: {
      kind: "records",
      rules: { list: ["owner", "recipient", "admin"], get: ["owner", "recipient", "admin"], create: ["signed_in"], update: [], delete: ["owner", "admin"] },
      schema: { type: "object", required: ["listing_id", "message", "status"], properties: { listing_id: { type: "string", maxLength: 36, format: "uuid" }, message: { type: "string", maxLength: 1000 }, status: { type: "string", maxLength: 9, enum: ["pending", "accepted", "declined", "cancelled"] } } },
      fields: {}, indexes: { listing_id: { type: "text", ops: ["eq"], sort: false } },
      recipient: { reference: "listing_id" },
      references: { listing_id: { collection: "listings", on_delete: "restrict" } },
      unique: [],
      states: {
        field: "status", values: ["pending", "accepted", "declined", "cancelled"], initial: "pending",
        read: { pending: ["owner", "recipient", "admin"], accepted: ["owner", "recipient", "admin"], declined: ["owner", "recipient", "admin"], cancelled: ["owner", "recipient", "admin"] },
        transitions: [{ from: "pending", to: "accepted", principals: ["recipient", "admin"] }, { from: "pending", to: "declined", principals: ["recipient", "admin"] }, { from: "pending", to: "cancelled", principals: ["owner", "admin"] }],
      },
    },
    slots: {
      kind: "records",
      rules: { list: ["anyone"], get: ["anyone"], create: ["admin", "role:seller"], update: ["owner", "admin"], delete: ["owner", "admin"] },
      schema: { type: "object", required: ["listing_id", "starts_at", "capacity", "booked_count"], properties: { listing_id: { type: "string", maxLength: 36, format: "uuid" }, starts_at: { type: "string", maxLength: 40, format: "date-time" }, capacity: { type: "integer", minimum: 1, maximum: 100 }, booked_count: { type: "integer", minimum: 0, maximum: 100 } } },
      fields: {}, indexes: { starts_at: { type: "timestamp", ops: ["range"], sort: true } },
      references: { listing_id: { collection: "listings", on_delete: "restrict" } },
      unique: [{ fields: ["listing_id", "starts_at"], nulls: "not_distinct" }],
    },
    bookings: {
      kind: "records",
      rules: { list: ["owner", "admin"], get: ["owner", "admin"], create: [], update: [], delete: [] },
      schema: { type: "object", required: ["slot_id", "status"], properties: { slot_id: { type: "string", maxLength: 36, format: "uuid" }, note: { type: "string", maxLength: 500 }, status: { type: "string", maxLength: 9, enum: ["booked", "cancelled"] } } },
      fields: {}, indexes: { slot_id: { type: "text", ops: ["eq"], sort: false } },
      references: { slot_id: { collection: "slots", on_delete: "restrict" } },
      unique: [],
      states: { field: "status", values: ["booked", "cancelled"], initial: "booked", transitions: [{ from: "booked", to: "cancelled", principals: ["owner", "admin"] }] },
    },
    uploads: {
      kind: "files",
      rules: { list: ["owner", "admin"], get: ["owner", "admin"], create: ["signed_in"], update: [], delete: ["owner", "admin"] },
      schema: {},
      fields: {}, indexes: {}, unique: [], references: {},
    },
  },
  actions: {
    reserve_slot: {
      target: { collection: "slots", counter: "booked_count" },
      delta: 1, initial: 0, bounds: { min: 0, maxField: "capacity" },
      creates: { collection: "bookings", targetField: "slot_id" },
      principals: ["signed_in"], idempotency: "required",
      inverse: { name: "cancel_slot", delta: -1, transition: { from: "booked", to: "cancelled" }, principals: ["owner", "admin"], idempotency: "required" },
    },
  },
  aggregates: {
    booking_count: { collection: "bookings", fn: "count", filters: ["slot_id", "status"], principals: ["admin"] },
  },
};

export interface Session {
  access_token: string;
  refresh_token: string;
  uid: string;
  email: string;
}

export interface SiteWorld {
  spec: SiteSpec;
  host: string;
  siteId: string;
  shard: ShardTarget;
  admin: Session;
  member: Session;
  shared?: Session;
  ids: { note: string; post: string; listing: string; slot: string; request: string; booking: string };
  file: { name: string; bytes: string };
  passwords: Record<string, string>;
}

export interface World {
  edge: Edge;
  run: string;
  A: SiteWorld;
  B: SiteWorld;
  C: SiteWorld;
  shards: ShardTarget[];
  sql(shard: ShardTarget, q: string, params?: unknown[]): Promise<Array<Record<string, any>>>;
  close(): Promise<void>;
}

export interface ApiResult {
  status: number;
  body: any;
  headers: Headers;
}

export async function api(
  edge: Edge,
  host: string,
  path: string,
  o: { method?: string; token?: string; body?: unknown; idem?: string; turnstileHost?: string; ip?: string; headers?: Record<string, string>; raw?: string; contentType?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.idem) headers["idempotency-key"] = o.idem;
  if (o.turnstileHost) headers["x-zavi-turnstile-token"] = `zsi-turnstile:${o.turnstileHost}`;
  let body: string | undefined;
  if (o.raw !== undefined) {
    body = o.raw;
    headers["content-type"] = o.contentType ?? "application/json";
  } else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers["content-type"] = "application/json";
  }
  const res = await edge.gw(host, path, { method: o.method ?? (body === undefined ? "GET" : "POST"), headers, body, ip: o.ip });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

export function sessionFromLocation(loc: string | null): { access_token: string; refresh_token: string } | null {
  if (!loc) return null;
  const frag = new URLSearchParams(loc.split("#")[1] ?? "");
  const at = frag.get("access_token");
  const rt = frag.get("refresh_token");
  return at && rt ? { access_token: at, refresh_token: rt } : null;
}

export function claims(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

const LINK_RE = /https:\/\/[a-z0-9.-]+\/api\/auth\/callback\?[^\s"'<>]+/;

export function linkIn(text: string): URL {
  const m = LINK_RE.exec(text.replace(/&amp;/g, "&"));
  if (!m) throw new Error("no callback link in mail");
  return new URL(m[0]);
}

export async function waitForMail(edge: Edge, to: string, kind: RegExp, after: number): Promise<{ link: URL; index: number }> {
  for (let i = 0; i < 100; i++) {
    await edge.settle();
    const idx = edge.mails.findIndex((m, j) => j >= after && m.to === to && kind.test(m.text + m.subject));
    if (idx >= 0) return { link: linkIn(edge.mails[idx].text + " " + edge.mails[idx].html), index: idx };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no mail to ${to} matching ${kind}`);
}

function shardSql(pool: Pool): ShardSql {
  return {
    async query(_ref, q) {
      const c = await pool.connect();
      try {
        const r = await c.query(q);
        const all = Array.isArray(r) ? r : [r];
        const last = all.filter((x) => x.rows && x.command === "SELECT").pop() ?? all[all.length - 1];
        return last?.rows ?? [];
      } catch (e) {
        await c.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    },
  };
}

async function founderSession(edge: Edge, s: SiteSpec, email: string): Promise<Session> {
  const deps = { directory: edge.directory, aliasKey: edge.brokerDeps.aliasKey };
  const { authUserId } = await ensureSiteAdmin(deps, { siteId: s.siteId, email });
  const link = new URL(await siteOwnerMagicLink(deps, { shardId: s.shard.ref, siteId: s.siteId, email, redirectTo: `https://${s.hostname}/` }));
  if (link.hostname !== s.hostname) throw new Error("founder link is not on the site's hostname");
  const res = await edge.gw(s.hostname, `${link.pathname}${link.search}&confirm=1`);
  const sess = sessionFromLocation(res.headers.get("location"));
  if (res.status !== 303 || !sess) {
    throw new Error(`founder sign-in failed for ${s.key}: ${res.status} ${res.headers.get("location")} | broker: ${edge.logs.slice(-5).join(" / ")}`);
  }
  return { ...sess, uid: authUserId, email };
}

export async function signupSession(edge: Edge, s: SiteSpec, email: string): Promise<Session> {
  const before = edge.mails.length;
  const r = await api(edge, s.hostname, "/api/auth/signup", { body: { email }, turnstileHost: s.hostname });
  if (r.status !== 200) throw new Error(`signup ${email} on ${s.key}: ${r.status} ${JSON.stringify(r.body)}`);
  const { link } = await waitForMail(edge, email, /confirm|verify|account/i, before);
  if (link.hostname !== s.hostname) throw new Error("signup link is not on the site's hostname");
  const res = await edge.gw(s.hostname, "/api/auth/confirm", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `type=signup&token_hash=${encodeURIComponent(link.searchParams.get("token_hash") ?? "")}`,
  });
  const sess = sessionFromLocation(res.headers.get("location"));
  if (res.status !== 303 || !sess) throw new Error(`confirm ${email} on ${s.key}: ${res.status} ${res.headers.get("location")}`);
  return { ...sess, uid: String(claims(sess.access_token).sub), email };
}

export async function setPassword(edge: Edge, s: SiteSpec, sess: Session, password: string): Promise<Session> {
  const r = await api(edge, s.hostname, "/api/auth/password", { token: sess.access_token, body: { password } });
  if (r.status !== 200 || !r.body?.data?.session) throw new Error(`password on ${s.key}: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...sess, access_token: r.body.data.session.access_token, refresh_token: r.body.data.session.refresh_token };
}

function ok(r: ApiResult, what: string, codes = [200, 201]): any {
  if (!codes.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body?.data;
}

export const newIdem = () => randomBytes(18).toString("base64url");

async function seedSite(edge: Edge, s: SiteSpec, run: string, withShared: boolean): Promise<SiteWorld> {
  const h = s.hostname;
  const admin = await founderSession(edge, s, `owner-${s.key.toLowerCase()}-${run}@zsi-gate.test`);
  let member = await signupSession(edge, s, `member-${s.key.toLowerCase()}-${run}@zsi-gate.test`);
  const passwords: Record<string, string> = {};
  passwords.member = `pw-${s.key}-${randomBytes(6).toString("hex")}`;
  member = await setPassword(edge, s, member, passwords.member);
  let shared: Session | undefined;
  if (withShared) {
    shared = await signupSession(edge, s, `shared-${run}@zsi-gate.test`);
    passwords.shared = `pw-shared-${s.key}-${randomBytes(6).toString("hex")}`;
    shared = await setPassword(edge, s, shared, passwords.shared);
  }

  const note = ok(await api(edge, h, "/api/data/notes", { token: member.access_token, body: { data: { title: `secret note of ${s.key}`, body: `only ${s.key}'s member may read this` } } }), `${s.key} note`);
  const post = ok(await api(edge, h, "/api/data/posts", { body: { data: { title: `post on ${s.key}` } }, idem: newIdem(), turnstileHost: h }), `${s.key} post`);
  const listing = ok(await api(edge, h, "/api/data/listings", { token: admin.access_token, body: { data: { title: `listing on ${s.key}`, status: "draft" } } }), `${s.key} listing`);
  ok(await api(edge, h, `/api/data/listings/${listing.id}/transition`, { token: admin.access_token, body: { to: "published" } }), `${s.key} publish`);
  const slot = ok(await api(edge, h, "/api/data/slots", { token: admin.access_token, body: { data: { listing_id: listing.id, starts_at: "2027-01-01T10:00:00Z", capacity: 5, booked_count: 0 } } }), `${s.key} slot`);
  const request = ok(await api(edge, h, "/api/data/requests", { token: member.access_token, body: { data: { listing_id: listing.id, message: `request on ${s.key}`, status: "pending" } } }), `${s.key} request`);
  const booking = ok(await api(edge, h, "/api/actions/reserve_slot", { token: member.access_token, body: { target_id: slot.id }, idem: newIdem() }), `${s.key} reserve`);
  const bookingId = booking?.record_id;
  if (typeof bookingId !== "string") throw new Error(`${s.key} reserve: no booking id in ${JSON.stringify(booking).slice(0, 300)}`);

  const file = { name: `report-${s.key.toLowerCase()}.txt`, bytes: `private file of site ${s.key} ${randomBytes(8).toString("hex")}` };
  const up = ok(await api(edge, h, "/api/storage/uploads/upload-url", { token: member.access_token, body: { name: file.name, content_type: "text/plain", size: Buffer.byteLength(file.bytes) } }), `${s.key} upload-url`);
  const put = await edge.gw(h, up.url, { method: "PUT", headers: { "content-type": "text/plain", "content-length": String(Buffer.byteLength(file.bytes)) }, body: file.bytes });
  if (put.status !== 200) throw new Error(`${s.key} upload PUT: ${put.status} ${await put.text()}`);

  return {
    spec: s, host: h, siteId: s.siteId, shard: s.shard, admin, member, shared, passwords, file,
    ids: { note: note.id, post: post.id, listing: listing.id, slot: slot.id, request: request.id, booking: bookingId },
  };
}

export async function buildWorld(edge: Edge, specs: { A: SiteSpec; B: SiteSpec; C: SiteSpec }): Promise<World> {
  const { Pool: PgPool } = req("pg") as typeof import("pg");
  const pools = new Map<string, Pool>();
  const poolOf = (sh: ShardTarget) => {
    let p = pools.get(sh.ref);
    if (!p) {
      p = new PgPool({ connectionString: sh.adminDbUrl, max: 4, idleTimeoutMillis: 5_000 });
      p.on("error", () => undefined);
      pools.set(sh.ref, p);
    }
    return p;
  };
  const shards = [...new Map([specs.A, specs.B, specs.C].map((s) => [s.shard.ref, s.shard])).values()];
  const desired = collectionsOf(MANIFEST);
  const contract = siteContractOf(MANIFEST);
  for (const s of [specs.A, specs.B, specs.C]) {
    const sql = shardSql(poolOf(s.shard));
    await ensureShardSite(sql, s.shard.ref, s.siteId);
    const current = await readCollectionsV2(sql, s.shard.ref, s.siteId);
    const cur = await readSiteContract(sql, s.shard.ref, s.siteId);
    const plan = planSite(current, desired, cur ?? EMPTY_SITE_CONTRACT, contract);
    const holders = await roleHolders(sql, s.shard.ref, s.siteId, plan.backfill.removedRoles);
    await sql.query(s.shard.ref, applySitePlanSql(s.siteId, plan, current, cur, holders));
  }
  const run = randomUUID().slice(0, 8);
  let A: SiteWorld, B: SiteWorld, C: SiteWorld;
  try {
    A = await seedSite(edge, specs.A, run, true);
    B = await seedSite(edge, specs.B, run, true);
    C = await seedSite(edge, specs.C, run, false);
  } catch (e) {
    for (const p of pools.values()) await p.end().catch(() => undefined);
    throw e;
  }
  const world: World = {
    edge, run, A, B, C, shards,
    async sql(shard, q, params = []) {
      return (await poolOf(shard).query(q, params)).rows;
    },
    async close() {
      for (const p of pools.values()) await p.end().catch(() => undefined);
    },
  };
  return world;
}

export async function cleanupSites(edge: Edge, specs: SiteSpec[]): Promise<string[]> {
  const { Pool: PgPool } = req("pg") as typeof import("pg");
  const pools = new Map<string, Pool>();
  const leftovers: string[] = [];
  const poolOf = (sh: ShardTarget) => {
    let p = pools.get(sh.ref);
    if (!p) {
      p = new PgPool({ connectionString: sh.adminDbUrl, max: 2, idleTimeoutMillis: 5_000 });
      p.on("error", () => undefined);
      pools.set(sh.ref, p);
    }
    return p;
  };
  const q = async (sh: ShardTarget, text: string, params: unknown[] = []) => (await poolOf(sh).query(text, params)).rows;
  try {
    for (const w of specs) {
      const sql = shardSql(poolOf(w.shard));
      const ref = w.shard.ref;
      try {
        const handle = await edge.directory.shard(ref);
        if (!handle) throw new Error("no broker handle for the shard");
        const exists = await q(w.shard, "select 1 from zsite.sites where site_id = $1", [w.siteId]);
        if (!exists.length) continue;
        const names = (await q(w.shard, "select name from storage.objects where bucket_id = 'site-files' and name like $1", [`${w.siteId}/%`]))
          .map((r) => String(r.name));
        if (names.some((n) => !n.startsWith(`${w.siteId}/`))) throw new Error("file listing escaped the site prefix");
        if (names.length) await handle.gotrue.removeObjects(names);
        for (let i = 0; i < 1000; i++) if ((await deleteRecordBatch(sql, ref, w.siteId)) === 0) break;
        const uids = await siteAuthUserIds(sql, ref, w.siteId);
        for (const uid of uids) await handle.gotrue.deleteUser(uid);
        const auth = await q(w.shard, `select table_name from information_schema.columns
          where table_schema = 'zsite_auth' and column_name = 'site_id'`);
        for (const t of auth) {
          await q(w.shard, `delete from zsite_auth.${String(t.table_name)} where site_id = $1`, [w.siteId]).catch((e) => {
            if (!/append_only/.test(String((e as Error).message))) throw e;
          });
        }
        await deleteShardSiteRows(sql, ref, w.siteId);
        const left = Object.entries(await shardSiteLeftovers(sql, ref, w.siteId)).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
        const files = await q(w.shard, "select count(*)::int as n from storage.objects where name like $1", [`${w.siteId}/%`]);
        if (files[0].n) left.push(`files=${files[0].n}`);
        const users = await q(w.shard, "select count(*)::int as n from auth.users where id = any($1::uuid[])", [uids]);
        if (users[0].n) left.push(`auth users=${users[0].n}`);
        if (left.length) leftovers.push(`${w.key}: ${left.join(", ")}`);
      } catch (e) {
        leftovers.push(`${w.key}: cleanup failed: ${(e as Error).message}`);
      }
    }
    const shards = [...new Map(specs.map((s) => [s.shard.ref, s.shard])).values()];
    const stray = [...edge.strayAuthEmails];
    for (const sh of stray.length ? shards : []) {
      try {
        const handle = await edge.directory.shard(sh.ref);
        const rows = await q(sh, "select id from auth.users where email = any($1::text[])", [stray]);
        for (const r of rows) await handle?.gotrue.deleteUser(String(r.id));
        const left = await q(sh, "select count(*)::int as n from auth.users where email = any($1::text[])", [stray]);
        if (left[0].n) leftovers.push(`${sh.ref}: ${left[0].n} direct-signup auth user(s)`);
      } catch (e) {
        leftovers.push(`${sh.ref}: direct-signup cleanup failed: ${(e as Error).message}`);
      }
    }
  } finally {
    for (const p of pools.values()) await p.end().catch(() => undefined);
  }
  return leftovers;
}
