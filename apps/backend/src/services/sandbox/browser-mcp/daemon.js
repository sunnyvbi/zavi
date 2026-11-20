#!/usr/bin/env node

const http = require("http");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const PORT = 9223;
const HOST = "127.0.0.1";

let browser = null;
let page = null;
let bootInFlight = null;

let consoleErrors = [];
const MAX_CONSOLE_ERRORS = 50;
function recordConsoleError(msg) {
  if (consoleErrors.length >= MAX_CONSOLE_ERRORS) return;
  consoleErrors.push(String(msg).slice(0, 500));
}

async function ensureBrowser() {
  if (browser && page) return;
  if (bootInFlight) return bootInFlight;
  bootInFlight = (async () => {
    try {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      page = await ctx.newPage();
      page.setDefaultTimeout(10000);
      page.on("console", (m) => {
        try {
          if (m.type() === "error") recordConsoleError(m.text());
        } catch (_) {
        }
      });
      page.on("pageerror", (err) => {
        recordConsoleError(err && err.message ? err.message : String(err));
      });
    } catch (e) {
      try { if (browser) await browser.close(); } catch (_) {  }
      browser = null;
      page = null;
      throw e;
    }
  })();
  try {
    await bootInFlight;
  } finally {
    bootInFlight = null;
  }
}

async function reactSafeFill(selector, value) {
  const handle = await page.waitForSelector(selector, { state: "visible", timeout: 5000 });
  await handle.evaluate(
    (el, val) => {
      const tag = el.tagName;
      const proto =
        tag === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value,
  );
}

async function runOp(op) {
  switch (op.op) {
    case "nav": {
      if (!op.url || typeof op.url !== "string") throw new Error("nav: url missing");
      consoleErrors = [];
      await page.goto(op.url, { waitUntil: "domcontentloaded" });
      return { ok: true };
    }
    case "click": {
      await page.click(op.selector, { timeout: 5000 });
      return { ok: true };
    }
    case "fill": {
      await reactSafeFill(op.selector, op.value);
      return { ok: true };
    }
    case "text": {
      const text = await page.locator(op.selector).first().innerText({ timeout: 5000 });
      return { ok: true, result: text };
    }
    case "assert_text": {
      const text = await page.locator(op.selector).first().innerText({ timeout: 5000 });
      if (!text.includes(op.expected)) {
        return {
          ok: false,
          error_code: "assert_text_miss",
          error_message: `expected substring "${op.expected}" not in "${text.slice(0, 200)}"`,
        };
      }
      return { ok: true };
    }
    case "assert_url": {
      const url = page.url();
      const looksRegex =
        op.expected.startsWith("^") ||
        op.expected.endsWith("$") ||
        op.expected.includes("\\");
      let match = false;
      if (looksRegex) {
        try {
          match = new RegExp(op.expected).test(url);
        } catch (e) {
          return {
            ok: false,
            error_code: "assert_url_bad_regex",
            error_message: `expected pattern looked regex-y but failed to compile: ${
              e && e.message ? e.message : String(e)
            }`,
          };
        }
      } else {
        match = url.includes(op.expected);
      }
      if (!match) {
        return {
          ok: false,
          error_code: "assert_url_miss",
          error_message: `expected ${op.expected} did not match ${url}`,
        };
      }
      return { ok: true };
    }
    case "screenshot": {
      const outPath = op.path || `/home/user/qa-shots/auto/${Date.now()}.png`;
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const buf = await page.screenshot({ path: outPath, fullPage: true });
      const result = { path: outPath };
      if (buf && buf.byteLength <= 3000000) {
        result.image_base64 = buf.toString("base64");
        result.image_mime = "image/png";
      }
      return { ok: true, result };
    }
    case "wait_for": {
      await page.waitForSelector(op.selector, { timeout: op.timeout_ms || 5000 });
      return { ok: true };
    }
    case "dom_snapshot": {
      const html = await page.content();
      return { ok: true, result: { html: String(html).slice(0, 500_000) } };
    }
    case "console_errors": {
      return { ok: true, result: { errors: consoleErrors.slice() } };
    }
    case "current_url": {
      return { ok: true, result: { url: page.url() } };
    }
    default:
      return { ok: false, error_code: "unknown_op", error_message: `op=${op.op}` };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, browser_ready: !!page }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/op") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const op = JSON.parse(body);
      await ensureBrowser();
      const result = await runOp(op);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error_code: "daemon_exception",
          error_message: String(e && e.message ? e.message : e),
        }),
      );
    }
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`browser-daemon ready on ${HOST}:${PORT}\n`);
});

process.on("SIGTERM", async () => {
  try {
    if (browser) await browser.close();
  } catch (_) {
  }
  process.exit(0);
});
