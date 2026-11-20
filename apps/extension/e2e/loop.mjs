
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEADED = process.env.E2E_HEADED === "1";
const LONG_POLL_MS = 4000;
const LEASE_MS = 15_000;
const SESSION_LIVE_MS = 30_000;

const USER_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = Math.floor(Date.now() / 1000) + 24 * 3600;
const ACCESS_TOKEN = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: USER_ID, exp: EXP, role: "authenticated", email: "loop@e2e.test" })}.sig`;
const STORED_SESSION = JSON.stringify({
  access_token: ACCESS_TOKEN,
  refresh_token: "e2e-refresh",
  token_type: "bearer",
  expires_in: 24 * 3600,
  expires_at: EXP,
  user: {
    id: USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: "loop@e2e.test",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  },
});

function createMock() {
  const calls = [];
  const sessions = new Map();
  const ops = new Map();
  const queues = new Map();
  const waiters = new Map();
  let forceResult404 = 0;
  const unexpected = [];

  const live = (id) => {
    const s = sessions.get(id);
    return !!s && !s.ended && Date.now() - s.lastSeen < SESSION_LIVE_MS;
  };
  const wake = (session) => {
    for (const w of waiters.get(session) ?? []) w();
  };
  const queueOf = (session) => {
    if (!queues.has(session)) queues.set(session, []);
    return queues.get(session);
  };

  function claim(session) {
    const q = queueOf(session);
    while (q.length) {
      const item = q.shift();
      if (item.raw) return item.raw;
      const r = ops.get(item.id);
      if (!r || r.status !== "queued") continue;
      r.status = "delivered";
      r.execution_token = randomUUID();
      r.lease_until = Date.now() + LEASE_MS;
      r.deliveries++;
      return {
        id: r.id,
        run_id: r.run_id,
        seq: r.seq,
        tab_id: r.tab_id,
        op: r.op,
        is_write: r.is_write,
        execution_token: r.execution_token,
        lease_until: new Date(r.lease_until).toISOString(),
      };
    }
    return null;
  }

  const notFound = (rsp) =>
    rsp.writeHead(404, { "content-type": "application/json" }).end(
      JSON.stringify({ error: { code: "not_found", message: "Not found." } }),
    );

  const server = createServer((req, rsp) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const rec = { t: Date.now(), method: req.method, path, query: url.search, body, status: 0 };
      calls.push(rec);
      const send = (status, json) => {
        rec.status = status;
        if (status === 204) return rsp.writeHead(204).end();
        if (status === 404 && json === undefined) return notFound(rsp);
        rsp.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json ?? {}));
      };
      if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        return send(401, { error: { code: "unauthorized", message: "Sign in." } });
      }
      let m;
      if (req.method === "GET" && path === "/api/extension/consent") {
        return send(200, {
          consent: { granted: true, version: "1", granted_at: new Date().toISOString(), revoked_at: null, current_version: "1" },
          consent_required: false,
        });
      }
      if (req.method === "POST" && path === "/api/extension/sessions") {
        if (!body || !Number.isInteger(body.tab_id) || body.tab_id < 0) {
          return send(400, { error: { code: "invalid_request", message: "tab_id is required." } });
        }
        const id = randomUUID();
        sessions.set(id, { tab_id: body.tab_id, ended: false, lastSeen: Date.now() });
        rec.extra = { session_id: id };
        return send(201, { session_id: id });
      }
      if ((m = /^\/api\/extension\/sessions\/([^/]+)\/heartbeat$/.exec(path)) && req.method === "POST") {
        const id = decodeURIComponent(m[1]);
        if (!live(id)) return send(404);
        sessions.get(id).lastSeen = Date.now();
        return send(204);
      }
      if ((m = /^\/api\/extension\/sessions\/([^/]+)$/.exec(path)) && req.method === "DELETE") {
        const id = decodeURIComponent(m[1]);
        if (!live(id)) return send(404);
        sessions.get(id).ended = true;
        for (const r of ops.values()) if (r.session === id && r.status === "queued") r.status = "expired";
        wake(id);
        return send(204);
      }
      if (req.method === "GET" && path === "/api/extension/ops/next") {
        const session = url.searchParams.get("session") ?? "";
        rec.extra = { session };
        const deadline = Date.now() + LONG_POLL_MS;
        let closed = false;
        rsp.on("close", () => {
          if (!rsp.writableEnded) closed = true;
        });
        for (;;) {
          if (closed) {
            rec.status = -1;
            return;
          }
          if (!live(session)) return send(404);
          sessions.get(session).lastSeen = Date.now();
          const op = claim(session);
          if (op) {
            rec.extra.op = op;
            return send(200, { op });
          }
          if (Date.now() >= deadline) return send(204);
          await new Promise((r) => {
            const set = waiters.get(session) ?? new Set();
            waiters.set(session, set);
            const done = () => {
              set.delete(done);
              clearTimeout(timer);
              r();
            };
            const timer = setTimeout(done, 200);
            set.add(done);
          });
        }
      }
      if ((m = /^\/api\/extension\/ops\/([^/]+)\/result$/.exec(path)) && req.method === "POST") {
        const id = decodeURIComponent(m[1]);
        const okBody =
          body &&
          typeof body.session_id === "string" &&
          typeof body.run_id === "string" &&
          typeof body.execution_token === "string" &&
          (body.status === "done" || body.status === "failed");
        if (!okBody) return send(400, { error: { code: "invalid_request", message: "Invalid result." } });
        if (forceResult404 > 0) {
          forceResult404--;
          rec.extra = { forced404: true };
          return send(404);
        }
        const r = ops.get(id);
        const match =
          r &&
          r.session === body.session_id &&
          r.run_id === body.run_id &&
          r.execution_token === body.execution_token &&
          r.status === "delivered" &&
          r.lease_until > Date.now() &&
          live(body.session_id);
        if (!match) return send(404);
        r.status = body.status;
        r.result = body.result ?? null;
        return send(204);
      }
      unexpected.push(`${req.method} ${path}`);
      return send(404);
    });
  });

  let seq = 0;
  const api = {
    server,
    calls,
    sessions,
    ops,
    unexpected,
    enqueue(session, op, { tab_id, is_write = op.op !== "ax_snapshot" } = {}) {
      const id = randomUUID();
      ops.set(id, {
        id,
        session,
        run_id: RUN_ID,
        seq: ++seq,
        tab_id: tab_id ?? sessions.get(session).tab_id,
        op,
        is_write,
        status: "queued",
        execution_token: null,
        lease_until: 0,
        deliveries: 0,
        result: undefined,
      });
      queueOf(session).push({ id });
      wake(session);
      return id;
    },
    redeliver(session, claimed) {
      queueOf(session).push({ raw: claimed });
      wake(session);
    },
    failNextResultWith404() {
      forceResult404++;
    },
    liveSession() {
      const ids = [...sessions.entries()].filter(([id]) => live(id)).map(([id]) => id);
      return ids[ids.length - 1] ?? null;
    },
  };
  return api;
}

const RUN_ID = randomUUID();

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Loop fixture</title>
<style>body{font:16px sans-serif;margin:20px} button{font-size:16px;margin:4px}</style></head>
<body><h1>Loop fixture</h1>
<button id="save">Save</button>
<div>clicks=<span id="count">0</span></div>
<script>
  let n = 0;
  document.getElementById("save").addEventListener("click", () => {
    n++;
    document.getElementById("count").textContent = String(n);
  });
</script></body></html>`;

function serveFixture() {
  return new Promise((res) => {
    const s = createServer((req, rsp) => {
      if (new URL(req.url, "http://x").pathname !== "/loop") return rsp.writeHead(404).end();
      rsp.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FIXTURE);
    });
    s.listen(0, "127.0.0.1", () => res(s));
  });
}

function buildExtension(tmp, apiBase) {
  const ext = join(tmp, "ext");
  execFileSync(process.execPath, ["scripts/build.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      ZAVI_BUILD_OUT: ext,
      ZAVI_API_BASE: apiBase,
      ZAVI_SUPABASE_URL: apiBase,
      ZAVI_SUPABASE_ANON_KEY: "e2e-anon-not-a-real-key",
      ZAVI_WEB_BASE: apiBase,
    },
  });
  const mf = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  mf.host_permissions = [...(mf.host_permissions ?? []), "<all_urls>"];
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(mf, null, 2));
  return ext;
}

async function launch(ext, userDataDir, headless) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless,
    viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    return { context, sw, extId: new URL(sw.url()).host };
  } catch (e) {
    await context.close().catch(() => undefined);
    throw e;
  }
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (e) {
    results.push({ name, ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function poll(fn, ms = 5000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "zavi-ext-loop-"));
  const mock = createMock();
  const servers = [mock.server];
  let context;
  let mode = "";
  try {
    await new Promise((r) => mock.server.listen(0, "127.0.0.1", r));
    const API = `http://127.0.0.1:${mock.server.address().port}`;
    const fixSrv = await serveFixture();
    servers.push(fixSrv);
    const FIX = `http://localhost:${fixSrv.address().port}/loop`;
    const ext = buildExtension(tmp, API);

    let launched;
    if (!HEADED) {
      try {
        launched = await launch(ext, join(tmp, "profile-headless"), true);
        mode = "headless (new headless, channel=chromium)";
      } catch (e) {
        console.log(`[e2e:loop] headless launch did not load the extension (${e.message}); falling back to headed`);
      }
    }
    if (!launched) {
      launched = await launch(ext, join(tmp, "profile-headed"), false);
      mode = "headed";
    }
    context = launched.context;
    const { sw, extId } = launched;
    console.log(`[e2e:loop] mode=${mode} extension=${extId} api=${API} fixture=${FIX}`);

    const fixture = context.pages()[0] ?? (await context.newPage());
    await fixture.goto(FIX);
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost/*" }))[0]?.id ?? null);
    assert(Number.isInteger(tabId), "fixture tab not found from the extension");

    await sw.evaluate(
      async ([session]) => {
        await chrome.storage.local.set({ "zavi-ext-auth": session, "zv:first-run-dismissed": true });
      },
      [STORED_SESSION],
    );
    const probe = () =>
      sw.evaluate(async (t) => {
        try {
          await chrome.debugger.sendCommand({ tabId: t }, "Page.getLayoutMetrics", {});
          return "attached";
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }, tabId);
    const clicks = async () => Number(await fixture.textContent("#count"));
    const sessionCalls = () => mock.calls.filter((c) => c.method === "POST" && c.path === "/api/extension/sessions");
    const resultsFor = (opId) => mock.calls.filter((c) => c.method === "POST" && c.path === `/api/extension/ops/${opId}/result`);
    const pollsAfter = (t) => mock.calls.filter((c) => c.method === "GET" && c.path === "/api/extension/ops/next" && c.t > t);

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/panel.html?tabId=${tabId}`);
    await fixture.bringToFront();

    let session = null;
    await check("session created for the panel's own tab (201)", async () => {
      const c = await poll(() => sessionCalls().find((x) => x.status === 201));
      assert(c, `no POST /api/extension/sessions (calls: ${mock.calls.map((x) => `${x.method} ${x.path} ${x.status}`).join(", ")})`);
      assert(c.body?.tab_id === tabId, `tab_id ${c.body?.tab_id} != fixture tab ${tabId}`);
      session = c.extra.session_id;
      const p = await poll(() => pollsAfter(0).find((x) => x.extra?.session === session));
      assert(p, "panel never long-polled GET /api/extension/ops/next for its session");
      return `tab_id=${tabId}`;
    });
    const sessionStartedAt = Date.now();

    let saveRef = null;
    await check("ax_snapshot claimed, run in the tab, result posted with its execution_token", async () => {
      assert(session, "no session");
      const id = mock.enqueue(session, { op: "ax_snapshot" });
      const r = await poll(() => resultsFor(id).find((x) => x.status));
      assert(r, "no result posted for the snapshot");
      const op = mock.ops.get(id);
      assert(r.status === 204, `result answered ${r.status}`);
      assert(r.body.execution_token === op.execution_token, "result token != delivered token");
      assert(r.body.session_id === session && r.body.run_id === RUN_ID, "result session/run mismatch");
      assert(r.body.status === "done", `snapshot status ${r.body.status}: ${JSON.stringify(r.body.result).slice(0, 120)}`);
      const node = (r.body.result?.nodes ?? []).find((n) => n.role === "button" && n.name === "Save");
      assert(node, "Save button not in the snapshot");
      saveRef = node.ref;
      return `${r.body.result.nodes.length} nodes`;
    });

    let clickOp = null;
    await check("click_ref claimed, executed on the page (marker), same token posted back", async () => {
      assert(saveRef, "no ref");
      const id = mock.enqueue(session, { op: "click_ref", ref: saveRef });
      const n = await poll(async () => ((await clicks()) === 1 ? 1 : 0));
      assert(n === 1, `fixture clicks=${await clicks()}`);
      const r = await poll(() => resultsFor(id).find((x) => x.status));
      assert(r && r.status === 204, `result ${r?.status}`);
      const op = mock.ops.get(id);
      assert(r.body.execution_token === op.execution_token && r.body.status === "done", `token/status mismatch (${r.body.status})`);
      clickOp = { id, ...mock.calls.find((c) => c.extra?.op?.id === id).extra.op };
      return "clicks=1";
    });

    await check("working bar + step line render with approved copy", async () => {
      const bar = await panel.waitForSelector(".zv-workbar", { timeout: 3000 });
      const text = (await bar.textContent()) ?? "";
      assert(text.includes("Zavi is working in this tab"), `bar text: ${text}`);
      const stop = await panel.$(".zv-workbar-stop");
      assert(stop && (await stop.textContent()) === "Stop", "Stop button missing");
      const lines = await poll(async () => {
        const l = await panel.$$eval(".zv-tabsteps .zv-step", (els) => els.map((e) => e.textContent ?? ""));
        return l.some((x) => x.includes("Clicked Save")) ? l : null;
      }, 3000);
      assert(lines, "no 'Clicked Save' step line");
      return lines.map((l) => l.replace("✓", "").trim()).join(" | ");
    });

    await check("duplicate delivery of the same execution_token is refused (no second click, no result)", async () => {
      assert(clickOp, "no prior click op");
      const before = resultsFor(clickOp.id).length;
      mock.redeliver(session, clickOp);
      const claimed = await poll(() => mock.calls.filter((c) => c.extra?.op?.execution_token === clickOp.execution_token)[1]);
      assert(claimed, "duplicate was never delivered");
      const next = await poll(() => pollsAfter(claimed.t).length > 0);
      assert(next, "panel stopped polling after the duplicate");
      await sleep(500);
      assert((await clicks()) === 1, `clicked again: clicks=${await clicks()}`);
      assert(resultsFor(clickOp.id).length === before, "a result was posted for the duplicate");
      return "clicks stays 1";
    });

    await check("op for a different tab is refused (failed wrong_tab, nothing runs)", async () => {
      const id = mock.enqueue(session, { op: "click_ref", ref: saveRef }, { tab_id: tabId + 1000 });
      const r = await poll(() => resultsFor(id).find((x) => x.status));
      assert(r, "no result for the wrong-tab op");
      assert(r.body.status === "failed" && r.body.result?.error_code === "wrong_tab", `got ${r.body.status} ${JSON.stringify(r.body.result)}`);
      await sleep(300);
      assert((await clicks()) === 1, `wrong-tab op clicked: clicks=${await clicks()}`);
      return "wrong_tab";
    });

    await check("result POST answered 404 does not make the panel retry the click", async () => {
      mock.failNextResultWith404();
      const id = mock.enqueue(session, { op: "click_ref", ref: saveRef });
      const r = await poll(() => resultsFor(id).find((x) => x.status));
      assert(r && r.status === 404 && r.extra?.forced404, `first result ${r?.status}`);
      assert((await clicks()) === 2, `clicks=${await clicks()} after the op`);
      const next = await poll(() => pollsAfter(r.t).length > 0);
      assert(next, "panel stopped polling after the 404");
      await sleep(1500);
      assert((await clicks()) === 2, `retried the click: clicks=${await clicks()}`);
      assert(resultsFor(id).length === 1, `result posted ${resultsFor(id).length}x`);
      assert(mock.ops.get(id).deliveries === 1, "op delivered more than once");
      return "one click, one result";
    });

    await check("first heartbeat is sent (≈10s after the session opens) and answered 204", async () => {
      const wait = Math.max(0, sessionStartedAt + 12_000 - Date.now());
      const hb = await poll(
        () => mock.calls.find((c) => c.method === "POST" && c.path === `/api/extension/sessions/${session}/heartbeat`),
        wait + 1000,
      );
      assert(hb, "no heartbeat within 12s");
      assert(hb.status === 204, `heartbeat answered ${hb.status}`);
      return `after ${((hb.t - mock.calls.find((c) => c.extra?.session_id === session).t) / 1000).toFixed(1)}s`;
    });

    await check("Stop: DELETE session, debugger detached, working bar gone, no op runs after", async () => {
      const snap = mock.enqueue(session, { op: "ax_snapshot" });
      await poll(() => resultsFor(snap).find((x) => x.status));
      assert((await probe()) === "attached", `not attached before Stop: ${await probe()}`);
      await panel.click(".zv-workbar-stop");
      const del = await poll(() => mock.calls.find((c) => c.method === "DELETE" && c.path === `/api/extension/sessions/${session}`));
      assert(del && del.status === 204, `DELETE ${del?.status}`);
      const off = await poll(async () => {
        const p = await probe();
        return /not attached/i.test(p) ? p : null;
      });
      assert(off, `still attached after Stop: ${await probe()}`);
      const gone = await poll(async () => (await panel.$(".zv-workbar")) === null);
      assert(gone, "working bar still shown");
      const note = await panel.textContent(".zv-tabsteps-note").catch(() => null);
      assert(note === "Stopped. Here's what I did before you stopped me:", `stopped note: ${note}`);
      const late = mock.enqueue(session, { op: "click_ref", ref: saveRef });
      await sleep(1500);
      assert((await clicks()) === 2, `op ran after Stop: clicks=${await clicks()}`);
      assert(resultsFor(late).length === 0, "result posted for the stopped session");
      assert(mock.ops.get(late).deliveries === 0, "op delivered after Stop");
      const fresh = await poll(() => sessionCalls().filter((c) => c.status === 201).length >= 2);
      assert(fresh, "no fresh session after Stop");
      return "DELETE 204, detached, fresh session opened";
    });

    await check("closing the panel ends its session (keepalive DELETE) and detaches", async () => {
      const fresh = mock.liveSession();
      assert(fresh && fresh !== session, "no fresh live session to end");
      const snap = mock.enqueue(fresh, { op: "ax_snapshot" });
      const r = await poll(() => resultsFor(snap).find((x) => x.status));
      assert(r && r.status === 204, `snapshot on the fresh session: ${r?.status}`);
      assert((await probe()) === "attached", "not attached before close");
      await panel.close({ runBeforeUnload: true });
      const del = await poll(() => mock.calls.find((c) => c.method === "DELETE" && c.path === `/api/extension/sessions/${fresh}`));
      assert(del && del.status === 204, `DELETE on close: ${del?.status}`);
      const off = await poll(async () => {
        const p = await probe();
        return /not attached/i.test(p) ? p : null;
      });
      assert(off, `debugger still attached after the panel closed: ${await probe()}`);
      return "DELETE 204, detached";
    });

    await check("no unexpected API calls", async () => {
      assert(mock.unexpected.length === 0, mock.unexpected.join(", "));
      const unauthed = mock.calls.filter((c) => c.status === 401);
      assert(unauthed.length === 0, `${unauthed.length} unauthenticated calls`);
      return `${mock.calls.length} calls`;
    });
  } finally {
    if (context) await context.close().catch(() => undefined);
    for (const s of servers) {
      s.closeAllConnections?.();
      s.close();
    }
    rmSync(tmp, { recursive: true, force: true });
  }

  const w = Math.max(...results.map((r) => r.name.length));
  console.log(`\nZavi extension e2e: panel loop (${mode})\n${"-".repeat(w + 10)}`);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  ${r.detail}`);
  const failedN = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failedN}/${results.length} passed`);
  process.exitCode = failedN ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
