#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CF = "https://api.cloudflare.com/client/v4";
const PLACEHOLDER_IP = "192.0.2.1";
const PROD_SUPABASE_REF = "wmycgyjsenvgtczlupoe";
const AMPLIFY_LABELS = ["latest", "staging", "marketplaces", "solo", "growth", "saas", "startup"];
const EXCLUDED_LABELS = ["www", "api", "admin", "latest", "staging"];
const UNPUBLISHED_TEXT = "published yet";

function parseArgs(argv) {
  const out = { mode: argv[0], apply: false, zone: "zaviagent.com", workers: {
    prodStatic: "zavi-static-host", prodGateway: "zavi-site-gateway",
    devStatic: "zavi-static-host-dev", devGateway: "zavi-site-gateway-dev",
  } };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--env") out.env = argv[++i];
    else if (a === "--backup") out.backup = argv[++i];
    else if (a === "--zone-name") out.zone = argv[++i];
    else if (a === "--prod-static") out.workers.prodStatic = argv[++i];
    else if (a === "--prod-gateway") out.workers.prodGateway = argv[++i];
    else if (a === "--dev-static") out.workers.devStatic = argv[++i];
    else if (a === "--dev-gateway") out.workers.devGateway = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!["plan", "routing", "cleanup", "rollback"].includes(out.mode)) throw new Error("mode is plan | routing | cleanup | rollback");
  if (!out.env) throw new Error("--env <file> is required");
  return out;
}

function readEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function cloudflare(token, zoneId) {
  async function call(method, p, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${CF}${p}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 429 && attempt < 5) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok || json.success === false) {
        throw new Error(`${method} ${p} failed (${res.status}): ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
      }
      return json.result;
    }
  }
  return {
    records: () => call("GET", `/zones/${zoneId}/dns_records?per_page=5000`),
    routes: () => call("GET", `/zones/${zoneId}/workers/routes`),
    createRecord: (r) => call("POST", `/zones/${zoneId}/dns_records`, r),
    putRecord: (id, r) => call("PUT", `/zones/${zoneId}/dns_records/${id}`, r),
    deleteRecord: (id) => call("DELETE", `/zones/${zoneId}/dns_records/${id}`),
    createRoute: (pattern, script) => call("POST", `/zones/${zoneId}/workers/routes`, script ? { pattern, script } : { pattern }),
    deleteRoute: (id) => call("DELETE", `/zones/${zoneId}/workers/routes/${id}`),
  };
}

async function probe(url) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    const text = res.status === 404 ? await res.text().catch(() => "") : "";
    let code = "";
    try { code = String(JSON.parse(text)?.error?.code ?? ""); } catch {  }
    return {
      status: res.status,
      deploy: res.headers.get("x-zavi-deploy-id") ?? "",
      gateway: res.headers.has("x-request-id"),
      code,
      render: res.headers.get("x-render-routing") ?? "",
      location: res.headers.get("location") ?? "",
      unpublished: text.includes(UNPUBLISHED_TEXT),
    };
  } catch (e) {
    return { status: 0, deploy: "", gateway: false, code: "", render: "", location: "", unpublished: false, error: String(e.message ?? e) };
  }
}

async function probeAll(urls) {
  const out = {};
  const queue = [...urls];
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (queue.length) { const u = queue.shift(); out[u] = await probe(u); }
  }));
  return out;
}

function writeBackup(zone, records, routes) {
  const dir = path.join(os.homedir(), ".zavi");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cf-zone-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ zone, taken_at: new Date().toISOString(), records, routes }, null, 2), { mode: 0o600 });
  return file;
}

function classify(zone, workers, records, routes) {
  const ours = new Set(Object.values(workers));
  const wildcardName = `*.${zone}`;
  const wildcard = records.find((r) => r.name === wildcardName && ["A", "AAAA", "CNAME"].includes(r.type));
  const oneLabel = (name) => name.endsWith(`.${zone}`) && !name.slice(0, -(zone.length + 1)).includes(".");
  const placeholders = records.filter((r) => r.type === "A" && r.content === PLACEHOLDER_IP && r.name !== wildcardName && oneLabel(r.name));
  const placeholderHosts = new Set(placeholders.map((r) => r.name));
  const siteRoutes = routes.filter((r) => {
    const host = r.pattern.split("/")[0];
    return placeholderHosts.has(host) && ours.has(r.script) && (r.pattern === `${host}/*` || r.pattern === `${host}/api/*`);
  });
  const render = records.filter((r) => r.type === "CNAME" && r.content.endsWith(".onrender.com") && !r.proxied);
  const isDev = (host) => host.endsWith(`-dev.${zone}`);
  const wanted = [
    { pattern: `*.${zone}/api/*`, script: workers.prodGateway },
    { pattern: `*.${zone}/*`, script: workers.prodStatic },
    ...EXCLUDED_LABELS.map((l) => ({ pattern: `${l}.${zone}/*`, script: null })),
    { pattern: `${zone}/*`, script: null },
  ];
  const amplify = AMPLIFY_LABELS.map((l) => `${l}.${zone}`);
  const prodSiteRoutes = siteRoutes.filter((r) => !isDev(r.pattern.split("/")[0]));
  return { wildcard, placeholders, siteRoutes, prodSiteRoutes, render, wanted, amplify, isDev };
}

const sitePaths = (host) => [`https://${host}/`, `https://${host}/api/__zavi_cutover_probe`];

async function siteUrls(zone, c) {
  const urls = [`https://${zone}/`, `https://www.${zone}/`, `https://latest.${zone}/`, `https://staging.${zone}/`,
    `https://marketplaces.${zone}/`, `https://api.${zone}/health`, `https://admin.${zone}/`];
  for (const r of c.placeholders) urls.push(...sitePaths(r.name));
  return urls;
}

function diffProbes(before, after, keys) {
  const bad = [];
  for (const k of keys) {
    const b = before[k], a = after[k];
    if (!b || !a) continue;
    if (b.status !== a.status || b.deploy !== a.deploy || b.gateway !== a.gateway || b.code !== a.code) {
      const show = (p) => `${p.status}/${p.deploy || "-"}${p.gateway ? "/gateway" : ""}${p.code ? `/${p.code}` : ""}`;
      bad.push(`${k}: ${show(b)} -> ${show(a)}${a.error ? ` (${a.error})` : ""}`);
    }
  }
  return bad;
}

async function probeUntilSame(before, keys, tries = 10, gapMs = 30000) {
  let bad = [];
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(gapMs);
    bad = diffProbes(before, await probeAll(keys), keys);
    if (bad.length === 0) return [];
    log(`  ...${bad.length} host(s) differ, retry ${i + 1}/${tries}`);
  }
  return bad;
}

async function routing(cf, zone, workers, apply) {
  const records = await cf.records();
  const routes = await cf.routes();
  log(`backup: ${writeBackup(zone, records, routes)}`);
  const c = classify(zone, workers, records, routes);
  if (!c.wildcard) throw new Error(`no *.${zone} record found`);
  log(`\n*.${zone} now: ${c.wildcard.type} ${c.wildcard.content} proxied=${c.wildcard.proxied}`);
  const target = c.wildcard.type === "CNAME" ? c.wildcard.content : null;
  const routePlan = [];
  for (const w of c.wanted) {
    const existing = routes.find((r) => r.pattern === w.pattern);
    if (existing && (existing.script ?? null) !== w.script) throw new Error(`route ${w.pattern} already belongs to ${existing.script ?? "no Worker"}`);
    if (!existing) routePlan.push(w);
  }
  const cnamePlan = c.amplify.filter((name) => !records.some((r) => r.name === name));
  if (cnamePlan.length && !target) throw new Error("wildcard is not a CNAME; cannot copy its target to the Amplify names");
  log("ROUTING changes:");
  for (const w of routePlan) log(`  + route ${w.pattern} -> ${w.script ?? "(no Worker: excluded)"}`);
  for (const n of cnamePlan) log(`  + CNAME ${n} -> ${target} (DNS only)`);
  const switchNeeded = !(c.wildcard.type === "A" && c.wildcard.content === PLACEHOLDER_IP && c.wildcard.proxied);
  if (switchNeeded) log(`  ~ *.${zone}: ${c.wildcard.type} ${c.wildcard.content} -> A ${PLACEHOLDER_IP} proxied`);
  if (!apply) return c;

  const urls = await siteUrls(zone, c);
  log(`\nprobing ${urls.length} hosts before the change...`);
  const before = await probeAll(urls);
  const undo = [];
  const undoAll = async () => {
    const failed = [];
    for (const step of undo.reverse()) await step().catch((e) => failed.push(e.message));
    if (failed.length) throw new Error(`UNDO INCOMPLETE, fix by hand from the backup: ${failed.join("; ")}`);
    log("  undone; the zone is back to how it was before this run");
  };
  try {
    for (const w of routePlan) {
      const r = await cf.createRoute(w.pattern, w.script);
      undo.push(() => cf.deleteRoute(r.id));
      log(`  created route ${w.pattern}`);
    }
    for (const n of cnamePlan) {
      const r = await cf.createRecord({ type: "CNAME", name: n, content: target, proxied: false, ttl: 1 });
      undo.push(() => cf.deleteRecord(r.id));
      log(`  created CNAME ${n}`);
    }
    const amplifyBad = await probeUntilSame(before, urls.filter((u) => !u.includes("/api/")), 6, 20000);
    if (amplifyBad.length) throw new Error(`hosts changed before the switch: ${amplifyBad.join("; ")}`);
    if (switchNeeded) {
      const old = c.wildcard;
      await cf.putRecord(old.id, { type: "A", name: `*.${zone}`, content: PLACEHOLDER_IP, proxied: true, ttl: 1 });
      undo.push(() => cf.putRecord(old.id, { type: old.type, name: old.name, content: old.content, proxied: old.proxied, ttl: old.ttl }));
      log(`  switched *.${zone} to the Worker`);
    }
  } catch (e) {
    log(`
FAILED: ${e.message}`);
    await undoAll();
    process.exitCode = 1;
    return c;
  }

  log("\nverifying (DNS caches can take a few minutes)...");
  const bad = await probeUntilSame(before, urls);
  const rnd = Math.random().toString(36).slice(2, 8);
  let fresh = [];
  for (let i = 0; i < 10; i++) {
    if (i > 0) await sleep(30000);
    const p = await probeAll([`https://zz-wc-${rnd}.${zone}/`, `https://zz-wc-${rnd}-dev.${zone}/`]);
    fresh = Object.entries(p).filter(([, v]) => !(v.status === 404 && v.unpublished)).map(([k, v]) => `${k}: ${v.status}`);
    if (fresh.length === 0) break;
  }
  if (bad.length || fresh.length) {
    log("\nVERIFY FAILED:");
    for (const b of [...bad, ...fresh]) log(`  ${b}`);
    await undoAll();
    process.exitCode = 1;
  } else {
    log(`\nVERIFY OK: ${urls.length} hosts unchanged; unknown names reach the site Workers.`);
  }
  return c;
}

async function supabase(env) {
  const url = (env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url.includes(PROD_SUPABASE_REF) || !key) throw new Error("cleanup needs the PROD SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  return {
    async domainRows() {
      const res = await fetch(`${url}/rest/v1/tenant_resources?resource_kind=eq.domain&select=tenant_id,mode,external_ref`, { headers: h });
      if (!res.ok) throw new Error(`tenant_resources read failed (${res.status})`);
      return res.json();
    },
    async hostingServiceId(tenantId) {
      const res = await fetch(`${url}/rest/v1/tenant_resources?tenant_id=eq.${tenantId}&resource_kind=eq.hosting&select=external_ref`, { headers: h });
      const rows = res.ok ? await res.json() : [];
      return rows[0]?.external_ref?.render_service_id ?? null;
    },
    async deleteDomainRow(tenantId, hostname) {
      const q = `tenant_id=eq.${tenantId}&resource_kind=eq.domain&external_ref->>hostname=eq.${encodeURIComponent(hostname)}`;
      const res = await fetch(`${url}/rest/v1/tenant_resources?${q}`, { method: "DELETE", headers: { ...h, Prefer: "return=representation" } });
      if (!res.ok) throw new Error(`tenant_resources delete failed (${res.status})`);
      return (await res.json()).length;
    },
  };
}

async function renderDetach(key, serviceId, idOrName) {
  if (!key || !serviceId || !idOrName) return "skipped (no key or ids)";
  const res = await fetch(`https://api.render.com/v1/services/${serviceId}/custom-domains/${encodeURIComponent(idOrName)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${key}` },
  });
  return res.ok || res.status === 404 ? "detached" : `detach failed (${res.status})`;
}

async function deleteSite(cf, host, c) {
  for (const r of c.prodSiteRoutes.filter((x) => x.pattern.startsWith(`${host}/`))) await cf.deleteRoute(r.id);
  for (const r of c.placeholders.filter((x) => x.name === host)) await cf.deleteRecord(r.id);
}

async function restoreSite(cf, host, c) {
  const failed = [];
  for (const r of c.placeholders.filter((x) => x.name === host)) {
    await cf.createRecord({ type: "A", name: r.name, content: r.content, proxied: true, ttl: r.ttl ?? 1 }).catch((e) => failed.push(e.message));
  }
  for (const r of c.prodSiteRoutes.filter((x) => x.pattern.startsWith(`${host}/`))) {
    await cf.createRoute(r.pattern, r.script).catch((e) => failed.push(e.message));
  }
  return failed;
}

async function restoreSites(cf, hosts, c) {
  const failed = [];
  for (const h of hosts) failed.push(...(await restoreSite(cf, h, c)));
  return failed.length ? `RESTORE INCOMPLETE, fix by hand from the backup: ${failed.join("; ")}` : "restored";
}

async function cleanup(cf, zone, workers, env, apply) {
  const records = await cf.records();
  const routes = await cf.routes();
  log(`backup: ${writeBackup(zone, records, routes)}`);
  const c = classify(zone, workers, records, routes);
  const ready = c.wildcard?.type === "A" && c.wildcard.content === PLACEHOLDER_IP && c.wildcard.proxied
    && c.wanted.every((w) => routes.some((r) => r.pattern === w.pattern && r.script === w.script));
  if (!ready && apply) throw new Error("run `routing --apply` (and let it verify) before cleanup");
  const sb = await supabase(env);
  const rows = await sb.domainRows();
  const byHost = new Map(rows.map((r) => [String(r.external_ref?.hostname ?? "").toLowerCase(), r]));
  const renderLinked = c.render.filter((r) => byHost.has(r.name));
  const targets = await probeAll(c.render.map((r) => `https://${r.content}/`));
  const isDead = (r) => {
    const t = targets[`https://${r.content}/`];
    return t?.render === "no-server" || (t?.render ?? "").startsWith("suspend");
  };
  log(`CLEANUP changes:`);
  log(`  - ${c.placeholders.length} per-site placeholder records and ${c.prodSiteRoutes.length} prod per-site routes (${c.siteRoutes.length - c.prodSiteRoutes.length} dev routes kept)`);
  log(`  - ${c.render.length} Render CNAMEs (${renderLinked.length} release a tenant built-in-domain row, ${c.render.length - renderLinked.length} have no row)`);
  log(`      ${c.render.filter((r) => !isDead(r)).length} NOT marked dead by Render will be SKIPPED: ${c.render.filter((r) => !isDead(r)).map((r) => r.name).join(", ") || "none"}`);
  for (const r of c.render) log(`      ${r.name}${byHost.has(r.name) ? `  [row: tenant ${byHost.get(r.name).tenant_id.slice(0, 8)}, status ${byHost.get(r.name).external_ref?.status ?? "none"}]` : ""}`);
  log(`  zone records after: ~${records.length - c.placeholders.length - c.render.length}`);
  if (!apply) return;

  const hosts = [...new Set(c.placeholders.map((r) => r.name))];
  const before = await probeAll(hosts.flatMap(sitePaths));
  const live = (h) => before[`https://${h}/`]?.status === 200;
  const canaries = [hosts.find((h) => !c.isDev(h) && live(h)), hosts.find((h) => c.isDev(h) && live(h))].filter(Boolean);
  if (canaries.length < 2) throw new Error("need one live prod site and one live dev site as canaries");
  log(`\ncanary: ${canaries.join(", ")}`);
  for (const h of canaries) await deleteSite(cf, h, c);
  const canaryBad = await probeUntilSame(before, canaries.flatMap(sitePaths), 8, 15000);
  if (canaryBad.length) {
    throw new Error(`canary failed (${await restoreSites(cf, canaries, c)}): ${canaryBad.join("; ")}`);
  }
  log("canary OK, deleting the rest...");
  const rest = hosts.filter((x) => !canaries.includes(x));
  for (const h of rest) await deleteSite(cf, h, c);
  const bad = await probeUntilSame(before, hosts.flatMap(sitePaths), 6, 20000);
  if (bad.length) {
    throw new Error(`sites changed after cleanup (${await restoreSites(cf, hosts, c)}); Render untouched: ${bad.join("; ")}`);
  }

  log("\nreleasing Render built-in domains...");
  const recheck = await probeAll(c.render.map((r) => `https://${r.content}/`));
  for (const r of c.render) {
    const t = recheck[`https://${r.content}/`];
    const dead = t?.render === "no-server" || (t?.render ?? "").startsWith("suspend");
    if (!dead) {
      log(`  ${r.name}: SKIPPED, ${r.content} answers ${t?.status ?? "nothing"} ${t?.render || "(no Render dead marker)"}`);
      continue;
    }
    const row = byHost.get(r.name);
    let note = "no row";
    if (row) {
      const svc = row.external_ref?.render_service_id ?? (await sb.hostingServiceId(row.tenant_id));
      const detach = await renderDetach(env.RENDER_API_KEY, svc, row.external_ref?.custom_domain_id ?? r.name);
      const n = await sb.deleteDomainRow(row.tenant_id, r.name);
      note = `row deleted (${n}), render ${detach}`;
    }
    await cf.deleteRecord(r.id);
    log(`  ${r.name}: CNAME deleted, ${note}`);
  }
  log(`\nzone records now: ${(await cf.records()).length}`);
}

async function rollback(cf, zone, workers, backupFile, apply) {
  if (!backupFile) throw new Error("rollback needs --backup <file>");
  const backup = JSON.parse(fs.readFileSync(backupFile, "utf8"));
  const records = await cf.records();
  const routes = await cf.routes();
  log(`backup of current state: ${writeBackup(zone, records, routes)}`);
  const old = classify(zone, workers, backup.records, backup.routes);
  const now = classify(zone, workers, records, routes);
  const steps = [];
  if (old.wildcard && now.wildcard && (old.wildcard.type !== now.wildcard.type || old.wildcard.content !== now.wildcard.content || old.wildcard.proxied !== now.wildcard.proxied)) {
    steps.push([`restore *.${zone} -> ${old.wildcard.type} ${old.wildcard.content}`, () => cf.putRecord(now.wildcard.id, {
      type: old.wildcard.type, name: old.wildcard.name, content: old.wildcard.content, proxied: old.wildcard.proxied, ttl: old.wildcard.ttl,
    })]);
  }
  for (const w of now.wanted) {
    const cur = routes.find((r) => r.pattern === w.pattern && r.script === w.script);
    if (cur && !backup.routes.some((r) => r.pattern === w.pattern)) steps.push([`delete route ${w.pattern}`, () => cf.deleteRoute(cur.id)]);
  }
  for (const name of now.amplify) {
    const cur = records.find((r) => r.name === name);
    if (cur && !backup.records.some((r) => r.name === name)) steps.push([`delete CNAME ${name}`, () => cf.deleteRecord(cur.id)]);
  }
  for (const r of old.placeholders) {
    if (!records.some((x) => x.name === r.name)) steps.push([`recreate ${r.name}`, () => cf.createRecord({ type: "A", name: r.name, content: r.content, proxied: true, ttl: r.ttl ?? 1 })]);
  }
  for (const r of old.siteRoutes) {
    if (!routes.some((x) => x.pattern === r.pattern)) steps.push([`recreate route ${r.pattern}`, () => cf.createRoute(r.pattern, r.script)]);
  }
  log("ROLLBACK changes:");
  for (const [label] of steps) log(`  ${label}`);
  if (!apply) return;
  for (const [label, run] of steps) { await run(); log(`  done: ${label}`); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = readEnv(args.env);
  if (!env.CLOUDFLARE_STATIC_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) throw new Error("env file needs CLOUDFLARE_STATIC_API_TOKEN and CLOUDFLARE_ZONE_ID");
  const cf = cloudflare(env.CLOUDFLARE_STATIC_API_TOKEN, env.CLOUDFLARE_ZONE_ID);
  if (!args.apply) log("DRY RUN (add --apply to write)\n");
  if (args.mode === "plan") {
    await routing(cf, args.zone, args.workers, false);
    log("");
    await cleanup(cf, args.zone, args.workers, env, false);
  } else if (args.mode === "routing") await routing(cf, args.zone, args.workers, args.apply);
  else if (args.mode === "cleanup") await cleanup(cf, args.zone, args.workers, env, args.apply);
  else await rollback(cf, args.zone, args.workers, args.backup, args.apply);
}

main().catch((e) => {
  console.error(`ERROR: ${e.message}`);
  process.exit(1);
});
