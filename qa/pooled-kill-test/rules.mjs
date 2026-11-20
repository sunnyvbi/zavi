import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { KIT } from "./lib/paths.mjs";
import { connect, isDev, client } from "./lib/transport.mjs";
import { mailboxFromEnv } from "./lib/mailbox.mjs";
import { admin as adminActor, completeLink, Fail, must, newPassword, reporter, runId, testEmail, user } from "./lib/kit.mjs";
import { v1Projection } from "./lib/contract-v2.mjs";
import { validatorSupportsV2 } from "./lib/paths.mjs";

const [baseA, baseB] = process.argv.slice(2);
if (!baseA || !baseB || baseA === baseB || isDev(baseA) !== isDev(baseB)) {
  console.error("usage: tsx rules.mjs https://<qa-site-a> https://<qa-site-b>   |   tsx rules.mjs dev:a dev:b");
  process.exit(2);
}
const dev = isDev(baseA);
const run = runId();
const QUOTA_MAX_ATTEMPTS = Number(process.env.KK_QUOTA_MAX_ATTEMPTS || 60);
const LOGIN_LIMIT = Number(process.env.KK_LOGIN_LIMIT || 10);
const rep = reporter({ kind: "rules", run, sites: { A: baseA, B: baseB }, started_at: new Date().toISOString(), mode: dev ? "DEV DRY RUN (in-process SDK dev server). NOT the kill test." : "real" });

const manifestText = readFileSync(`${KIT}/attack-site.zavi-site.json`, "utf8");
const probe = await connect(dev ? `dev:probe-${run}` : baseA, dev ? { manifestText: JSON.stringify(v1Projection(JSON.parse(manifestText))) } : {});
const v2 = validatorSupportsV2(probe.real.validateManifest);
const devText = v2 ? manifestText : JSON.stringify(v1Projection(JSON.parse(manifestText)));
const devQuotas = { maxRecords: 40 };
const S = {
  A: { name: "A", conn: dev ? await connect(`dev:${baseA.slice(4)}-${run}`, { manifestText: devText, devQuotas }) : probe },
  B: { name: "B", conn: await connect(dev ? `dev:${baseB.slice(4)}-${run}` : baseB, dev ? { manifestText: devText, devQuotas } : {}) },
};
S.A.other = S.B;
S.B.other = S.A;
const mailbox = dev ? null : mailboxFromEnv();
const cleanup = [];

async function setup(s) {
  const r = await s.conn.raw("GET", "/api/site");
  must(r.status === 200 && typeof r.json?.data?.site_id === "string", `${s.name}: GET /api/site -> ${r.status}`);
  s.siteId = r.json.data.site_id;
  s.admin = await adminActor(s.conn, mailbox);
  s.user = await user(s.conn, mailbox, `r${s.name.toLowerCase()}`, { run });
  s.token = await s.user.z.auth.accessToken();
  s.refresh = s.user.z.auth.session()?.refresh_token;
  s.note = (await s.user.z.data.collection("notes").create({ title: `kk ${run} ${s.name}`, body: "private" })).id;
  cleanup.push(() => s.user.z.data.collection("notes").delete(s.note));
  s.file = `kk-${run}-${s.name}.txt`;
  await s.user.z.storage.upload("uploads", new Blob([`secret ${s.name} ${run}`], { type: "text/plain" }), { name: s.file });
  cleanup.push(() => s.user.z.storage.remove("uploads", s.file));
  if (v2) {
    s.listing = (await s.user.z.data.collection("listings").create({ title: `kk ${run} ${s.name}` })).id;
    cleanup.push(() => s.user.z.data.collection("listings").delete(s.listing));
  }
  return { detail: s.siteId };
}
for (const s of [S.A, S.B]) {
  const ok = await rep.step(`setup.${s.name}`, () => setup(s));
  if (!ok) { rep.fail("setup", `site ${s.name} could not be set up: nothing else can be judged`); await finish(); }
}
if (S.A.siteId === S.B.siteId) { rep.fail("setup.distinct_sites", "A and B resolve to the SAME site id: pass two different QA sites"); await finish(); }

function refusedHttp(r, what, reasons = null) {
  must(r.status >= 400 && r.status < 500, `${what}: HTTP ${r.status} ${r.code ?? ""} (expected a 4xx refusal)`);
  if (reasons) must(reasons.includes(r.code), `${what}: refused with ${r.code}, expected ${reasons.join("|")}`);
  return `${r.status} ${r.code ?? ""}`;
}
const inboxData = (body) => ({ name: "kk", body, ...(v2 ? {} : { status: "new" }) });
const devGap = (id, msg) => rep.warn(id, `DEV PARITY GAP (dev server differs from the gateway; not a product verdict): ${msg}`);

const TESTS = [
  {
    id: "R1_session_bound_to_its_site",
    rule: "A session minted on one site is rejected on the other site's host.",
    async run(s) {
      const o = s.other;
      const list = await o.conn.raw("GET", "/api/data/notes?limit=10", { token: s.token });
      const d1 = refusedHttp(list, `${s.name} token listing ${o.name} notes`);
      const create = await o.conn.raw("POST", "/api/data/notes", { token: s.token, headers: { "idempotency-key": `kk-${randomUUID()}` }, body: { data: { title: "cross-site" } } });
      const d2 = refusedHttp(create, `${s.name} token creating on ${o.name}`);
      const get = await o.conn.raw("GET", `/api/data/notes/${o.note}`, { token: s.token });
      const d3 = refusedHttp(get, `${s.name} token reading ${o.name}'s note`);
      let d4 = "no refresh token";
      if (s.refresh) d4 = refusedHttp(await o.conn.raw("POST", "/api/auth/refresh", { body: { refresh_token: s.refresh } }), `${s.name} refresh token on ${o.name}`);
      const own = await s.conn.raw("GET", `/api/data/notes/${s.note}`, { token: await s.user.z.auth.accessToken() });
      must(own.status === 200, `control: ${s.name} token on its own site -> ${own.status}`);
      return { detail: { list: d1, create: d2, get: d3, refresh: d4 } };
    },
  },
  {
    id: "R2_site_from_hostname_only",
    rule: "The site is taken from the hostname only; a client-sent site id (header, query, body) is ignored.",
    async run(s) {
      const o = s.other;
      const spoof = { "x-zavi-site-id": o.siteId, "x-site-id": o.siteId, "zavi-site": o.siteId };
      const site = await s.conn.raw("GET", `/api/site?site_id=${o.siteId}`, { headers: spoof });
      must(site.status === 200 && site.json?.data?.site_id === s.siteId, `${s.name} /api/site with ${o.name}'s id in headers+query answered ${JSON.stringify(site.json?.data)}`);
      const token = await s.user.z.auth.accessToken();
      const create = await s.conn.raw("POST", `/api/data/notes?site_id=${o.siteId}`, { token, headers: { ...spoof, "idempotency-key": `kk-${randomUUID()}` }, body: { site_id: o.siteId, data: { title: `kk spoof ${run}` } } });
      let where = `refused ${create.status} ${create.code ?? ""}`;
      if (create.status >= 200 && create.status < 300) {
        const id = create.json?.data?.id;
        must(typeof id === "string", `spoofed create returned ${JSON.stringify(create.json)}`);
        cleanup.push(() => s.user.z.data.collection("notes").delete(id));
        must((await s.user.z.data.collection("notes").get(id))?.id === id, `the spoofed create is not on ${s.name}`);
        const onOther = await o.admin.z.data.collection("notes").get(id).catch((e) => (e?.code === "not_found" ? null : Promise.reject(e)));
        must(onOther === null, `the spoofed create landed on ${o.name}`);
        where = `created on ${s.name}, invisible on ${o.name}`;
      } else must(create.status >= 400 && create.status < 500, `spoofed create -> ${create.status}`);
      const anon = await s.conn.raw("POST", "/api/data/inbox", { headers: { ...spoof, "idempotency-key": `kk-${randomUUID()}` }, body: { site_id: o.siteId, data: inboxData(`spoof ${run} ${s.name}`) } });
      must(anon.status >= 200 && anon.status < 300, `anonymous create on inbox -> ${anon.status} ${anon.code} (Turnstile must be off on QA hosts, RUNBOOK.md)`);
      const anonId = anon.json?.data?.id;
      cleanup.push(() => s.admin.z.data.collection("inbox").delete(anonId));
      must((await s.admin.z.data.collection("inbox").get(anonId))?.id === anonId, `anonymous spoofed create not on ${s.name}`);
      const anonOnOther = await o.admin.z.data.collection("inbox").get(anonId).catch((e) => (e?.code === "not_found" ? null : Promise.reject(e)));
      must(anonOnOther === null, `anonymous spoofed create landed on ${o.name}`);
      return { detail: { site: s.siteId, signed_in_create: where, anonymous_create: anon.status } };
    },
  },
  {
    id: "R3_other_sites_record_not_found",
    rule: "Another site's record id is not found (get, update, delete, reference), even for this site's admin.",
    async run(s) {
      const o = s.other;
      const id = o.note;
      for (const [who, z] of [["user", s.user.z], ["admin", s.admin.z]]) {
        const got = await z.data.collection("notes").get(id).catch((e) => (e?.code === "not_found" ? null : Promise.reject(e)));
        must(got === null, `${s.name} ${who} can GET ${o.name}'s note`);
        for (const [op, fn] of [["update", () => z.data.collection("notes").update(id, { title: "pwned" })], ["delete", () => z.data.collection("notes").delete(id)]]) {
          try { await fn(); throw new Fail(`${s.name} ${who} could ${op} ${o.name}'s note`); } catch (e) {
            if (e instanceof Fail) throw e;
            must(e?.code === "not_found", `${s.name} ${who} ${op}: ${e?.code}/${e?.reason} (expected not_found)`);
          }
        }
      }
      const still = await o.user.z.data.collection("notes").get(id);
      must(still?.data?.title === `kk ${run} ${o.name}`, `${o.name}'s note was changed or removed`);
      let ref = "pending K3 (v2 references)";
      if (v2) {
        try {
          const r = await s.user.z.data.collection("requests").create({ listing_id: o.listing, message: "x" });
          cleanup.push(() => s.user.z.data.collection("requests").delete(r.id));
          throw new Fail(`a ${s.name} request referencing ${o.name}'s listing was ACCEPTED`);
        } catch (e) {
          if (e instanceof Fail) throw e;
          must(e?.reason === "invalid_reference", `cross-site reference refused with ${e?.code}/${e?.reason}, expected invalid_reference`);
          ref = "invalid_reference";
        }
      } else rep.skip(`R3_other_sites_record_not_found.${s.name}.cross_site_reference`, "pending K3: v2 references");
      return { detail: { get_update_delete: "not_found", reference: ref } };
    },
  },
  {
    id: "R4_storage_prefix_bound",
    rule: "A storage path outside the site's prefix is rejected (traversal names, encoded areas, other site's file and signed URL).",
    async run(s) {
      const o = s.other;
      const token = await s.user.z.auth.accessToken();
      const evil = ["../x.txt", "..%2Fx.txt", "a/../../x.txt", "/etc/passwd", `../../${o.siteId}/uploads/${o.file}`, `..\\${o.file}`, ".hidden", "x\u0000.txt", "%2e%2e/x.txt"];
      const seen = [];
      for (const name of evil) {
        const r = await s.conn.raw("POST", "/api/storage/uploads/upload-url", { token, body: { name, content_type: "text/plain", size: 4 } });
        seen.push(refusedHttp(r, `upload-url name ${JSON.stringify(name)}`));
      }
      for (const area of ["%2e%2e", "..%2Fuploads", "uploads%2F..%2F.."]) {
        const r = await s.conn.raw("GET", `/api/storage/${area}/list`, { token });
        if (dev && r.status === 200 && Array.isArray(r.json?.data?.items) && r.json.data.items.length === 0) devGap(`R4_storage_prefix_bound.${s.name}.area_${area}`, `dev server answers 200 [] for area ${area}; the gateway's matcher returns 404 for a non-name area`);
        else refusedHttp(r, `list area ${area}`);
      }
      const dl = await s.conn.raw("POST", "/api/storage/uploads/download-url", { token, body: { name: o.file } });
      refusedHttp(dl, `${s.name} download-url for ${o.name}'s file`);
      const url = await o.user.z.storage.url("uploads", o.file);
      if (!dev) {
        const u = new URL(url, o.conn.origin);
        refusedHttp(await s.conn.raw("GET", u.pathname + u.search), `${o.name}'s signed object URL on ${s.name}'s host`);
        const tampered = u.search.replace(/t=([^&]+)/, (_, t) => `t=${t.slice(0, -2)}${t.endsWith("aa") ? "bb" : "aa"}`);
        refusedHttp(await o.conn.raw("GET", u.pathname + tampered), `tampered signed URL on ${o.name}`);
      }
      const listed = await s.user.z.storage.list("uploads");
      must(!listed.some((f) => f.name === o.file), `${o.name}'s file is listed on ${s.name}`);
      return { detail: { names_refused: seen.length } };
    },
  },
  {
    id: "R5_anonymous_update_delete_rejected",
    rule: "Signed-out callers cannot update, delete or transition any record.",
    async run(s) {
      const anonId = (await s.conn.raw("POST", "/api/data/inbox", { headers: { "idempotency-key": `kk-${randomUUID()}` }, body: { data: inboxData(`anon ${run}`) } }));
      must(anonId.status >= 200 && anonId.status < 300, `anonymous create on inbox -> ${anonId.status} ${anonId.code} (Turnstile must be off on QA hosts)`);
      const inboxId = anonId.json.data.id;
      cleanup.push(() => s.admin.z.data.collection("inbox").delete(inboxId));
      for (const [coll, id] of [["inbox", inboxId], ["notes", s.note]]) {
        refusedHttp(await s.conn.raw("PATCH", `/api/data/${coll}/${id}`, { body: { patch: { body: "anon edit" } } }), `anonymous PATCH ${coll}`);
        refusedHttp(await s.conn.raw("DELETE", `/api/data/${coll}/${id}`), `anonymous DELETE ${coll}`);
      }
      if (v2) refusedHttp(await s.conn.raw("POST", `/api/data/inbox/${inboxId}/transition`, { body: { to: "done" } }), "anonymous transition");
      else rep.skip(`R5_anonymous_update_delete_rejected.${s.name}.transition`, "pending K3: v2 transitions");
      const still = await s.admin.z.data.collection("inbox").get(inboxId);
      must(still?.data?.body === `anon ${run}`, "the anonymous record changed");
      must((await s.user.z.data.collection("notes").get(s.note))?.id === s.note, "the note was deleted");
      return { detail: "PATCH/DELETE refused, records intact" };
    },
  },
  {
    id: "R6_second_signup_cannot_set_password",
    rule: "A second signup on an unconfirmed email cannot log in with the second password (before or after confirmation).",
    devSkip: "the dev server has no unconfirmed state (signup signs in at once)",
    async run(s) {
      const email = testEmail(s.conn, `kkc${s.name.toLowerCase()}${run}`);
      const p1 = newPassword(), p2 = newPassword();
      const mark = mailbox ? await mailbox.mark(email) : 0;
      const up = (pw) => s.conn.raw("POST", "/api/auth/signup", { body: { email, password: pw } });
      const login = (pw) => s.conn.raw("POST", "/api/auth/login", { body: { email, password: pw } });
      const r1 = await up(p1), r2 = await up(p2);
      must(r1.status === 200 && r2.status === 200, `signups -> ${r1.status}/${r2.status} ${r1.code ?? ""}${r2.code ?? ""}`);
      for (const [pw, tag] of [[p2, "second"], [p1, "first"]]) refusedHttp(await login(pw), `login with the ${tag} password before confirmation`, ["invalid_credentials"]);
      if (!mailbox || mailbox.kind === "manual" && !process.env.KK_CONFIRM_MANUALLY) {
        rep.skip(`R6_second_signup_cannot_set_password.${s.name}.after_confirmation`, "no mailbox: set POOLED_QA_MAILBOX=imap (or KK_CONFIRM_MANUALLY=1) to check after the inbox owner confirms");
        return { detail: "before confirmation only" };
      }
      const link = await mailbox.waitForLink({ to: email, host: new URL(s.conn.origin).hostname, after: mark });
      const z = client(s.conn);
      await completeLink(s.conn, z, link);
      cleanup.push(() => z.auth.deleteAccount().catch(() => {}));
      for (const [pw, tag] of [[p2, "second"], [p1, "first"]]) refusedHttp(await login(pw), `login with the ${tag} password after confirmation`, ["invalid_credentials"]);
      return { detail: "no known password before or after confirmation" };
    },
  },
  {
    id: "R7_signup_response_identical",
    rule: "Signup answers exactly the same for a new email and an existing (confirmed) one.",
    devSkip: "the dev server signs a new account in at once (documented dev-only difference)",
    async run(s) {
      const pw = newPassword();
      const fresh = testEmail(s.conn, `kkn${s.name.toLowerCase()}${run}`);
      const t0 = Date.now();
      const a = await s.conn.raw("POST", "/api/auth/signup", { body: { email: fresh, password: pw } });
      const t1 = Date.now();
      const b = await s.conn.raw("POST", "/api/auth/signup", { body: { email: s.user.email, password: pw } });
      const t2 = Date.now();
      const norm = (r) => JSON.stringify({ status: r.status, ct: r.headers.get?.("content-type") ?? null, body: strip(r.json) });
      must(norm(a) === norm(b), `new email -> ${norm(a)}; existing email -> ${norm(b)}`);
      must(a.status === 200, `signup -> ${a.status} ${a.code}`);
      const ms = [t1 - t0, t2 - t1];
      if (Math.abs(ms[0] - ms[1]) > 800) rep.warn(`R7_signup_response_identical.${s.name}.timing`, `new ${ms[0]} ms vs existing ${ms[1]} ms`);
      return { detail: { body: strip(a.json), ms } };
    },
  },
  {
    id: "R8_quota_applies",
    rule: "A per-site quota stops writes with quota_exceeded (429), and deleting frees the room again.",
    async run(s) {
      const ids = [];
      let hit = null;
      for (let i = 0; i < QUOTA_MAX_ATTEMPTS && !hit; i++) {
        const r = await s.conn.raw("POST", "/api/data/notes", { token: await s.user.z.auth.accessToken(), headers: { "idempotency-key": `kk-q-${randomUUID()}` }, body: { data: { title: `kk quota ${run} ${i}` } } });
        if (r.status >= 200 && r.status < 300) { ids.push(r.json.data.id); continue; }
        if (r.code === "rate_limited") { await new Promise((res) => setTimeout(res, 61000)); continue; }
        hit = r;
      }
      for (const id of ids) cleanup.push(() => s.user.z.data.collection("notes").delete(id));
      must(hit, `no refusal after ${ids.length} creates: the QA quota was not lowered (RUNBOOK.md, step "quota")`);
      if (dev && hit.status === 413 && hit.code === "quota_exceeded") devGap(`R8_quota_applies.${s.name}.status`, "dev server answers quota_exceeded with 413; the gateway and the contract use 429");
      else must(hit.status === 429 && hit.code === "quota_exceeded", `stopped by ${hit.status} ${hit.code}, expected 429 quota_exceeded`);
      must(ids.length > 0, "the first create was already refused: there is no headroom to prove the limit moved");
      await s.user.z.data.collection("notes").delete(ids.pop());
      const again = await s.conn.raw("POST", "/api/data/notes", { token: await s.user.z.auth.accessToken(), headers: { "idempotency-key": `kk-q-${randomUUID()}` }, body: { data: { title: `kk quota ${run} again` } } });
      must(again.status >= 200 && again.status < 300, `after a delete a create still fails: ${again.status} ${again.code} (usage not rolled back)`);
      const againId = again.json.data.id;
      cleanup.push(() => s.user.z.data.collection("notes").delete(againId));
      return { detail: { created_before_limit: ids.length + 1, refused: `${hit.status} ${hit.code}` } };
    },
  },
  {
    id: "R9_login_rate_limit",
    rule: "Repeated failed logins for one email are rate limited (429 rate_limited).",
    devSkip: "the dev server has no rate limits",
    async run(s) {
      const email = testEmail(s.conn, `kkl${s.name.toLowerCase()}${run}`);
      const codes = [];
      for (let i = 0; i < LOGIN_LIMIT + 5; i++) {
        const r = await s.conn.raw("POST", "/api/auth/login", { body: { email, password: `wrong-${i}-${run}` } });
        codes.push(r.code ?? String(r.status));
        if (r.status === 429) {
          must(r.code === "rate_limited", `429 with ${r.code}`);
          must(i >= 1, "the very first login was limited: the limit is not per email (or stale from a previous run)");
          return { detail: `limited after ${i} failures` };
        }
        must(r.code === "invalid_credentials", `attempt ${i + 1}: ${r.status} ${r.code}`);
      }
      throw new Fail(`no rate limit after ${codes.length} failed logins: ${codes.join(",")}`);
    },
  },
];

function strip(j) {
  if (!j || typeof j !== "object") return j;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "request_id") continue;
      o[k] = /token|session|password|secret|jwt/i.test(k) ? "<redacted>" : walk(x);
    }
    return o;
  };
  return walk(j);
}

const verdicts = [];
for (const t of TESTS) {
  for (const s of [S.A, S.B]) {
    const id = `${t.id}.${s.name}`;
    if (dev && t.devSkip) { rep.skip(id, `not modelled by the dev server: ${t.devSkip}`); continue; }
    await rep.step(id, () => t.run(s));
  }
}
for (const t of TESTS) {
  const steps = rep.steps.filter((x) => x.id.startsWith(`${t.id}.`));
  const fail = steps.filter((x) => x.status === "fail");
  const skip = steps.filter((x) => x.status === "skip");
  const enforced = fail.length === 0 && skip.length === 0 && steps.filter((x) => x.status === "pass").length === 2;
  verdicts.push({ id: t.id, rule: t.rule, verdict: dev ? (fail.length ? "FAILED in dry run" : enforced ? "passed in dry run (not a product verdict)" : "not judged (dry run)") : fail.length ? "NOT ENFORCED" : enforced ? "enforced" : "NOT PROVEN (skipped part)", ...(fail.length ? { failures: fail.map((x) => `${x.id}: ${x.detail}`) } : {}), ...(skip.length ? { skipped: skip.map((x) => `${x.id}: ${x.detail}`) } : {}) });
}
await finish();

async function finishCleanup() {
  let left = 0;
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { if (e?.code !== "not_found") left++; } }
  if (left) rep.warn("cleanup", `${left} item(s) left behind: see RUNBOOK.md Cleanup`);
  else rep.pass("cleanup", `${cleanup.length} item(s) removed`);
}

async function finish() {
  await finishCleanup();
  const allEnforced = verdicts.length === TESTS.length && verdicts.every((v) => v.verdict === "enforced");
  const anyFail = rep.steps.some((x) => x.status === "fail");
  const extra = { tests: verdicts, all_enforced: allEnforced, bar: "every access-rule test enforced on both QA sites" };
  mkdirSync(`${KIT}/results`, { recursive: true });
  const code = rep.finish(extra);
  const file = `${KIT}/results/rules-${dev ? "dev" : "real"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ ...extra, steps: rep.steps }, null, 2) + "\n");
  process.stderr.write(`wrote ${file}\n`);
  process.exit(dev ? (anyFail ? 1 : 0) : allEnforced && code === 0 ? 0 : 1);
}
