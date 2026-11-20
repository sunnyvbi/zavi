
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const STEP_TIMEOUT_MS = 15_000;
const SELECTOR = /^\[data-zavi(?:-[a-z0-9-]+)?=("?)[A-Za-z0-9_-]+\1\]$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const COLLECTION = /^[a-z][a-z0-9_]{0,62}$/;
const SMOKE_TOKEN = "{smoke}";

function fail(msg) {
  throw new Error(`zavi-site.json: ${msg}`);
}

function checkPath(where, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    fail(`${where}: path must be a same-site path starting with "/" (got ${JSON.stringify(path)})`);
  }
}

function checkSelector(where, sel) {
  if (typeof sel !== "string" || !SELECTOR.test(sel)) {
    fail(`${where}: selector must be a data-zavi hook like [data-zavi=name] (got ${JSON.stringify(sel)})`);
  }
}

function checkText(where, text) {
  if (typeof text !== "string" || text.length < 1 || text.length > 200) fail(`${where}: text must be 1-200 characters`);
}

function checkStep(where, step, as) {
  if (!step || typeof step !== "object") fail(`${where}: step must be an object`);
  const keys = Object.keys(step);
  if ("visit" in step && keys.length === 1) return checkPath(where, step.visit);
  if ("click" in step && keys.length === 1) return checkSelector(where, step.click);
  if ("expect" in step && keys.length === 1) return checkSelector(where, step.expect);
  if ("expectText" in step && keys.length === 1) return checkText(where, step.expectText);
  if ("expectNoText" in step && keys.length === 1) return checkText(where, step.expectNoText);
  if ("deniedRead" in step && keys.length === 1) {
    if (as !== "visitor") fail(`${where}: deniedRead runs signed out, so it belongs in a visitor journey`);
    if (typeof step.deniedRead !== "string" || !COLLECTION.test(step.deniedRead)) fail(`${where}: deniedRead takes a collection name`);
    return;
  }
  if ("fill" in step && keys.length === 2 && typeof step.value === "string") return checkSelector(where, step.fill);
  fail(`${where}: unknown step ${JSON.stringify(step)} (use visit, fill+value, click, expect, expectText, expectNoText or deniedRead)`);
}

export function parseManifest(json) {
  let doc;
  try {
    doc = JSON.parse(json);
  } catch (e) {
    fail(`not valid JSON (${e.message})`);
  }
  const journeys = doc?.smoke?.journeys;
  if (!Array.isArray(journeys) || journeys.length === 0) fail("smoke.journeys must be a non-empty array");
  const seen = new Map();
  for (const j of journeys) {
    if (!j || typeof j.name !== "string" || !NAME.test(j.name)) fail(`journey name ${JSON.stringify(j?.name)} must be lowercase-kebab`);
    if (seen.has(j.name)) fail(`duplicate journey name "${j.name}"`);
    checkPath(j.name, j.path);
    if (j.as !== undefined && j.as !== "visitor" && j.as !== "customer" && j.as !== "owner") {
      fail(`${j.name}: as must be "visitor", "customer" or "owner"`);
    }
    if (j.needs !== undefined && (typeof j.needs !== "string" || !seen.has(j.needs))) fail(`${j.name}: needs must name an earlier journey`);
    if (j.needs !== undefined && (j.as ?? "visitor") === "visitor" && seen.get(j.needs) !== "visitor") {
      fail(`${j.name}: a visitor journey cannot need ${seen.get(j.needs) === "owner" ? "an owner" : "a customer"} journey (signed-in journeys run after visitors)`);
    }
    seen.set(j.name, j.as ?? "visitor");
    if (j.expect !== undefined) checkSelector(j.name, j.expect);
    if (j.steps !== undefined && !Array.isArray(j.steps)) fail(`${j.name}: steps must be an array`);
    (j.steps ?? []).forEach((s, i) => checkStep(`${j.name} step ${i + 1}`, s, j.as ?? "visitor"));
    if (j.writes !== undefined && typeof j.writes !== "boolean") fail(`${j.name}: writes must be true or false`);
    if (j.writes && !(j.steps ?? []).some((s) => "fill" in s && s.value.includes(SMOKE_TOKEN))) {
      fail(`${j.name}: a writes journey must put ${SMOKE_TOKEN} in at least one filled value`);
    }
    if ((j.steps ?? []).some((s) => "deniedRead" in s)) {
      const dep = journeys.find((x) => x.name === j.needs);
      if (!dep || dep.writes !== true) fail(`${j.name}: a deniedRead journey must "needs" the writes journey that creates the record`);
    }
  }
  return { journeys };
}

export function readEnv(env) {
  const base = (env.SMOKE_BASE_URL ?? "").trim();
  if (!base) throw new Error("SMOKE_BASE_URL is required");
  return {
    baseUrl: base,
    allowWrites: env.SMOKE_ALLOW_WRITES === "1",
    ownerLink: env.SMOKE_OWNER_LINK ? env.SMOKE_OWNER_LINK : undefined,
    customerLink: env.SMOKE_CUSTOMER_LINK ? env.SMOKE_CUSTOMER_LINK : undefined,
  };
}

function redact(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("[redacted]");
    try {
      const u = new URL(s);
      for (const v of u.searchParams.values()) if (v.length >= 8) out = out.split(v).join("[redacted]");
      if (u.hash.length > 8) out = out.split(u.hash.slice(1)).join("[redacted]");
    } catch {
    }
  }
  return out.slice(0, 500);
}

async function withPage(context, fn) {
  const page = await context.newPage();
  try {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e?.message ?? String(e)));
    await fn(page, pageErrors);
  } finally {
    await page.close();
  }
}

async function visit(page, url) {
  const res = await page.goto(url, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
  const status = res ? res.status() : 0;
  if (status >= 400) throw new Error(`HTTP ${status} for ${new URL(url).pathname}`);
}

async function deniedRead(page, collection) {
  const r = await page.evaluate(async (c) => {
    const z = window.__zavi;
    if (!z) return { error: "the page has no window.__zavi (keep src/zavi/index.ts)" };
    await z.auth.ready();
    if (z.auth.session()) return { error: "the visitor journey is signed in" };
    try {
      const page = await z.data.collection(c).list({ limit: 100 });
      return { items: page.items.length };
    } catch (e) {
      return { denied: String(e && e.code) };
    }
  }, collection);
  if (r.error) throw new Error(r.error);
  if (r.denied !== undefined) {
    if (r.denied === "not_allowed") return;
    throw new Error(`reading ${collection} signed out failed with ${r.denied}, not a refusal`);
  }
  if (r.items !== 0) throw new Error(`a signed-out visitor could read ${r.items} ${collection} record(s)`);
}

async function runSteps(page, baseUrl, journey, tag) {
  const fillTag = (v) => v.split(SMOKE_TOKEN).join(tag);
  for (const step of journey.steps ?? []) {
    if ("visit" in step) await visit(page, baseUrl + step.visit);
    else if ("fill" in step) await page.fill(step.fill, fillTag(step.value), { timeout: STEP_TIMEOUT_MS });
    else if ("click" in step) await page.click(step.click, { timeout: STEP_TIMEOUT_MS });
    else if ("expect" in step) await page.waitForSelector(step.expect, { state: "visible", timeout: STEP_TIMEOUT_MS });
    else if ("expectText" in step) {
      const want = fillTag(step.expectText);
      await page
        .waitForFunction((t) => !!document.body && document.body.innerText.includes(t), want, { timeout: STEP_TIMEOUT_MS })
        .catch(() => { throw new Error(`text ${JSON.stringify(step.expectText)} never appeared`); });
    } else if ("expectNoText" in step) {
      const banned = fillTag(step.expectNoText);
      await page.waitForLoadState("networkidle", { timeout: STEP_TIMEOUT_MS }).catch(() => {});
      const found = await page.evaluate((t) => !!document.body && document.body.innerText.includes(t), banned);
      if (found) throw new Error(`text ${JSON.stringify(step.expectNoText)} is visible but must not be`);
    } else if ("deniedRead" in step) await deniedRead(page, step.deniedRead);
  }
}

async function runJourney(context, baseUrl, journey, tag) {
  await withPage(context, async (page, pageErrors) => {
    await visit(page, baseUrl + journey.path);
    if (journey.expect) await page.waitForSelector(journey.expect, { state: "visible", timeout: STEP_TIMEOUT_MS });
    await runSteps(page, baseUrl, journey, tag);
    if (pageErrors.length) throw new Error(`page error: ${pageErrors[0]}`);
  });
}

async function runOwner(context, ownerLink) {
  await withPage(context, async (page, pageErrors) => {
    await page.goto(ownerLink, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
    await page.waitForURL((u) => new URL(String(u)).pathname === "/admin", { timeout: STEP_TIMEOUT_MS });
    await page.waitForSelector("[data-zavi=admin-shell]", { state: "visible", timeout: STEP_TIMEOUT_MS });
    if (pageErrors.length) throw new Error(`page error: ${pageErrors[0]}`);
  });
}

async function runCustomer(context, customerLink) {
  await withPage(context, async (page, pageErrors) => {
    await page.goto(customerLink, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
    await page.waitForURL((u) => {
      const p = new URL(String(u)).pathname;
      return p !== "/auth/confirm" && p !== "/api/auth/callback";
    }, { timeout: STEP_TIMEOUT_MS });
    const signedIn = await page.evaluate(async () => {
      const z = window.__zavi;
      if (!z) return false;
      await z.auth.ready();
      return !!z.auth.session();
    });
    if (!signedIn) throw new Error("the customer sign-in link did not sign in");
    if (pageErrors.length) throw new Error(`page error: ${pageErrors[0]}`);
  });
}

async function timed(name, secrets, fn) {
  const started = Date.now();
  try {
    await fn();
    return { name, ok: true, ms: Date.now() - started };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - started, reason: redact(e?.message ?? e, secrets) };
  }
}

export async function runSmoke({ baseUrl, manifest, launch, ownerLink, customerLink, allowWrites = false }) {
  const entry = String(baseUrl).trim();
  const origin = new URL(entry).origin;
  const secrets = [ownerLink, customerLink, entry !== origin && entry !== origin + "/" ? entry : ""].filter(Boolean);
  const tag = `zavi-smoke-${Date.now()}`;
  const byName = new Map();
  let owner = null;

  const skip = (j) => {
    if (j.writes && !allowWrites) return "writes not allowed";
    if ((j.as ?? "visitor") === "owner" && !ownerLink) return "no owner link";
    if (j.as === "customer" && !customerLink) return "no customer link";
    const dep = j.needs ? byName.get(j.needs) : null;
    if (dep?.skipped) return `needs ${j.needs}, which was skipped`;
    return null;
  };
  const visitors = manifest.journeys.filter((j) => (j.as ?? "visitor") === "visitor");
  const signedIn = manifest.journeys.filter((j) => j.as === "owner" || j.as === "customer");
  const willRun = manifest.journeys.some((j) => !skip(j)) || Boolean(ownerLink);
  const browser = willRun ? await launch() : null;

  let customer = null;
  let customerContext = null;
  const run = async (context, j) => {
    const why = skip(j);
    if (why) return { name: j.name, ok: true, skipped: true, reason: why };
    const dep = j.needs ? byName.get(j.needs) : null;
    if (dep && !dep.ok) return { name: j.name, ok: false, ms: 0, reason: `needs ${j.needs}, which failed` };
    return timed(j.name, secrets, () => runJourney(context, origin, j, tag));
  };

  try {
    const context = browser ? await browser.newContext() : null;
    if (context) {
      const entryResult = await timed("entry", secrets, () => withPage(context, (page) => visit(page, entry)));
      if (!entryResult.ok) return { ok: false, journeys: [entryResult], owner: null };
    }
    for (const j of visitors) byName.set(j.name, await run(context, j));
    if (ownerLink) owner = await timed("owner-admin", secrets, () => runOwner(context, ownerLink));
    if (customerLink && signedIn.some((j) => j.as === "customer")) {
      customerContext = await browser.newContext();
      customer = await timed("customer", secrets, async () => {
        await withPage(customerContext, (page) => visit(page, entry));
        await runCustomer(customerContext, customerLink);
      });
    }
    for (const j of signedIn) {
      if (j.as === "owner" && owner && !owner.ok) byName.set(j.name, { name: j.name, ok: false, ms: 0, reason: "the owner could not sign in" });
      else if (j.as === "customer" && customer && !customer.ok) byName.set(j.name, { name: j.name, ok: false, ms: 0, reason: "the customer could not sign in" });
      else byName.set(j.name, await run(j.as === "customer" ? customerContext : context, j));
    }
  } finally {
    if (browser) await browser.close();
  }
  const results = manifest.journeys.map((j) => byName.get(j.name));
  const ok = results.every((r) => r.ok) && (owner === null || owner.ok) && (customer === null || customer.ok);
  return { ok, journeys: results, owner, customer };
}

export function formatResult(result) {
  return JSON.stringify(result);
}

async function main() {
  let result;
  try {
    const cfg = readEnv(process.env);
    const manifest = parseManifest(readFileSync(new URL("../zavi-site.json", import.meta.url), "utf-8"));
    const { chromium } = await import("playwright");
    result = await runSmoke({ ...cfg, manifest, launch: () => chromium.launch({ headless: true }) });
  } catch (e) {
    const secrets = [process.env.SMOKE_OWNER_LINK, process.env.SMOKE_CUSTOMER_LINK].filter(Boolean);
    result = { ok: false, journeys: [], owner: null, error: redact(e?.message ?? e, secrets) };
  }
  process.stdout.write(formatResult(result) + "\n");
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
