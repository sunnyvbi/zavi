import { Sandbox } from "e2b";
import WebSocket from "ws";

const TEMPLATE = process.argv[2] || process.env.E2B_ENGINEER_TEMPLATE || undefined;
const ORIGIN = "https://www.zaviagent.com";
const DIR = "/home/user/repo";
const EDITS = 5;
const results = { template: TEMPLATE ?? "default", steps: [], pass: false };

function step(name, ok, detail = {}) {
  results.steps.push({ name, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function page(token) {
  return `export default function Page() { return <main><h1 id="t">${token}</h1></main>; }\n`;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { accept: "text/html" }, redirect: "manual" });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function main() {
  const t0 = Date.now();
  const sb = await Sandbox.create(TEMPLATE, { timeoutMs: 15 * 60 * 1000 });
  step("sandbox created", true, { ms: Date.now() - t0 });
  try {
    await sb.files.write(`${DIR}/package.json`, JSON.stringify({
      name: "live-edit-smoke",
      private: true,
      scripts: { dev: "next dev -p 3000 -H 0.0.0.0" },
      dependencies: { next: "14.2.35", react: "18.3.1", "react-dom": "18.3.1", typescript: "5.5.4", "@types/react": "18.3.3", "@types/node": "20.14.10" },
    }, null, 2));
    await sb.files.write(`${DIR}/app/layout.tsx`, `export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html>; }\n`);
    await sb.files.write(`${DIR}/app/page.tsx`, page("TOKEN-0"));
    await sb.files.write(`${DIR}/tsconfig.json`, JSON.stringify({ compilerOptions: { jsx: "preserve", strict: false, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", allowJs: true, skipLibCheck: true, noEmit: true, incremental: true, isolatedModules: true, resolveJsonModule: true, lib: ["dom", "esnext"], plugins: [{ name: "next" }] }, include: ["**/*.ts", "**/*.tsx"] }));

    const tInstall = Date.now();
    const install = await sb.commands.run(`cd ${DIR} && npm install --no-audit --no-fund --silent`, { timeoutMs: 600_000 });
    step("npm install", install.exitCode === 0, { ms: Date.now() - tInstall });

    const tBoot = Date.now();
    await sb.commands.run(`cd ${DIR} && npm run dev > /tmp/dev.log 2>&1`, { background: true, timeoutMs: 0 });
    const host = sb.getHost(3000);
    const url = `https://${host}`;
    let first = null;
    let last = "none";
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetchText(`${url}/`);
        last = `http ${r.status}`;
        if (r.status === 200 && r.text.includes("TOKEN-0")) {
          first = r;
          break;
        }
      } catch (e) {
        last = String(e?.message ?? e).slice(0, 120);
      }
      await sleep(1000);
    }
    const bootMs = Date.now() - tBoot;
    if (!first) {
      const log = await sb.commands.run("tail -c 1500 /tmp/dev.log; echo; (curl -s -o /dev/null -w 'local %{http_code}' http://127.0.0.1:3000/ || true)", { timeoutMs: 20_000 }).catch(() => ({ stdout: "" }));
      step("first page through the e2b host", false, { ms: bootMs, last, dev_log_tail: log.stdout });
      return;
    }
    step("first page through the e2b host", true, { ms: bootMs, under_90s: bootMs < 90_000 });

    const xfo = first.headers.get("x-frame-options");
    const csp = first.headers.get("content-security-policy") ?? "";
    step("page is frameable", !xfo && !/frame-ancestors/i.test(csp), { x_frame_options: xfo, csp: csp.slice(0, 120) });

    const wsUrl = `wss://${host}/_next/webpack-hmr`;
    const messages = [];
    const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN } });
    const opened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, why: "timeout" }), 20_000);
      ws.on("open", () => { clearTimeout(timer); resolve({ ok: true }); });
      ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); resolve({ ok: false, why: `http ${res.statusCode}` }); });
      ws.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, why: String(e.message ?? e) }); });
    });
    ws.on("message", (m) => messages.push({ at: Date.now(), data: String(m).slice(0, 200) }));
    step("HMR websocket upgrade (wss /_next/webpack-hmr, zavi origin)", opened.ok, opened);

    const edits = [];
    for (let n = 1; n <= EDITS; n++) {
      const token = `TOKEN-${n}-${Math.random().toString(36).slice(2, 8)}`;
      const before = messages.length;
      const tEdit = Date.now();
      await sb.files.write(`${DIR}/app/page.tsx`, page(token));
      let htmlMs = null;
      for (let i = 0; i < 30; i++) {
        await sleep(500);
        try {
          const r = await fetchText(`${url}/`);
          if (r.text.includes(token)) { htmlMs = Date.now() - tEdit; break; }
        } catch {}
      }
      const hmrFrame = messages.slice(before).find((m) => /built|sync|serverComponentChanges|building/.test(m.data));
      edits.push({ n, html_ms: htmlMs, hmr_frame_ms: hmrFrame ? hmrFrame.at - tEdit : null });
    }
    const allHtml = edits.every((e) => e.html_ms !== null && e.html_ms < 10_000);
    const allHmr = opened.ok && edits.every((e) => e.hmr_frame_ms !== null && e.hmr_frame_ms < 10_000);
    step("edits reach the served page within 10 s", allHtml, { edits });
    step("each edit emits an HMR frame within 10 s", allHmr, {});
    ws.close();

    const tPause = Date.now();
    await sb.betaPause();
    step("sandbox paused", true, { ms: Date.now() - tPause });
    const tResume = Date.now();
    const resumed = await Sandbox.connect(sb.sandboxId);
    let resumedOk = false;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetchText(`${url}/`);
        if (r.status === 200) { resumedOk = true; break; }
      } catch {}
      await sleep(500);
    }
    step("dev server answers after pause and resume", resumedOk, { ms: Date.now() - tResume, under_5s: Date.now() - tResume < 5000 });
    void resumed;

    results.pass = results.steps.every((s) => s.ok);
  } finally {
    await Sandbox.kill(sb.sandboxId).catch(() => undefined);
    console.log("sandbox killed");
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.pass ? 0 : 1;
  }
}

main().catch((e) => {
  console.error("smoke crashed:", e?.message ?? e);
  process.exitCode = 2;
});
