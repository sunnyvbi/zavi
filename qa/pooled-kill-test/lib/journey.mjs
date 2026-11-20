import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { connect, isDev } from "./transport.mjs";
import { mailboxFromEnv } from "./mailbox.mjs";
import { admin as adminActor, Fail, must, reporter, runId, user, visitor } from "./kit.mjs";
import { v1Projection } from "./contract-v2.mjs";
import { validatorSupportsV2 } from "./paths.mjs";

const day = (n = 0) => new Date(Date.now() + n * 86400000);
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");

export function sample(p, marker, i = 0) {
  switch (p.type) {
    case "string": {
      if (p.enum) return p.enum[0];
      if (p.format === "email") return `kk-${marker.replace(/[^a-z0-9]+/gi, "-")}@example.invalid`.toLowerCase().slice(-p.maxLength);
      if (p.format === "date") return day(7 + i).toISOString().slice(0, 10);
      if (p.format === "date-time") return iso(new Date(new Date(day(1 + i)).setUTCHours(0, 0, 0, 0) + Math.floor(Math.random() * 40000) * 60000));
      if (p.format === "uuid") return randomUUID();
      let v = marker.length <= p.maxLength ? marker : marker.slice(0, p.maxLength);
      while (v.length < (p.minLength ?? 0)) v += "x";
      return v;
    }
    case "integer": case "number": {
      const lo = p.minimum ?? 0, hi = p.maximum ?? lo + 10;
      return Math.min(Math.max(1, lo), hi);
    }
    case "boolean": return true;
    case "array": return [sample(p.items, marker, i)];
    default: throw new Error(`no sample for ${JSON.stringify(p)}`);
  }
}

const recordHasId = (items, id) => items.some((r) => r.id === id);
export const createdIdOf = (r) => r?.record?.id ?? r?.record_id ?? r?.created_id ?? r?.created?.id ?? (typeof r?.id === "string" ? r.id : null);

export function instrumentFailure(e) {
  const reason = String(e?.reason ?? "");
  if (/^turnstile/.test(reason)) return `refused by Turnstile (${reason}), not by the rule under test: Turnstile must be off for QA hosts (RUNBOOK.md)`;
  if (e?.code === "rate_limited" && !/recipient_rate_limited/.test(reason)) return `rate limited (${reason}): re-run after the window`;
  if (e?.code === "offline") return `call failed (offline: ${reason})`;
  if (reason === "contract_building") return "site contract still building (503): wait for activation";
  return null;
}

export async function runJourney({ n, title, base, manifestPath, scenario, dedicated = null }) {
  const run = runId();
  const manifestText = readFileSync(manifestPath, "utf8");
  const man = JSON.parse(manifestText);
  const dev = isDev(base);
  const rep = reporter({ kind: "journey", site: n, title, base, run, started_at: new Date().toISOString(), mode: dev ? "DEV DRY RUN (in-process SDK dev server: no gateway, shard, RLS, broker, rate limits, Turnstile or email). NOT the kill test." : "real" });

  if (dedicated) return dedicatedJourney({ rep, base, man, dedicated: { ...dedicated, n } });

  const tiny = JSON.stringify({ schemaVersion: 1, collections: { x: { rules: {}, schema: { type: "object", properties: { a: { type: "string", maxLength: 5 } } } } } });
  const probe = await connect(dev ? `dev:probe-${n}-${run}` : base, dev ? { manifestText: tiny } : {});
  const sdkV2 = validatorSupportsV2(probe.real.validateManifest);
  if (!dev && !sdkV2) {
    rep.fail("sdk.v2", "ZAVI_POOLED_SRC has no v2 SDK/validator: point it at a checkout with K3 merged");
    return rep.finish();
  }
  const conn = dev
    ? await connect(`dev:site-${n}-${run}`, { manifestText: sdkV2 ? manifestText : JSON.stringify(v1Projection(man)) })
    : probe;
  const v2 = sdkV2;
  if (!v2) rep.warn("mode.v1_projection", "SDK/validator in ZAVI_POOLED_SRC is pre-v2: the dev server runs the v1 projection; every v2 step is skipped (pending K3)");

  const site = await conn.raw("GET", "/api/site");
  if (site.status !== 200 || !site.json?.data?.site_id) { rep.fail("site.reachable", `GET /api/site -> ${site.status} ${site.code ?? ""}`); return rep.finish(); }
  rep.pass("site.reachable", site.json.data.site_id);

  const mailbox = dev ? null : mailboxFromEnv();
  const actors = { visitor: visitor(conn) };
  const created = [];
  const uploads = [];
  const cols = man.collections;

  const ctx = {
    n, conn, man, v2, rep, run, actors, created,
    marker: (tag) => `kk ${tag} ${run}`,

    async actor(name) {
      if (actors[name]) return actors[name];
      const a = name === "admin"
        ? await rep.step("auth.admin_sign_in", () => adminActor(conn, mailbox))
        : await rep.step(`auth.user_${name}`, () => user(conn, mailbox, name, { run }));
      if (!a) throw new Fail(`${name} could not sign in`);
      actors[name] = a;
      return a;
    },
    async userId(name) { return (await ctx.actor(name)).z.auth.user()?.id ?? null; },

    values(coll, overrides = {}, i = 0) {
      const c = cols[coll];
      const serverOwned = new Set();
      if (v2 && c.states) serverOwned.add(c.states.field);
      if (v2) for (const a of Object.values(man.actions ?? {})) if (a.target.collection === coll) serverOwned.add(a.target.counter);
      const out = {};
      for (const k of c.schema.required ?? []) if (!serverOwned.has(k)) out[k] = sample(c.schema.properties[k], ctx.marker(`${coll}.${k}`), i);
      if (!v2 && c.states) out[c.states.field] = c.states.initial;
      if (!v2) for (const a of Object.values(man.actions ?? {})) if (a.target.collection === coll) out[a.target.counter] = a.initial;
      return { ...out, ...overrides };
    },

    async create(who, coll, overrides = {}, i = 0) {
      const a = await ctx.actor(who);
      const r = await a.z.data.collection(coll).create(ctx.values(coll, overrides, i));
      must(typeof r?.id === "string", `create returned no id: ${JSON.stringify(r)}`);
      created.push({ coll, id: r.id, by: who });
      return r.id;
    },

    async get(who, coll, id) { return (await ctx.actor(who)).z.data.collection(coll).get(id); },
    async list(who, coll, opts = {}) { return (await ctx.actor(who)).z.data.collection(coll).list({ limit: 100, ...opts }); },

    async sees(who, coll, id, { inList = true, listOpts = {} } = {}) {
      const r = await ctx.get(who, coll, id);
      must(r && r.id === id, `${who} cannot get ${coll}/${id}`);
      if (inList) {
        const page = await ctx.list(who, coll, listOpts);
        must(recordHasId(page.items, id), `${who} gets ${coll}/${id} but it is missing from their list`);
      }
      return r;
    },

    async hidden(who, coll, id) {
      const a = await ctx.actor(who);
      let got;
      try { got = await a.z.data.collection(coll).get(id); } catch (e) {
        const bad = instrumentFailure(e); if (bad) throw new Fail(bad);
        if (!["not_found", "not_allowed"].includes(e?.code)) throw new Fail(`get refused with ${e?.code}/${e?.reason}, expected not_found|not_allowed`);
        got = null;
      }
      must(got === null, `${who} CAN get ${coll}/${id}: ${JSON.stringify(got)?.slice(0, 160)}`);
      try {
        const page = await a.z.data.collection(coll).list({ limit: 100 });
        must(!recordHasId(page.items, id), `${who} sees ${coll}/${id} in a list`);
      } catch (e) {
        if (e instanceof Fail) throw e;
        const bad = instrumentFailure(e); if (bad) throw new Fail(bad);
        if (!["not_allowed", "not_found"].includes(e?.code)) throw new Fail(`list failed with ${e?.code}/${e?.reason}`);
      }
      return { detail: "hidden" };
    },

    async refused(fn, expect = ["not_found", "not_allowed", "forbidden"]) {
      let v;
      try { v = await fn(); } catch (e) {
        if (e instanceof Fail) throw e;
        const bad = instrumentFailure(e); if (bad) throw new Fail(bad);
        if (!expect.includes(e?.reason) && !expect.includes(e?.code)) throw new Fail(`refused with ${e?.code}/${e?.reason}, expected ${expect.join("|")}`);
        return { detail: `${e.code}/${e.reason}` };
      }
      if (v === null && expect.includes("not_found")) return { detail: "null (not visible)" };
      throw new Fail(`ALLOWED: ${JSON.stringify(v)?.slice(0, 200)}`);
    },

    async masked(who, coll, id, fields) {
      const r = await ctx.get(who, coll, id);
      must(r && r.id === id, `${who} cannot get ${coll}/${id}`);
      const leaked = fields.filter((f) => r.data?.[f] !== undefined);
      must(!leaked.length, `${who} reads masked field(s) ${leaked.join(", ")}`);
      return { detail: `masked: ${fields.join(",")}` };
    },
    async aggregateDelta(who, name, filter, fn) {
      const before = await ctx.aggregate(who, name, filter);
      await fn();
      return (await ctx.aggregate(who, name, filter)) - before;
    },

    async update(who, coll, id, patch) { return (await ctx.actor(who)).z.data.collection(coll).update(id, patch); },

    async transition(who, coll, id, to) {
      const r = await (await ctx.actor(who)).z.data.collection(coll).transition(id, to);
      must(r?.to === to && r?.transitioned !== false, `transition -> ${to}: ${JSON.stringify(r)}`);
      return { detail: `${r.from} -> ${r.to}` };
    },
    async stateOf(coll, id, who = "admin") {
      const r = await ctx.get(who, coll, id);
      must(r, `${who} cannot read ${coll}/${id}`);
      return r.data[cols[coll].states.field];
    },

    async action(who, name, args, { replay = true } = {}) {
      const a = await ctx.actor(who);
      const key = `kk-${name}-${randomUUID()}`;
      const r1 = await a.z.actions.run(name, args, { idempotencyKey: key });
      const def = man.actions?.[name];
      const createdId = createdIdOf(r1);
      if (def && args.targetId) {
        must(typeof createdId === "string", `action ${name} returned no created record id: ${JSON.stringify(r1)}`);
        created.push({ coll: def.creates.collection, id: createdId, by: who, viaAction: name });
      }
      if (replay) {
        const r2 = await a.z.actions.run(name, args, { idempotencyKey: key });
        must(createdIdOf(r2) === createdId, `idempotent replay returned a different record: ${JSON.stringify(r1)} vs ${JSON.stringify(r2)}`);
      }
      return { result: r1, createdId, key };
    },

    async counter(coll, id, field, who = "admin") {
      const r = await ctx.get(who, coll, id);
      must(r, `${who} cannot read ${coll}/${id}`);
      return r.data[field];
    },

    async aggregate(who, name, filter = {}) {
      const r = await (await ctx.actor(who)).z.aggregates.run(name, { filter });
      must(typeof r?.value === "number", `aggregate ${name} returned ${JSON.stringify(r)}`);
      return r.value;
    },

    async grantRole(who, role) {
      const uid = await ctx.userId(who);
      must(uid, `no user id for ${who}`);
      const adm = await ctx.actor("admin");
      const m = await adm.z.members.setRole(uid, role);
      must(m?.role === role, `setRole returned ${JSON.stringify(m)}`);
      let cursor;
      for (let i = 0; i < 20; i++) {
        const page = await adm.z.members.list({ limit: 50, ...(cursor ? { cursor } : {}) });
        const items = page?.items ?? page?.members ?? [];
        const hit = items.find((x) => x.user_id === uid);
        if (hit) { must(hit.role === role, `members.list shows role ${hit.role}`); return { detail: `${who} -> ${role}` }; }
        cursor = page?.next_cursor;
        if (!cursor) break;
      }
      throw new Fail(`${who} not found in members.list after setRole`);
    },
    async revokeRole(who) {
      const uid = await ctx.userId(who);
      if (uid) await (await ctx.actor("admin")).z.members.setRole(uid, "user");
    },

    async upload(who, area, tag = "f") {
      const a = await ctx.actor(who);
      const name = `kk-${tag}-${run}.txt`;
      const body = `kill-kit ${run} ${tag} ${randomUUID()}`;
      await a.z.storage.upload(area, new Blob([body], { type: "text/plain" }), { name });
      uploads.push({ area, name, by: who });
      const url = await a.z.storage.url(area, name);
      const res = await conn.fetch(url, { method: "GET", headers: {} });
      const text = await res.text();
      must(res.status === 200 && text === body, `download of ${area}/${name}: ${res.status}, bytes ${text === body ? "equal" : "DIFFER"}`);
      const listed = await a.z.storage.list(area);
      must(listed.some((f) => f.name === name), `${area}/${name} missing from ${who}'s list`);
      return name;
    },

    async fileHidden(who, area, name) {
      const a = await ctx.actor(who);
      let listed = [];
      try { listed = await a.z.storage.list(area); } catch (e) { const bad = instrumentFailure(e); if (bad) throw new Fail(bad); }
      must(!listed.some((f) => f.name === name), `${who} sees ${area}/${name} in a list`);
      return ctx.refused(async () => {
        const url = await a.z.storage.url(area, name);
        const res = await conn.fetch(url, { method: "GET", headers: {} });
        if (res.status === 200) return `downloaded ${url}`;
        if (![401, 403, 404].includes(res.status)) throw new Fail(`unauthorized download answered HTTP ${res.status}, not a denial`);
        throw Object.assign(new Error("download refused"), { code: "not_found", reason: `http_${res.status}` });
      });
    },

    gone(...ids) { for (const r of created) if (ids.includes(r.id)) r.gone = true; },

    step: (id, fn) => rep.step(id, fn),
    async v2step(id, fn) {
      if (!v2) { rep.skip(id, "pending K3: needs the v2 SDK/server"); return undefined; }
      return rep.step(id, fn);
    },
  };

  try {
    await scenario(ctx);
    await sweeps(ctx);
  } catch (e) {
    rep.fail("journey.aborted", e instanceof Fail ? e.message : `${e?.name ?? ""} ${e?.message ?? e}`);
  } finally {
    await cleanup(ctx, uploads);
  }
  return rep.finish({ created: created.length, uploads: uploads.length });
}

async function sweeps(ctx) {
  const { man, rep, created, actors } = ctx;
  for (const rec of created.filter((r) => !r.gone)) {
    const c = man.collections[rec.coll];
    const getRule = c.rules.get ?? [];
    const tag = `${rec.coll}.${rec.id.slice(0, 8)}`;
    let state = null;
    if (c.states) { try { state = (await ctx.get("admin", rec.coll, rec.id))?.data?.[c.states.field] ?? null; } catch { state = null; } }
    const stateRead = ctx.v2 && state ? c.states.read?.[state] : undefined;
    const anyoneReads = getRule.includes("anyone") && (!stateRead || stateRead.includes("anyone"));
    const adminIn = (ps) => ps.some((p) => p === "admin" || p === "anyone" || p === "signed_in");
    if (adminIn(getRule) && (!stateRead || adminIn(stateRead))) {
      await rep.step(`sweep.admin_sees.${tag}`, () => ctx.sees("admin", rec.coll, rec.id, { inList: false }));
    }
    if (!anyoneReads) await rep.step(`sweep.visitor_denied.${tag}`, () => ctx.hidden("visitor", rec.coll, rec.id));
    await rep.step(`sweep.anon_update_refused.${tag}`, () => ctx.refused(() => actors.visitor.z.data.collection(rec.coll).update(rec.id, anonPatch(ctx, rec.coll)), ["not_found", "not_allowed", "forbidden", "anonymous_write_forbidden"]));
    await rep.step(`sweep.anon_delete_refused.${tag}`, () => ctx.refused(() => actors.visitor.z.data.collection(rec.coll).delete(rec.id), ["not_found", "not_allowed", "forbidden", "anonymous_write_forbidden"]));
  }
  if (!created.length) rep.warn("sweep.nothing_created", "the scenario created no records");
}

function anonPatch(ctx, coll) {
  const c = ctx.man.collections[coll];
  const k = Object.keys(c.schema.properties).find((f) => f !== c.states?.field && !c.references?.[f]);
  return { [k]: sample(c.schema.properties[k], ctx.marker("anon")) };
}

async function cleanup(ctx, uploads) {
  const { rep, created, man } = ctx;
  let failed = 0;
  for (const rec of [...created].reverse()) {
    const del = man.collections[rec.coll].rules.delete ?? [];
    const order = [del.includes("admin") ? "admin" : null, rec.by !== "visitor" && rec.by !== "admin" ? rec.by : null].filter(Boolean);
    let ok = false;
    for (const who of order) {
      try { await (await ctx.actor(who)).z.data.collection(rec.coll).delete(rec.id); ok = true; break; } catch (e) { if (e?.code === "not_found") { ok = true; break; } }
    }
    if (!ok) failed++;
  }
  for (const f of uploads) {
    try { await (await ctx.actor(f.by)).z.storage.remove(f.area, f.name); } catch { failed++; }
  }
  if (failed) rep.warn("cleanup", `${failed} record(s)/file(s) left behind: delete them as the site admin (RUNBOOK.md, Cleanup)`);
  else rep.pass("cleanup", `${created.length} records, ${uploads.length} files removed`);
}

async function dedicatedJourney({ rep, base, man, dedicated }) {
  await rep.step("dedicated.capabilities_declared", async () => {
    must(Array.isArray(man.capabilities) && man.capabilities.length > 0, "manifest declares no capability");
    return { detail: man.capabilities.join(",") };
  });
  if (isDev(base)) {
    rep.skip("dedicated.live", "a dedicated project cannot be dry-run in-process");
    return rep.finish({ dedicated: true });
  }
  const origin = new URL(base).origin;
  await rep.step("dedicated.home_live", async () => {
    const r = await fetch(origin + "/", { redirect: "follow" });
    must(r.status === 200 && /text\/html/.test(r.headers.get("content-type") ?? ""), `GET / -> ${r.status} ${r.headers.get("content-type")}`);
    return { detail: r.status };
  });
  await rep.step("dedicated.not_pooled", async () => {
    const r = await fetch(origin + "/api/site", { headers: { accept: "application/json", origin }, redirect: "manual" });
    const ct = r.headers.get("content-type") ?? "";
    let j = null;
    try { j = /json/.test(ct) ? await r.json() : null; } catch { j = null; }
    if (r.status === 404) return { detail: "GET /api/site -> 404 (not a pooled host)" };
    if (r.status === 200 && /text\/html/.test(ct)) return { detail: "GET /api/site -> the app's HTML (not a pooled host)" };
    if (r.status === 200 && j?.data?.mode === "dedicated") return { detail: "GET /api/site -> mode dedicated" };
    throw new Fail(`GET /api/site -> ${r.status} ${ct} ${JSON.stringify(j?.data ?? null)?.slice(0, 120)}: not proof of graduation (pooled answer, error or redirect)`);
  });
  let manual = {};
  try { manual = process.env.KK_MANUAL_RESULTS ? JSON.parse(readFileSync(process.env.KK_MANUAL_RESULTS, "utf8"))?.[dedicated.n] ?? {} : {}; } catch (e) { rep.fail("dedicated.manual_results", `cannot read KK_MANUAL_RESULTS: ${e.message}`); }
  for (const f of dedicated.manualFlows ?? []) {
    const v = manual[f.id];
    if (v === "pass") rep.pass(`dedicated.manual.${f.id}`, `recorded by a human: ${f.what}`);
    else if (v === undefined) rep.skip(`dedicated.manual.${f.id}`, `human check (RUNBOOK.md): ${f.what}`);
    else rep.fail(`dedicated.manual.${f.id}`, `recorded ${JSON.stringify(v)}: ${f.what}`);
  }
  return rep.finish({ dedicated: true });
}

export async function main(meta, scenario) {
  const base = process.argv[2];
  if (!base) { console.error(`usage: tsx ${process.argv[1]} https://<qa-site-host> | dev:<label>`); process.exit(2); }
  const manifestPath = new URL(`../sites/${meta.n}/zavi-site.json`, meta.url).pathname;
  const code = await runJourney({ ...meta, base, manifestPath, scenario });
  process.exit(code);
}

export const EXPECT = {
  hidden: ["not_found", "not_allowed", "forbidden"],
  unique: ["unique_conflict"],
  invalidRef: ["invalid_reference"],
  transitionDenied: ["not_found", "not_allowed"],
  transitionIllegal: ["transition_conflict", "not_found"],
  bound: ["action_bound"],
  actionDenied: ["action_not_allowed", "not_allowed", "forbidden"],
  aggregateDenied: ["aggregate_not_allowed", "not_allowed", "forbidden"],
  restrict: ["conflict"],
  rawField: ["validation", "schema_violation"],
  serverOwned: ["not_allowed", "validation", "forbidden", "field_not_writable", "system_field_immutable"],
};
