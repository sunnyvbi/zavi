
"use strict";

const STEP_TIMEOUT_MS = 15000;
const IDLE_TIMEOUT_MS = 5000;
const SMOKE_TOKEN = "{smoke}";
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const IGNORED_CONSOLE = /favicon\.ico/i;
const IGNORED_RESOURCE_HOST = /^(fonts\.googleapis\.com|fonts\.gstatic\.com)$/i;
const MAX_LIST_PROBES = 5;
const OWNER_CASCADE = "the owner could not sign in";

class GateError extends Error {}

class InfrastructureError extends Error {}
async function browserSetup(fn) {
  try { return await fn(); }
  catch (e) { throw new InfrastructureError(describe(e)); }
}

function describe(e) {
  if (e instanceof GateError) return e.message;
  const first = String((e && e.message) || e).split("\n")[0];
  return first.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]");
}

function tokensOf(value) {
  const out = [value];
  try {
    const u = new URL(value);
    for (const v of u.searchParams.values()) if (v.length >= 8) out.push(v);
    const frag = u.hash.replace(/^#/, "");
    if (frag.length >= 8) {
      out.push(frag);
      for (const v of new URLSearchParams(frag).values()) if (v.length >= 8) out.push(v);
    }
  } catch (e) {
  }
  return out;
}

function redact(text, secrets) {
  let out = String(text == null ? "" : text);
  const all = [];
  for (const s of secrets) if (s) all.push(...tokensOf(s));
  all.sort((a, b) => b.length - a.length);
  for (const s of all) if (s) out = out.split(s).join("[redacted]");
  return out.slice(0, 500);
}

async function visit(page, url) {
  const res = await page.goto(url, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
  const status = res ? res.status() : 0;
  if (status !== 200) throw new GateError("HTTP " + status + " for " + new URL(url).pathname);
}

async function settle(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: IDLE_TIMEOUT_MS });
  } catch (e) {
  }
}

const ORIGIN_OF = new WeakMap();

function responseFault(res, origin) {
  const u = new URL(res.url());
  if (!origin || u.origin !== origin) return null;
  return platformFault(res.status(), u.pathname, res.headers()["location"]);
}

function ignoredConsole(m) {
  const text = String(m.text());
  if (IGNORED_CONSOLE.test(text)) return true;
  if (!/^Failed to load resource\b/i.test(text)) return false;
  let at = "";
  try {
    at = String((typeof m.location === "function" && m.location() && m.location().url) || "");
  } catch (e) {
    at = "";
  }
  if (IGNORED_CONSOLE.test(at)) return true;
  const urls = [at].concat(text.match(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi) || []);
  return urls.some((u) => {
    try {
      return IGNORED_RESOURCE_HOST.test(new URL(u).hostname);
    } catch (e) {
      return false;
    }
  });
}

async function withPage(context, fn) {
  const page = await browserSetup(() => context.newPage());
  const errors = [];
  const faults = [];
  page.on("pageerror", (e) => errors.push("page error: " + ((e && e.message) || String(e))));
  page.on("console", (m) => {
    if (m.type() === "error" && !ignoredConsole(m)) errors.push("console error: " + m.text());
  });
  page.on("response", (res) => {
    try {
      const fault = responseFault(res, ORIGIN_OF.get(context));
      if (fault && faults.indexOf(fault) < 0) faults.push(fault);
    } catch (e) {
    }
  });
  try {
    return await fn(page, errors, faults);
  } catch (e) {
    if (!(e instanceof InfrastructureError) && faults.length) {
      throw new InfrastructureError(faults[0] + " (" + describe(e).split("\n")[0].replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").slice(0, 200) + ")");
    }
    if (!(e instanceof InfrastructureError) && !(e instanceof GateError) && NETWORK_ERROR.test(describe(e))) {
      throw new InfrastructureError("the preview could not be reached (" + describe(e).slice(0, 200) + ")");
    }
    throw e;
  } finally {
    await page.close();
  }
}

async function timed(name, secrets, fn, browser) {
  const started = Date.now();
  try {
    const skipped = await fn();
    if (skipped && typeof skipped === "object" && skipped.skip) {
      return { name, ok: true, skipped: true, reason: skipped.skip, ms: Date.now() - started };
    }
    return { name, ok: true, ms: Date.now() - started };
  } catch (e) {
    if (e instanceof InfrastructureError) throw e;
    if (browser && typeof browser.isConnected === "function" && !browser.isConnected()) {
      throw new InfrastructureError("the smoke browser disconnected");
    }
    return { name, ok: false, ms: Date.now() - started, reason: redact(describe(e), secrets) };
  }
}

const ERROR_TEXT_JOURNEY = "zavi:error-text";
const ERROR_TEXT = [
  /something went wrong/i,
  /failed to (load|fetch)/i,
  /error loading/i,
  /not configured yet/i,
  /can['\u2019]t be saved right now/i,
  /unexpected error/i,
  /\b(TypeError|ReferenceError|undefined is not)\b/,
  /we couldn['\u2019]t find that\. it may have been removed/i,
  /this site is full right now/i,
  /that['\u2019]s a lot of tries in a short time/i,
  /you seem to be offline/i,
  /this site is being built\. check back soon/i,
  /\blorem ipsum\b/i,
  /\bdolor sit amet\b/i,
];
const PLACEHOLDER_HEADING = /^welcome$/i;
const PLACEHOLDER_FOLLOW = /\b(being built|coming soon|check back soon)\b/i;
const ERROR_TEXT_MAX = 200;
const MAX_SHOTS = 3;
const SHOT_MAX_B64 = 400000;

function visibleText() {
  const fields = [];
  if (typeof document.querySelectorAll === "function") {
    for (const el of Array.from(document.querySelectorAll("input, textarea"))) fields.push(String(el.value || ""));
  }
  let title = "";
  if (typeof document.querySelector === "function") {
    const meta = document.querySelector('meta[property="og:title"]');
    title = meta ? String(meta.getAttribute("content") || "").trim() : "";
  }
  const marks = [];
  const blocks = [];
  if (typeof document.querySelectorAll === "function") {
    const marked = Array.from(document.querySelectorAll("[data-zavi-section]"));
    for (const el of marked) marks.push(String(el.getAttribute("data-zavi-section") || ""));
    const chrome = (el) => !!(el.closest && el.closest("header, nav, footer"));
    const shown = (el) => typeof el.checkVisibility !== "function" || el.checkVisibility();
    const leaves = (marked.length
      ? marked
      : Array.from(document.querySelectorAll("section")).filter((el) => !(el.querySelector && el.querySelector("section")))
    ).filter((el) => !chrome(el) && shown(el));
    for (const el of leaves.slice(0, 30)) {
      const t = String(el.innerText || "").replace(/\s+/g, " ").trim();
      const mark = el.getAttribute ? String(el.getAttribute("data-zavi-section") || "") : "";
      if (t) blocks.push(mark ? { len: t.length, head: t.slice(0, 160), mark: mark.slice(0, 40) } : { len: t.length, head: t.slice(0, 160) });
    }
  }
  return { text: document.body ? String(document.body.innerText || "") : "", fields, title, marks, blocks };
}

function findErrorText(path, text, fields) {
  const typed = new Set();
  for (const f of fields || []) for (const l of String(f || "").split("\n")) if (l.trim()) typed.add(l.trim());
  let prev = "";
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || typed.has(line)) continue;
    if (ERROR_TEXT.some((re) => re.test(line))) return line.length > ERROR_TEXT_MAX ? line.slice(0, ERROR_TEXT_MAX) + "..." : line;
    if (PLACEHOLDER_HEADING.test(prev) && PLACEHOLDER_FOLLOW.test(line)) return prev;
    prev = line;
  }
  return null;
}

async function readPage(page, path, seen) {
  if (!seen) return null;
  try {
    const v = await page.evaluate(visibleText);
    seen.push({ path, text: v.text, fields: v.fields, marks: v.marks || [], blocks: v.blocks || [] });
    return v;
  } catch (e) {
    return null;
  }
}

async function shoot(page, shots, label, path) {
  if (!shots || shots.length >= (shots.limit || MAX_SHOTS) || typeof page.screenshot !== "function") return;
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false, timeout: STEP_TIMEOUT_MS });
    const data = Buffer.from(buf).toString("base64");
    if (data && data.length <= SHOT_MAX_B64) shots.push({ label, path, data });
  } catch (e) {
    return;
  }
}

function errorTextJourney(seen) {
  for (const s of seen) {
    if (s.overlay) throw new GateError("the preview shows a build error on " + s.path);
    const hit = findErrorText(s.path, s.text, s.fields);
    if (hit) throw new GateError("visible error text on " + s.path + ": " + JSON.stringify(hit));
    if (s.problems && s.problems.length) throw new GateError(s.problems[0] + " on " + s.path);
  }
}

const SCAN_ROUTES_MAX = 10;
const SCAN_ROUTE = /^\/[A-Za-z0-9._~\-/]*$/;

function scanExtras() {
  const links = [];
  if (typeof document.querySelectorAll === "function") {
    for (const a of Array.from(document.querySelectorAll("a[href]"))) links.push(String(a.getAttribute("href") || ""));
  }
  const overlay = typeof document.querySelector === "function" && !!document.querySelector("vite-error-overlay");
  return { links, overlay };
}

function scanRoutes(routes, links, origin) {
  const out = routes.slice(0, SCAN_ROUTES_MAX);
  for (const href of links) {
    if (out.length >= SCAN_ROUTES_MAX) break;
    let u;
    try {
      u = new URL(href, origin + "/");
    } catch (e) {
      continue;
    }
    if (u.origin !== origin || !SCAN_ROUTE.test(u.pathname) || u.pathname.indexOf("/__") === 0) continue;
    if (out.indexOf(u.pathname) < 0) out.push(u.pathname);
  }
  return out;
}

function sameOriginFailure(m, origin) {
  if (m.type() !== "error" || ignoredConsole(m)) return null;
  if (!/^Failed to load resource\b/i.test(String(m.text()))) return null;
  let at = "";
  try {
    at = String((typeof m.location === "function" && m.location() && m.location().url) || "");
  } catch (e) {
    at = "";
  }
  try {
    const u = new URL(at);
    return u.origin === origin ? "a file failed to load (" + u.pathname + ")" : null;
  } catch (e) {
    return null;
  }
}

async function scanJourney(context, origin, routes, seen, shots, head, links) {
  await withPage(context, async (page) => {
    let problems = [];
    page.on("pageerror", (e) => problems.push("page error: " + String((e && e.message) || e).split("\n")[0].slice(0, 200)));
    page.on("console", (m) => {
      const failed = sameOriginFailure(m, origin);
      if (failed && problems.indexOf(failed) < 0) problems.push(failed);
    });
    let queue = routes.length ? routes.slice() : ["/"];
    for (let i = 0; i < queue.length; i++) {
      const r = queue[i];
      problems = [];
      try {
        await page.goto(origin + r, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
      } catch (e) {
        problems.push("the page did not load");
      }
      await settle(page);
      const read = await readPage(page, r, seen);
      let extras = { links: [], overlay: false };
      try {
        extras = await page.evaluate(scanExtras);
      } catch (e) {
        extras = { links: [], overlay: false };
      }
      const entry = seen[seen.length - 1];
      if (entry && entry.path === r) {
        entry.overlay = extras.overlay === true;
        entry.problems = problems.slice();
      } else {
        seen.push({ path: r, text: "", fields: [], overlay: extras.overlay === true, problems: problems.slice() });
      }
      if (r === "/" && head && read) head.og_title = read.title;
      if (i === 0 && links !== false) queue = scanRoutes(queue, extras.links || [], origin);
      if (shots && (r === "/" || !shots.some((x) => x.path !== "/"))) await shoot(page, shots, "desktop", r);
    }
  });
}

async function mobileHomeShot(browser, origin, shots) {
  const mobile = await browserSetup(() => browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true, serviceWorkers: "block" }));
  ORIGIN_OF.set(mobile, origin);
  try {
    await guardReadOnly(mobile, null, origin);
    await withPage(mobile, async (page, errors) => {
      await page.goto(origin + "/", { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
      await settle(page);
      const extras = await page.evaluate(scanExtras).catch(() => ({ overlay: false }));
      if (extras.overlay) throw new GateError("the preview shows a build error at phone width");
      const read = await page.evaluate(visibleText).catch(() => null);
      const hit = read ? findErrorText("/", read.text, read.fields) : null;
      if (hit) throw new GateError("visible error text at phone width: " + JSON.stringify(hit));
      if (errors.length) throw new GateError(errors[0] + " at phone width");
      await shoot(page, shots, "mobile", "/");
    });
  } finally {
    await mobile.close().catch(() => undefined);
  }
}

async function homeJourney(context, origin, seen, shots, head) {
  await withPage(context, async (page, errors) => {
    await visit(page, origin + "/");
    await settle(page);
    const read = await readPage(page, "/", seen);
    if (head && read) head.og_title = read.title;
    await shoot(page, shots, "desktop", "/");
    const text = await page.evaluate(() => (document.body ? document.body.innerText.trim().length : 0));
    if (!text) throw new GateError("the home page rendered no visible text");
    if (errors.length) throw new GateError(errors[0]);
  });
}

const bodyText = (page) => page.evaluate(() => (document.body ? document.body.innerText.trim() : ""));

async function routesJourney(context, origin, routes, tag, seen, shots) {
  await withPage(context, async (page) => {
    await page.goto(origin + "/__zavi-missing-" + tag, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
    await settle(page);
    const missing = await bodyText(page);
    for (const r of routes) {
      await visit(page, origin + r);
      if (r === "/") continue;
      await settle(page);
      await readPage(page, r, seen);
      if (shots && !shots.some((x) => x.path !== "/")) await shoot(page, shots, "desktop", r);
      if ((await bodyText(page)) === missing) throw new GateError(r + " renders the same page as a route that does not exist");
    }
  });
}

async function mobileJourney(browser, context, origin, routes, readOnly, shots) {
  const state = await browserSetup(() => context.storageState());
  const mobile = await browserSetup(() => browser.newContext({ storageState: state, viewport: MOBILE, isMobile: true, hasTouch: true, ...(readOnly ? { serviceWorkers: "block" } : {}) }));
  ORIGIN_OF.set(mobile, origin);
  try {
    if (readOnly) await guardReadOnly(mobile);
    await withPage(mobile, async (page) => {
      for (const r of routes) {
        await visit(page, origin + r);
        await settle(page);
        const scrolled = await page.evaluate(() => {
          const y = window.scrollY;
          window.scrollTo(100000, y);
          const x = window.scrollX;
          window.scrollTo(0, y);
          return x;
        });
        if (r === "/") await shoot(page, shots, "mobile", r);
        if (scrolled > 1) throw new GateError(r + " scrolls sideways by " + scrolled + "px at " + MOBILE.width + "px wide");
      }
    });
  } finally {
    await mobile.close();
  }
}

function imageStats(arg) {
  const imgs = Array.prototype.slice.call(document.images || []);
  const owned = arg.owned || [];
  const broken = [];
  const external = [];
  let loaded = 0;
  let ownedLoaded = 0;
  for (const img of imgs) {
    const src = String(img.currentSrc || img.getAttribute("src") || "");
    if (!src) continue;
    let u;
    try {
      u = new URL(src, arg.origin);
    } catch (e) {
      continue;
    }
    if (u.protocol === "data:" || u.protocol === "blob:") continue;
    if (u.origin !== arg.origin) {
      if (external.indexOf(u.host) < 0) external.push(u.host.slice(0, 80));
      continue;
    }
    if (img.complete && img.naturalWidth > 0) {
      loaded++;
      if (owned.indexOf(u.pathname) >= 0) ownedLoaded++;
    } else {
      broken.push(u.pathname.slice(0, 120));
    }
  }
  return { loaded: loaded, ownedLoaded: ownedLoaded, broken: broken, external: external };
}

const PLACEHOLDER_ICON_SEL = 'svg[class*="lucide-image"]';
const PLACEHOLDER_LABEL_SEL = "div, figure, span, p";
const IMAGE_ERROR_SEL = '[data-zavi-image="error"]';
function placeholderBoxes(arg) {
  const LABEL = /^(?:(?:hero |cover )?(?:image|photo|img)|(?:image |photo )?placeholder|placeholder (?:image|photo)|(?:your )?(?:image|photo) here|add (?:an? )?(?:image|photo))$/i;
  const NOT_A_FRAME = 'header, nav, a, button, [role="button"], [data-zavi-image="none"]';
  const MEDIA = "img, video, picture, canvas, iframe";
  const textOf = (el) => String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const big = (el) => {
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return !!r && r.width >= 120 && r.height >= 80;
  };
  const hasPicture = (el) => {
    if (el.querySelector && el.querySelector(MEDIA)) return true;
    const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    return !!cs && /url\(/i.test(String(cs.backgroundImage || ""));
  };
  const found = [];
  const seen = [];
  const add = (box, kind) => {
    if (seen.indexOf(box) >= 0) return;
    seen.push(box);
    found.push(kind);
  };
  for (const svg of Array.prototype.slice.call(document.querySelectorAll(arg.iconSel) || [])) {
    if (svg.closest && svg.closest(NOT_A_FRAME)) continue;
    let box = svg.parentElement;
    for (let i = 0; box && i < 4 && !big(box); i++) box = box.parentElement;
    if (!box || !big(box) || hasPicture(box)) continue;
    const t = textOf(box);
    if (t && !LABEL.test(t)) continue;
    add(box, "icon");
  }
  for (const el of Array.prototype.slice.call(document.querySelectorAll(arg.labelSel) || [])) {
    const kids = Array.prototype.slice.call(el.children || []);
    if (kids.some((k) => String(k.tagName || "").toLowerCase() !== "svg")) continue;
    const t = textOf(el);
    if (!t || !LABEL.test(t) || !big(el) || hasPicture(el)) continue;
    if (el.closest && el.closest(NOT_A_FRAME)) continue;
    add(el, "label");
  }
  const failed = Array.prototype.slice.call(document.querySelectorAll(arg.errorSel) || []).length;
  return { count: found.length, kinds: found.slice(0, 5), failed: failed };
}

async function scrollThrough(page) {
  await page.evaluate(async () => {
    const w = window;
    const root = document.documentElement;
    const step = Math.max(200, Math.floor((w.innerHeight || 800) * 0.8));
    const height = () => (root ? root.scrollHeight || 0 : 0);
    for (let y = 0; y < height() && y < 40000; y += step) {
      w.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    w.scrollTo(0, 0);
  });
}

async function imagesJourney(context, origin, images) {
  await withPage(context, async (page) => {
    await visit(page, origin + "/");
    await settle(page);
    await scrollThrough(page);
    await settle(page);
    try {
      await page.waitForFunction(
        () => Array.prototype.every.call(document.images || [], (img) => img.complete || !(img.currentSrc || img.getAttribute("src"))),
        null,
        { timeout: STEP_TIMEOUT_MS },
      );
    } catch (e) {
    }
    const owned = Array.isArray(images.owned) ? images.owned.filter((p) => typeof p === "string") : [];
    const stats = await page.evaluate(imageStats, { origin: origin, owned: owned });
    if (stats.external.length) {
      throw new GateError(
        "the home page shows images hotlinked from " + stats.external.slice(0, 3).join(", ") +
          ": a site's images must be files in its own public/ folder (generated with add_site_images, or the founder's own photos), never a link to another site." +
          askFor("replace the linked images with the site's own photos"),
      );
    }
    if (stats.broken.length) {
      const one = stats.broken[0];
      throw new GateError(
        "the home page has " + stats.broken.length + " broken image(s), e.g. " + one + ": every <img> must point at a file in public/ that exists (or be removed)." + askFor("fix the broken images"),
      );
    }
    const empty = await page.evaluate(placeholderBoxes, { iconSel: PLACEHOLDER_ICON_SEL, labelSel: PLACEHOLDER_LABEL_SEL, errorSel: IMAGE_ERROR_SEL });
    if (empty && empty.failed > 0) {
      throw new GateError(
        "the home page has " + empty.failed + " image(s) that did not load (shown as a panel by SiteImage): every image must point at a file in public/ that exists (or be removed)." + askFor("fix the broken images"),
      );
    }
    if (empty && empty.count > 0) {
      throw new GateError(
        "the home page shows " + empty.count + " empty image placeholder box(es) (" + empty.kinds.join(", ") + "): a box with an image icon or an \"image\" label where a photo should be." +
          " Do not call add_site_images again for them: use the no-image layout (with the starter's sections, leave `image` out; by hand, remove the box or make it a brand-colour panel with no icon or label)." +
          askFor("remove the empty image placeholders"),
      );
    }
    if (images.require_loaded === true && (owned.length ? stats.ownedLoaded : stats.loaded) === 0) {
      throw new GateError(
        "the home page shows no photo, but the site has generated photos in public/images/ (see public/images/zavi-images.json): put the hero photo on the home page with its src, srcset, width, height and alt." + askFor("show the site's photos on the home page"),
      );
    }
  });
}

function brandHead() {
  const content = (sel) => {
    const el = document.querySelector(sel);
    return el ? String(el.getAttribute("content") || "").trim() : "";
  };
  const icon = document.querySelector('link[rel~="icon"]');
  return {
    icon: icon ? String(icon.href || "") : "",
    ogTitle: content('meta[property="og:title"]'),
    ogDescription: content('meta[property="og:description"]'),
    text: document.body ? document.body.innerText.trim() : "",
  };
}

const ROUTER_DEFAULT_ERROR = /Unexpected Application Error|Hey developer/i;
const askFor = (what) => " Ask in the chat to " + what + ", then publish again.";

async function brandJourney(context, origin, tag) {
  await withPage(context, async (page) => {
    await visit(page, origin + "/");
    await settle(page);
    const head = await page.evaluate(brandHead);
    if (!head.icon) throw new GateError("the site has no tab icon (favicon)." + askFor("add a favicon"));
    if (!head.ogTitle) {
      throw new GateError("a shared link to the site would show no title (og:title is missing)." + askFor("add link preview tags"));
    }
    if (!head.ogDescription) {
      throw new GateError("a shared link to the site would show no description (og:description is missing)." + askFor("add link preview tags"));
    }
    const icon = new URL(head.icon, origin);
    if (icon.protocol !== "data:") {
      let loaded = 0;
      try {
        loaded = (await context.request.get(icon.toString(), { timeout: STEP_TIMEOUT_MS })).status();
      } catch (e) {
        loaded = 0;
      }
      if (loaded !== 200) {
        const why = loaded ? " (HTTP " + loaded + ")" : "";
        throw new GateError("the site's tab icon (favicon) " + icon.pathname + " does not load" + why + "." + askFor("fix the favicon"));
      }
    }
    const notFound = askFor("add a page-not-found page");
    let status = 0;
    try {
      const res = await page.goto(origin + "/__zavi-missing-" + tag, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
      status = res ? res.status() : 0;
    } catch (e) {
      status = 0;
    }
    if (status !== 404 && status !== 200) {
      const got = status ? "answers HTTP " + status : "does not load";
      throw new GateError("a wrong address on the site " + got + " instead of showing a page-not-found page." + notFound);
    }
    await settle(page);
    const text = await bodyText(page);
    if (!text || (status === 404 && /^not found$/i.test(text))) {
      throw new GateError('a wrong address on the site shows a blank or bare "Not Found" page.' + notFound);
    }
    if (ROUTER_DEFAULT_ERROR.test(text)) {
      throw new GateError("a wrong address on the site shows an error screen instead of a page-not-found page." + notFound);
    }
    if (text === head.text) {
      throw new GateError("a wrong address on the site shows the home page instead of a page-not-found page." + notFound);
    }
  });
}

function platform5xx(status, what) {
  if (status >= 500) throw new InfrastructureError(what + " answered HTTP " + status + " (a platform failure)");
}

async function deniedRead(context, origin, collection, tag) {
  const res = await context.request.get(origin + "/api/data/" + collection + "?limit=100", {
    headers: { accept: "application/json" },
    timeout: STEP_TIMEOUT_MS,
  });
  const status = res.status();
  platform5xx(status, "reading " + collection + " signed out");
  if (status === 401 || status === 403) return;
  if (status !== 200) throw new GateError("reading " + collection + " signed out answered HTTP " + status + ", not a refusal");
  const body = await res.text();
  if (body.indexOf(tag) !== -1) throw new GateError("a signed-out visitor could read this run's " + collection + " record");
}

async function runSteps(context, page, origin, journey, tag) {
  const fill = (v) => v.split(SMOKE_TOKEN).join(tag);
  for (const step of journey.steps || []) {
    if ("visit" in step) await visit(page, origin + step.visit);
    else if ("fill" in step) await page.fill(step.fill, fill(step.value), { timeout: STEP_TIMEOUT_MS });
    else if ("click" in step) await page.click(step.click, { timeout: STEP_TIMEOUT_MS });
    else if ("expect" in step) await page.waitForSelector(step.expect, { state: "visible", timeout: STEP_TIMEOUT_MS });
    else if ("expectText" in step) {
      const want = fill(step.expectText);
      try {
        await page.waitForFunction((t) => !!document.body && document.body.innerText.includes(t), want, { timeout: STEP_TIMEOUT_MS });
      } catch (e) {
        throw new GateError("text " + JSON.stringify(step.expectText) + " never appeared");
      }
    } else if ("expectNoText" in step) {
      await settle(page);
      const found = await page.evaluate((t) => !!document.body && document.body.innerText.includes(t), fill(step.expectNoText));
      if (found) throw new GateError("text " + JSON.stringify(step.expectNoText) + " is visible but must not be");
    } else if ("deniedRead" in step) await deniedRead(context, origin, step.deniedRead, tag);
    else throw new GateError("unknown step " + JSON.stringify(step));
  }
}

const WITHHELD = "the page threw an error while the owner was signed in (text withheld)";

function carriesTag(method, url, body, tag) {
  if (readOnlyAllows(method)) return false;
  return String(body || "").indexOf(tag) !== -1 || String(url || "").indexOf(tag) !== -1;
}

async function manifestJourney(context, origin, journey, tag) {
  await withPage(context, async (page, errors) => {
    const writes = [];
    if (journey.booking) {
      page.on("response", (res) => {
        try {
          const req = res.request();
          let body = "";
          try {
            body = String(req.postData() || "");
          } catch (e) {
            body = "";
          }
          if (carriesTag(req.method(), req.url(), body, tag)) writes.push({ status: res.status(), path: new URL(req.url()).pathname });
        } catch (e) {
        }
      });
    }
    await visit(page, origin + journey.path);
    if (journey.expect) await page.waitForSelector(journey.expect, { state: "visible", timeout: STEP_TIMEOUT_MS });
    await runSteps(context, page, origin, journey, tag);
    const pageErrors = errors.filter((e) => e.indexOf("page error:") === 0);
    if (pageErrors.length) {
      throw new GateError(journey.as === "owner" ? WITHHELD : journey.as === "customer" ? WITHHELD_CUSTOMER : pageErrors[0]);
    }
    if (journey.booking) {
      await settle(page);
      if (!writes.length) throw new GateError("the booking form never sent the test booking to the server");
      if (!writes.some((w) => w.status >= 200 && w.status < 300)) {
        const w = writes[writes.length - 1];
        const why = w.status === 403 && journey.as === "customer"
          ? " (a signed-up customer was refused: the booking must not set a field only admins may write, such as its status; let the collection's states set it)"
          : "";
        throw new GateError("the server refused the test booking: " + w.path + " answered HTTP " + w.status + why);
      }
    }
  });
}

function withTag(record, tag) {
  const out = {};
  for (const k of Object.keys(record)) {
    const v = record[k];
    out[k] = typeof v === "string" ? v.split(SMOKE_TOKEN).join(tag) : v;
  }
  return out;
}

async function writeCreate(context, origin, write, tag) {
  const res = await context.request.post(origin + "/api/data/" + write.collection, {
    data: { data: withTag(write.record, tag) },
    headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": tag + "-create" },
    timeout: STEP_TIMEOUT_MS,
  });
  const status = res.status();
  platform5xx(status, "creating a " + write.collection + " record as a visitor");
  if (status !== 200 && status !== 201) {
    throw new GateError("creating a " + write.collection + " record as a visitor answered HTTP " + status);
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new GateError("creating a " + write.collection + " record returned no JSON");
  }
  const id = body && body.data && body.data.id;
  if (typeof id !== "string" || !id) throw new GateError("creating a " + write.collection + " record returned no id");
  return id;
}

async function writeDenied(context, origin, write, id, tag) {
  if (!write.protected_get && !write.protected_list) return { skip: "the collection's rules let anyone read it" };
  const base = origin + "/api/data/" + write.collection;
  if (write.protected_get) {
    const r = await context.request.get(base + "/" + id, { headers: { accept: "application/json" }, timeout: STEP_TIMEOUT_MS });
    const s = r.status();
    platform5xx(s, "a signed-out read of the new " + write.collection + " record");
    if (s === 200) throw new GateError("a signed-out visitor could read the new " + write.collection + " record");
    if (s !== 401 && s !== 403 && s !== 404) throw new GateError("a signed-out read answered HTTP " + s + ", not a refusal");
  }
  if (write.protected_list) await deniedRead(context, origin, write.collection, tag);
  return undefined;
}

async function readDenied(context, origin, collections) {
  for (const c of collections.slice(0, MAX_LIST_PROBES)) {
    const res = await context.request.get(origin + "/api/data/" + c + "?limit=1", {
      headers: { accept: "application/json" },
      timeout: STEP_TIMEOUT_MS,
    });
    const status = res.status();
    platform5xx(status, "listing " + c + " signed out");
    if (status === 401 || status === 403) continue;
    if (status !== 200) throw new GateError("listing " + c + " signed out answered HTTP " + status + ", not a refusal");
    let items;
    try {
      const body = await res.json();
      items = body && body.data && body.data.items;
    } catch (e) {
      items = undefined;
    }
    if (!Array.isArray(items)) throw new GateError("listing " + c + " signed out answered 200 without a list");
    if (items.length > 0) throw new GateError("a signed-out visitor can list " + c + " records");
  }
}

async function writeReadback(context, origin, write, id, tag, accessToken) {
  const headers = { accept: "application/json" };
  if (accessToken) headers.authorization = "Bearer " + accessToken;
  else if (write.protected_get) return { skip: "no owner session to read the record back" };
  const r = await context.request.get(origin + "/api/data/" + write.collection + "/" + id, { headers, timeout: STEP_TIMEOUT_MS });
  platform5xx(r.status(), "reading the new " + write.collection + " record back");
  if (r.status() !== 200) throw new GateError("reading the new " + write.collection + " record back answered HTTP " + r.status());
  const body = await r.text();
  if (body.indexOf(id) === -1) throw new GateError("the record read back is not the one created");
  if (write.tag_field && body.indexOf(tag) === -1) throw new GateError("the record read back lost its " + write.tag_field);
  return undefined;
}

const SITE_API = /^\/api\/fn(\/|$)/;
const NETWORK_ERROR = /net::ERR_(?:CONNECTION_(?:RESET|REFUSED|CLOSED|TIMED_OUT|FAILED)|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|TIMED_OUT|EMPTY_RESPONSE|ADDRESS_UNREACHABLE|SSL_PROTOCOL_ERROR|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED)\b/;
const CALLBACK_CODE = /^[a-z_]{1,40}$/;

function platformFault(status, pathname, location) {
  if (!pathname.startsWith("/api/")) return status >= 500 ? "the site host answered " + status + " on " + pathname : null;
  if (SITE_API.test(pathname)) return null;
  if (status >= 500) return "the platform answered " + status + " on " + pathname;
  if (pathname === "/api/auth/callback") {
    if (status < 300 || status >= 400 || !location) return "the sign-in service answered " + status + " to the owner link";
    let code = null;
    try {
      code = new URLSearchParams(new URL(location, "https://x.invalid").hash.replace(/^#/, "")).get("error");
    } catch (e) {
      return "the sign-in service redirected the owner link somewhere unreadable";
    }
    if (code !== null) return "the sign-in service refused the owner link (" + (CALLBACK_CODE.test(code) ? code : "unknown") + ")";
  }
  return null;
}

const OWNER_SIGNIN_TIMEOUT_MS = 2 * STEP_TIMEOUT_MS;

async function ownerLanding(page, linkOrigin) {
  try {
    return await page.evaluate((origin) => {
      const l = window.location;
      const has = (s) => !!document.querySelector(s);
      return {
        path: l && l.origin === origin ? String(l.pathname) : null,
        error: has("[data-zavi=auth-error]"),
        done: has("[data-zavi=auth-done]"),
      };
    }, linkOrigin);
  } catch (e) {
    return null;
  }
}

function landingNote(at) {
  if (!at) return "";
  if (at.path === null) return " (it left the site)";
  if (at.path === "/auth/confirm") {
    if (at.error) return " (the sign-in page showed an error)";
    if (at.done) return " (the sign-in page finished without signing the owner in)";
    return "";
  }
  const p = /^\/[A-Za-z0-9/_.-]{0,60}$/.test(at.path) ? at.path : "another page";
  return " (it landed on " + p + ")";
}

async function ownerJourney(context, ownerLink, pooled, secrets) {
  const linkOrigin = new URL(ownerLink).origin;
  return withPage(context, async (page, errors, faults) => {
    let token = null;
    let sessionHop = false;
    page.on("response", (res) => {
      try {
        const u = new URL(res.url());
        const loc = res.headers()["location"];
        if (u.origin !== linkOrigin) return;
        if (!pooled || u.pathname !== "/api/auth/callback" || u.searchParams.get("confirm") !== "1" || !loc) return;
        sessionHop = true;
        const frag = new URLSearchParams(new URL(loc, u.origin).hash.replace(/^#/, ""));
        if (frag.get("access_token")) token = frag.get("access_token");
        for (const [k, v] of frag.entries()) if (k !== "error" && k !== "type" && v.length >= 8) secrets.push(v);
      } catch (e) {
      }
    });
    const apiPending = new Set();
    const settled = (req) => apiPending.delete(req);
    page.on("request", (req) => {
      try {
        const u = new URL(req.url());
        if (u.origin === linkOrigin && u.pathname.startsWith("/api/") && !SITE_API.test(u.pathname)) apiPending.add(req);
      } catch (e) {
      }
    });
    page.on("requestfinished", settled);
    page.on("requestfailed", settled);
    const fail = (reason) => {
      if (faults.length) return new InfrastructureError("owner sign-in: " + faults[0] + " (" + reason + ")");
      if (pooled && sessionHop && !token) return new InfrastructureError("owner sign-in: the sign-in service issued no session (" + reason + ")");
      return new GateError(reason);
    };
    try {
      await page.goto(ownerLink, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
    } catch (e) {
      throw new InfrastructureError("owner sign-in: the owner sign-in link did not load" + (faults.length ? " (" + faults[0] + ")" : ""));
    }
    try {
      await page.waitForURL((u) => {
        const x = new URL(String(u));
        return x.origin === linkOrigin && x.pathname === "/admin";
      }, { timeout: OWNER_SIGNIN_TIMEOUT_MS });
    } catch (e) {
      const at = await ownerLanding(page, linkOrigin);
      if (
        !faults.length &&
        apiPending.size > 0 &&
        at &&
        at.path === "/auth/confirm" &&
        !at.error &&
        !at.done &&
        !errors.some((x) => x.indexOf("page error:") === 0)
      ) {
        throw new InfrastructureError("owner sign-in: the sign-in service did not answer in time (still signing in on /auth/confirm)");
      }
      throw fail("the owner sign-in did not reach /admin" + landingNote(at));
    }
    try {
      await page.waitForSelector("[data-zavi=admin-shell]", { state: "visible", timeout: STEP_TIMEOUT_MS });
    } catch (e) {
      throw fail("/admin did not show [data-zavi=admin-shell] to the signed-in owner");
    }
    if (errors.some((e) => e.indexOf("page error:") === 0)) throw fail(WITHHELD);
    if (pooled && sessionHop && !token) throw new InfrastructureError("owner sign-in: the sign-in service issued no session");
    return token;
  });
}

const CUSTOMER_CASCADE = "the customer could not sign in";
const CUSTOMER_JOURNEY = "zavi:customer";

async function customerJourney(context, customerLink, pooled, secrets) {
  const linkOrigin = new URL(customerLink).origin;
  return withPage(context, async (page, errors, faults) => {
    let token = null;
    let sessionHop = false;
    page.on("response", (res) => {
      try {
        const u = new URL(res.url());
        const loc = res.headers()["location"];
        if (u.origin !== linkOrigin) return;
        if (!pooled || u.pathname !== "/api/auth/callback" || u.searchParams.get("confirm") !== "1" || !loc) return;
        sessionHop = true;
        const frag = new URLSearchParams(new URL(loc, u.origin).hash.replace(/^#/, ""));
        if (frag.get("access_token")) token = frag.get("access_token");
        for (const [k, v] of frag.entries()) if (k !== "error" && k !== "type" && v.length >= 8) secrets.push(v);
      } catch (e) {
      }
    });
    const fail = (reason) => {
      if (faults.length) return new InfrastructureError("customer sign-in: " + faults[0] + " (" + reason + ")");
      if (pooled && sessionHop && !token) return new InfrastructureError("customer sign-in: the sign-in service issued no session (" + reason + ")");
      return new GateError(reason);
    };
    try {
      await page.goto(customerLink, { waitUntil: "load", timeout: STEP_TIMEOUT_MS });
    } catch (e) {
      throw new InfrastructureError("customer sign-in: the customer sign-in link did not load" + (faults.length ? " (" + faults[0] + ")" : ""));
    }
    try {
      await page.waitForURL((u) => {
        const x = new URL(String(u));
        return x.origin === linkOrigin && x.pathname !== "/auth/confirm" && x.pathname !== "/api/auth/callback";
      }, { timeout: STEP_TIMEOUT_MS });
    } catch (e) {
      throw fail("the customer sign-in link never left /auth/confirm");
    }
    let signedIn = null;
    try {
      signedIn = await page.evaluate(async () => {
        const z = window.__zavi;
        if (!z) return "the page has no window.__zavi (keep src/zavi/index.ts)";
        await z.auth.ready();
        return z.auth.session() ? "yes" : "no session after the sign-in link";
      });
    } catch (e) {
      throw fail("the customer's page could not be read after the sign-in link");
    }
    if (signedIn !== "yes") throw fail(signedIn || "no session after the sign-in link");
    if (pooled && sessionHop && !token) throw new InfrastructureError("customer sign-in: the sign-in service issued no session");
    if (errors.some((e) => e.indexOf("page error:") === 0)) throw fail(WITHHELD_CUSTOMER);
    return token;
  });
}

const WITHHELD_CUSTOMER = "the page threw an error while the customer was signed in (text withheld)";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function readOnlyAllows(method) {
  return SAFE_METHODS.has(String(method).toUpperCase());
}

async function guardReadOnly(context, blocked, wsOrigin) {
  try {
    await context.route(
      () => true,
      (route) => {
        const req = route.request();
        if (readOnlyAllows(req.method())) return route.continue();
        if (blocked) {
          let body = "";
          try {
            body = String(req.postData() || "");
          } catch (e) {
            body = "";
          }
          let headers = {};
          try {
            const h = typeof req.headers === "function" ? req.headers() : null;
            if (h && typeof h === "object") headers = h;
          } catch (e) {
            headers = {};
          }
          blocked.push({ method: String(req.method()).toUpperCase(), url: String(req.url()), body: body, headers: headers });
        }
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "read_only_gate" }) });
      },
    );
    if (typeof context.routeWebSocket !== "function") throw new Error("no routeWebSocket");
    await context.routeWebSocket(/.*/, (ws) => {
      if (wsOrigin && sameWsOrigin(ws, wsOrigin)) return ws.connectToServer();
      return ws.close({ code: 1008, reason: "read_only_gate" });
    });
  } catch (e) {
    throw new GateError("the read-only guard could not be installed");
  }
}

function sameWsOrigin(ws, origin) {
  try {
    const u = new URL(String(ws.url()));
    const o = new URL(origin);
    return u.host === o.host && (u.protocol === "wss:" || u.protocol === "ws:");
  } catch (e) {
    return false;
  }
}

const SIMPLE_TYPE = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\b/i;
const SIMPLE_METHODS = new Set(["GET", "HEAD", "POST"]);
const SAFELISTED_HEADERS = new Set(["accept", "accept-language", "content-language", "content-type", "range"]);
const BROWSER_HEADER = /^(sec-|proxy-)|^(user-agent|referer|origin|host|cookie|connection|content-length|accept-encoding|dnt|priority|upgrade-insecure-requests)$/i;

function isSimpleRequest(sent) {
  if (!SIMPLE_METHODS.has(String(sent.method || "").toUpperCase())) return false;
  const headers = sent.headers || {};
  for (const name of Object.keys(headers)) {
    const n = name.toLowerCase();
    if (BROWSER_HEADER.test(n)) continue;
    if (!SAFELISTED_HEADERS.has(n)) return false;
    if (n === "content-type" && !SIMPLE_TYPE.test(String(headers[name] || ""))) return false;
  }
  return true;
}

async function preflightEndpoint(context, origin, sent) {
  let status = 0;
  try {
    const res = await context.request.fetch(sent.url, {
      method: "OPTIONS",
      headers: { origin: origin, "access-control-request-method": sent.method },
      timeout: STEP_TIMEOUT_MS,
    });
    status = res.status();
  } catch (e) {
    status = 0;
  }
  const target = new URL(sent.url);
  const where = target.pathname;
  if (target.origin === origin) {
    if (!status) throw new InfrastructureError("the site host did not answer the booking preflight on " + where);
    const fault = platformFault(status, where, null);
    if (fault) throw new InfrastructureError(fault + " (booking preflight)");
  }
  if (!status) throw new GateError("the booking form submits to " + where + ", which does not answer");
  if (status === 404 || status >= 500) {
    throw new GateError("the booking form submits to " + where + ", which answers HTTP " + status);
  }
  const crossOrigin = target.origin !== origin;
  if (crossOrigin && !isSimpleRequest(sent) && (status < 200 || status >= 300)) {
    throw new GateError("the booking form submits to " + where + ", which refuses the browser's preflight (HTTP " + status + ")");
  }
}

const SUBMIT_WAIT_MS = 3000;
const SUBMIT_POLL_MS = 250;

async function dryRunJourney(context, origin, journey, tag, blocked) {
  await withPage(context, async (page, errors) => {
    await visit(page, origin + journey.path);
    if (journey.expect) await page.waitForSelector(journey.expect, { state: "visible", timeout: STEP_TIMEOUT_MS });
    const from = blocked.length;
    let sent = null;
    let errorsAtSend = 0;
    let clicked = false;
    for (const step of journey.steps || []) {
      const before = blocked.length;
      try {
        await runSteps(context, page, origin, { steps: [step] }, tag);
      } catch (e) {
        if (!clicked) throw e;
        break;
      }
      if (!("click" in step)) continue;
      clicked = true;
      await settle(page);
      const pick = () => blocked.slice(before).find((r) => carriesTag(r.method, r.url, r.body, tag)) || null;
      sent = pick();
      for (let waited = 0; !sent && blocked.length === before && waited < SUBMIT_WAIT_MS; waited += SUBMIT_POLL_MS) {
        await new Promise((r) => setTimeout(r, SUBMIT_POLL_MS));
        sent = pick();
      }
      if (sent) {
        errorsAtSend = errors.length;
        break;
      }
    }
    if (!sent) {
      throw new GateError(
        blocked.length > from
          ? "the booking form sent a request, but not the test booking it was filled with"
          : "the booking form never sent the booking when submitted",
      );
    }
    const pageErrors = errors.slice(0, errorsAtSend).filter((e) => e.indexOf("page error:") === 0);
    if (pageErrors.length) throw new GateError(pageErrors[0]);
    await preflightEndpoint(context, origin, sent);
  });
}

async function runGate(opts) {
  const baseUrl = String(opts.baseUrl || "").trim();
  if (!baseUrl) return { ok: false, journeys: [], owner: null, error: "no preview URL" };
  const config = opts.config;
  const ownerLink = opts.ownerLink || null;
  const customerLink = opts.customerLink || null;
  const origin = new URL(baseUrl).origin;
  const secrets = [ownerLink, customerLink, baseUrl];
  const tag = config.tag;
  const pooled = config.starter === "pooled";
  const results = [];
  const created = [];
  const byName = new Map();
  let owner = null;
  const seen = [];
  const snapshot = config.preview_snapshot === true;
  const shots = config.screenshots === true || config.thumbnail === true || snapshot ? [] : null;
  if (shots && config.screenshots !== true) shots.limit = snapshot ? 2 : 1;
  const head = shots ? { og_title: "" } : null;
  const push = (r) => {
    results.push(r);
    byName.set(r.name, r);
    return r;
  };

  const browser = await opts.launch();
  const time = (name, secrets, fn) => timed(name, secrets, fn, browser);
  try {
    const contextOptions = { ...(config.read_only ? { serviceWorkers: "block" } : {}), ...(snapshot ? { viewport: DESKTOP } : {}) };
    const context = await browserSetup(() => browser.newContext(Object.keys(contextOptions).length ? contextOptions : undefined));
    ORIGIN_OF.set(context, origin);
    const blocked = [];
    if (config.read_only) await guardReadOnly(context, blocked, config.scan_only === true ? origin : null);
    const entry = await time("zavi:entry", secrets, () => withPage(context, (page) => visit(page, baseUrl)));
    if (!entry.ok) return { ok: false, journeys: [entry], owner: null };

    if (config.scan_only === true) {
      push(await time("zavi:scan", secrets, () => scanJourney(context, origin, config.routes || ["/"], seen, shots, head, config.scan_links !== false)));
      push(await time(ERROR_TEXT_JOURNEY, secrets, async () => errorTextJourney(seen)));
      if (snapshot && results.every((r) => r.ok)) push(await time("zavi:mobile_snapshot", secrets, () => mobileHomeShot(browser, origin, shots)));
      const scanned = shots ? { screenshots: shots, og_title: head.og_title } : {};
      return { ok: results.every((r) => r.ok), journeys: results, owner: null, created, scanned_routes: seen.map((s) => s.path), ...scanned };
    }

    push(await time("zavi:home", secrets, () => homeJourney(context, origin, seen, shots, head)));
    push(await time("zavi:routes", secrets, () => routesJourney(context, origin, config.routes, tag, seen, shots)));
    push(await time("zavi:mobile", secrets, () => mobileJourney(browser, context, origin, config.routes, config.read_only === true, shots)));
    push(await time(ERROR_TEXT_JOURNEY, secrets, async () => errorTextJourney(seen)));
    if (config.brand) push(await time("zavi:brand", secrets, () => brandJourney(context, origin, tag)));
    if (config.images) push(await time("zavi:images", secrets, () => imagesJourney(context, origin, config.images)));

    let customerContext = null;
    const skipReason = (j) => {
      if (j.writes && !config.allow_writes && !(j.dry_run && config.read_only)) return "writes not allowed";
      if (j.as === "owner" && !ownerLink) return "no owner link";
      if (j.as === "customer" && !customerLink) return "no customer link";
      const dep = j.needs ? byName.get(j.needs) : null;
      if (dep && dep.skipped) return "needs " + j.needs + ", which was skipped";
      return null;
    };
    const runManifest = async (j) => {
      const why = skipReason(j);
      if (why) return push({ name: j.name, ok: true, skipped: true, reason: why });
      const dep = j.needs ? byName.get(j.needs) : null;
      if (dep && !dep.ok) return push({ name: j.name, ok: false, ms: 0, reason: "needs " + j.needs + ", which failed" });
      if (j.dry_run && config.read_only) {
        return push(await time(j.name, secrets, () => dryRunJourney(context, origin, j, tag, blocked)));
      }
      const ctx = j.as === "customer" ? customerContext : context;
      return push(await time(j.name, secrets, () => manifestJourney(ctx, origin, j, tag)));
    };

    for (const j of config.journeys) if (j.as !== "owner" && j.as !== "customer") await runManifest(j);

    if (pooled && (config.protected_lists || []).length) {
      push(await time("zavi:read-denied", secrets, () => readDenied(context, origin, config.protected_lists)));
    }

    const write = pooled && config.allow_writes ? config.write : null;
    let recordId = null;
    if (write) {
      const made = push(
        await time("zavi:write-create", secrets, async () => {
          recordId = await writeCreate(context, origin, write, tag);
          created.push({ collection: write.collection, id: recordId });
        }),
      );
      if (made.ok) push(await time("zavi:write-denied", secrets, () => writeDenied(context, origin, write, recordId, tag)));
    }

    let accessToken = null;
    if (ownerLink) {
      owner = await time("owner-admin", secrets, async () => {
        accessToken = await ownerJourney(context, ownerLink, pooled, secrets);
      });
      if (accessToken) secrets.push(accessToken);
      if (owner.ok && pooled && !accessToken) {
        owner = { name: "owner-admin", ok: false, ms: owner.ms, reason: "the owner reached /admin without finishing the sign-in link at /auth/confirm (no session)" };
      }
    }
    if (write && recordId) {
      push(
        await time("zavi:write-readback", secrets, () => writeReadback(context, origin, write, recordId, tag, accessToken)),
      );
    }

    let customer = null;
    const wantsCustomer = config.journeys.some((j) => j.as === "customer");
    if (wantsCustomer && customerLink) {
      customerContext = await browserSetup(() => browser.newContext());
      ORIGIN_OF.set(customerContext, origin);
      customer = push(
        await time(CUSTOMER_JOURNEY, secrets, async () => {
          await withPage(customerContext, (page) => visit(page, baseUrl));
          const customerToken = await customerJourney(customerContext, customerLink, pooled, secrets);
          if (customerToken) secrets.push(customerToken);
        }),
      );
    }

    for (const j of config.journeys) {
      if (j.as === "owner") {
        if (owner && !owner.ok) push({ name: j.name, ok: false, ms: 0, reason: OWNER_CASCADE });
        else await runManifest(j);
      } else if (j.as === "customer") {
        if (customer && !customer.ok) push({ name: j.name, ok: false, ms: 0, reason: CUSTOMER_CASCADE });
        else await runManifest(j);
      }
    }
  } catch (e) {
    return { ok: false, journeys: results, owner, created, infrastructure_error: true, error: redact(describe(e), secrets) };
  } finally {
    await browser.close();
  }
  const ok = results.every((r) => r.ok) && (owner === null || owner.ok);
  const review = shots ? { screenshots: shots, og_title: head.og_title } : {};
  const text = config.page_text === true ? { page_text: pageTexts(seen) } : {};
  return { ok, journeys: results, owner, created, ...review, ...text };
}

const PAGE_TEXT_MAX = 6000;
const PAGE_TEXT_PAGES = 6;

function pageTexts(seen) {
  const out = [];
  const paths = new Set();
  for (const s of seen) {
    if (!s || paths.has(s.path) || out.length >= PAGE_TEXT_PAGES) continue;
    paths.add(s.path);
    const marks = (s.marks || []).map((m) => String(m).slice(0, 40)).filter(Boolean).slice(0, 40);
    const blocks = (s.blocks || [])
      .filter((b) => b && typeof b.head === "string" && typeof b.len === "number")
      .slice(0, 30)
      .map((b) => (typeof b.mark === "string" && b.mark ? { len: b.len, head: b.head.slice(0, 160), mark: b.mark.slice(0, 40) } : { len: b.len, head: b.head.slice(0, 160) }));
    out.push({ path: s.path, text: String(s.text || "").slice(0, PAGE_TEXT_MAX), sections: marks, blocks });
  }
  return out.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : 0));
}

async function main() {
  const baseUrl = process.env.GATE_BASE_URL || "";
  const ownerLink = process.env.GATE_OWNER_LINK || null;
  const customerLink = process.env.GATE_CUSTOMER_LINK || null;
  delete process.env.GATE_OWNER_LINK;
  delete process.env.GATE_CUSTOMER_LINK;
  delete process.env.GATE_BASE_URL;
  let result;
  try {
    const config = JSON.parse(require("fs").readFileSync(process.argv[2], "utf-8"));
    const { chromium } = require("playwright");
    result = await runGate({ baseUrl, ownerLink, customerLink, config, launch: () => chromium.launch({ headless: true }) });
  } catch (e) {
    result = { ok: false, journeys: [], owner: null, infrastructure_error: true, error: redact((e && e.message) || e, [ownerLink, customerLink, baseUrl]) };
  }
  emitResult(result);
}

const EMIT_FLUSH_MS = 30000;
function emitResult(result, flushMs = EMIT_FLUSH_MS) {
  const timer = setTimeout(() => process.exit(2), flushMs);
  process.stdout.write(JSON.stringify(result) + "\n", (error) => {
    clearTimeout(timer);
    process.exit(error ? 2 : result.ok ? 0 : 1);
  });
}

if (require.main === module) main();

module.exports = { emitResult, readOnlyAllows, runGate, redact, platformFault, findErrorText, OWNER_CASCADE, CUSTOMER_CASCADE, CUSTOMER_JOURNEY, ERROR_TEXT_JOURNEY };
