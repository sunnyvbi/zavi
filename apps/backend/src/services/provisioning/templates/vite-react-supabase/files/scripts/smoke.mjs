
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const STEP_TIMEOUT_MS = 15_000;
const SELECTOR = /^\[data-zavi(?:-[a-z0-9-]+)?=("?)[A-Za-z0-9_-]+\1\]$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SMOKE_TOKEN = "{smoke}";
export const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;

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

function checkStep(where, step) {
  if (!step || typeof step !== "object") fail(`${where}: step must be an object`);
  const keys = Object.keys(step);
  if ("visit" in step && keys.length === 1) return checkPath(where, step.visit);
  if ("click" in step && keys.length === 1) return checkSelector(where, step.click);
  if ("expect" in step && keys.length === 1) return checkSelector(where, step.expect);
  if ("fill" in step && keys.length === 2 && typeof step.value === "string") return checkSelector(where, step.fill);
  fail(`${where}: unknown step ${JSON.stringify(step)} (use visit, fill+value, click or expect)`);
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
  const seen = new Set();
  for (const j of journeys) {
    if (!j || typeof j.name !== "string" || !NAME.test(j.name)) fail(`journey name ${JSON.stringify(j?.name)} must be lowercase-kebab`);
    if (seen.has(j.name)) fail(`duplicate journey name "${j.name}"`);
    seen.add(j.name);
    checkPath(j.name, j.path);
    if (j.expect !== undefined) checkSelector(j.name, j.expect);
    if (j.steps !== undefined && !Array.isArray(j.steps)) fail(`${j.name}: steps must be an array`);
    (j.steps ?? []).forEach((s, i) => checkStep(`${j.name} step ${i + 1}`, s));
    if (j.writes !== undefined && typeof j.writes !== "boolean") fail(`${j.name}: writes must be true or false`);
    if (j.writes && !(j.steps ?? []).some((s) => "fill" in s && s.value.includes(SMOKE_TOKEN))) {
      fail(`${j.name}: a writes journey must put ${SMOKE_TOKEN} in at least one filled value`);
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
    checkOverflow: env.SMOKE_CHECK_OVERFLOW === "1",
    ownerLink: env.SMOKE_OWNER_LINK ? env.SMOKE_OWNER_LINK : undefined,
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

async function runJourney(context, baseUrl, journey, tag) {
  await withPage(context, async (page, pageErrors) => {
    await visit(page, baseUrl + journey.path);
    for (const step of journey.steps ?? []) {
      if ("visit" in step) await visit(page, baseUrl + step.visit);
      else if ("fill" in step) await page.fill(step.fill, step.value.split(SMOKE_TOKEN).join(tag), { timeout: STEP_TIMEOUT_MS });
      else if ("click" in step) await page.click(step.click, { timeout: STEP_TIMEOUT_MS });
      else if ("expect" in step) await page.waitForSelector(step.expect, { state: "visible", timeout: STEP_TIMEOUT_MS });
    }
    if (journey.expect) await page.waitForSelector(journey.expect, { state: "visible", timeout: STEP_TIMEOUT_MS });
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

export function mobileWidthPaths(journeys) {
  return [...new Set(["/", ...journeys.map((j) => j.path)])];
}

async function checkMobileWidth(context, origin, paths) {
  await withPage(context, async (page) => {
    await page.setViewportSize({ width: MOBILE_WIDTH, height: MOBILE_HEIGHT });
    for (const path of paths) {
      await visit(page, origin + path);
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        return { scrollWidth: el.scrollWidth, innerWidth: window.innerWidth };
      });
      if (m.scrollWidth > m.innerWidth + 1) {
        throw new Error(`${path} scrolls sideways on a ${MOBILE_WIDTH}px-wide phone: the page is ${m.scrollWidth}px wide`);
      }
    }
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

export async function runSmoke({ baseUrl, manifest, launch, ownerLink, allowWrites = false, checkOverflow = false }) {
  const entry = String(baseUrl).trim();
  const origin = new URL(entry).origin;
  const secrets = [ownerLink, entry !== origin && entry !== origin + "/" ? entry : ""].filter(Boolean);
  const tag = `zavi-smoke-${Date.now()}`;
  const results = [];
  let owner = null;
  const toRun = manifest.journeys.filter((j) => !j.writes || allowWrites);
  const needsBrowser = toRun.length > 0 || Boolean(ownerLink) || checkOverflow;
  const browser = needsBrowser ? await launch() : null;
  try {
    const context = browser ? await browser.newContext() : null;
    if (context) {
      const entryResult = await timed("entry", secrets, () => withPage(context, (page) => visit(page, entry)));
      if (!entryResult.ok) return { ok: false, journeys: [entryResult], owner: null };
    }
    for (const j of manifest.journeys) {
      if (j.writes && !allowWrites) {
        results.push({ name: j.name, ok: true, skipped: true, reason: "writes not allowed" });
        continue;
      }
      results.push(await timed(j.name, secrets, () => runJourney(context, origin, j, tag)));
    }
    if (checkOverflow) {
      results.push(await timed("mobile-width", secrets, () => checkMobileWidth(context, origin, mobileWidthPaths(manifest.journeys))));
    }
    if (ownerLink) owner = await timed("owner-admin", secrets, () => runOwner(context, ownerLink));
  } finally {
    if (browser) await browser.close();
  }
  const ok = results.every((r) => r.ok) && (owner === null || owner.ok);
  return { ok, journeys: results, owner };
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
    const secrets = process.env.SMOKE_OWNER_LINK ? [process.env.SMOKE_OWNER_LINK] : [];
    result = { ok: false, journeys: [], owner: null, error: redact(e?.message ?? e, secrets) };
  }
  process.stdout.write(formatResult(result) + "\n");
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
