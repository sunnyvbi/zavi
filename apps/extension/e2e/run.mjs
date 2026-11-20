
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildExtension, launch } from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HEADED = process.env.E2E_HEADED === "1";

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font:16px sans-serif;margin:20px} input,button{font-size:16px;margin:4px}</style>` +
  `</head><body>${body}</body></html>`;

function mainPage(framePort) {
  return page(
    "Main fixture",
    `<h1>Main fixture</h1>
<form id="f" onsubmit="return false">
  <label for="when">When</label> <input id="when" value="Later">
  <button type="button" id="save">Save</button>
</form>
<div id="marker"></div>

<label for="ctl">Controlled</label> <input id="ctl" value="abc">
<div>state=<span id="ctl-state">abc</span> events=<span id="ctl-count">0</span></div>

<div id="ed" contenteditable="true" aria-label="Editor" style="border:1px solid #999;padding:4px;width:300px">old text</div>

<div id="react-root"></div>

<label for="enterbox">Enter box</label> <input id="enterbox">
<div id="enter-marker"></div>

<div style="margin-left:250px;margin-top:30px">
  <iframe id="fr" title="Embedded" src="http://127.0.0.1:${framePort}/frame" width="420" height="160" style="border:2px solid #333"></iframe>
</div>
<div style="height:3000px"></div>
<div id="bottom">bottom</div>
<script>
  // React-like controlled input: state is the source of truth, updated only by
  // the 'input' event handler, and the DOM value is re-set from state.
  let state = "abc", count = 0;
  const ctl = document.getElementById("ctl");
  ctl.addEventListener("input", (e) => {
    state = e.target.value; count++;
    ctl.value = state;
    document.getElementById("ctl-state").textContent = state;
    document.getElementById("ctl-count").textContent = String(count);
  });
  document.getElementById("save").addEventListener("click", () => {
    document.getElementById("marker").textContent = "saved:" + document.getElementById("when").value;
  });
  document.getElementById("enterbox").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("enter-marker").textContent = "enter";
  });
</script>
<script src="/react-app.js"></script>`,
  );
}

const REACT_APP = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
function App() {
  const [v, setV] = useState("draft");
  const [n, setN] = useState(0);
  return React.createElement("div", null,
    React.createElement("label", { htmlFor: "rx" }, "React field"),
    React.createElement("input", { id: "rx", value: v, onChange: (e) => { setV(e.target.value); setN((k) => k + 1); } }),
    React.createElement("span", { id: "rx-state" }, v),
    React.createElement("span", { id: "rx-count" }, String(n)));
}
createRoot(document.getElementById("react-root")).render(React.createElement(App));
`;

const controlsPage = page(
  "Controls fixture",
  `<h1>Controls fixture</h1>
<div id="controls-root"></div>
<label><input type="checkbox" id="cb"> Enable alerts</label>
<fieldset><legend>Plan</legend>
  <label><input type="radio" name="plan" id="r-basic" checked> Basic</label>
  <label><input type="radio" name="plan" id="r-pro"> Pro</label>
</fieldset>
<label for="start">Start date</label> <input type="date" id="start" value="2026-01-02">
<label for="nick">Nickname</label> <input id="nick" placeholder="e.g. Sam" value="Kit" required>
<label for="pw">Password</label> <input type="password" id="pw" value="hunter2secret">
<span>Rows per page</span><button id="icon" onclick="document.getElementById('icon-m').textContent='icon'"><svg width="10" height="10"></svg></button><span id="icon-m"></span>
<ul role="listbox" aria-label="Fruits" tabindex="0" id="lb" aria-activedescendant="o-apple">
  <li role="option" id="o-apple" aria-selected="true">Apple</li>
  <li role="option" id="o-banana" aria-selected="false">Banana</li>
  <li role="option" id="o-cherry" aria-selected="false">Cherry</li>
</ul>
<button id="promo" onclick="document.getElementById('ov').style.display='block'">Open promo</button>
<button id="behind" onclick="document.getElementById('behind-m').textContent='behind-clicked'">Behind</button><span id="behind-m"></span>
<div id="ov" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10"><p style="background:#fff;margin:100px;padding:20px">Promo! Press Escape.</p></div>
<div style="position:relative;display:inline-block">
  <button id="tgt" onclick="document.getElementById('tgt-m').textContent='target'">Confirm spend</button>
  <button id="pop" onclick="document.getElementById('tgt-m').textContent='pop'" style="position:absolute;left:30%;top:0;width:24px;height:100%;padding:0">x</button>
</div><span id="tgt-m"></span>
<span style="position:relative;display:inline-block;margin-left:20px">
  <input type="checkbox" id="dm" style="position:absolute;left:6px;top:6px;margin:0;opacity:0;z-index:0">
  <label for="dm" style="position:relative;z-index:1;display:inline-block;padding:4px 4px 4px 28px;border:1px solid #333;background:#fff">Dark mode</label>
</span>
<button id="paybtn" onclick="document.getElementById('pay-m').textContent='paid'">Pay now</button><span id="pay-m"></span>
<div style="height:2500px"></div>
<button id="far" onclick="document.getElementById('far-m').textContent='far'">Far away</button><span id="far-m"></span>
<script>
  const lb = document.getElementById("lb");
  const opts = [...lb.querySelectorAll("[role=option]")];
  let i = 0;
  lb.addEventListener("keydown", (e) => {
    const n = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: opts.length - 1 }[e.key];
    if (n === undefined) return;
    e.preventDefault();
    i = Math.max(0, Math.min(opts.length - 1, n));
    opts.forEach((o, k) => o.setAttribute("aria-selected", String(k === i)));
    lb.setAttribute("aria-activedescendant", opts[i].id);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.getElementById("ov").style.display = "none";
  });
</script>
<script src="/controls-app.js"></script>`,
);

const CONTROLS_APP = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
function App() {
  const [bt, setBt] = useState("daily");
  const [on, setOn] = useState(false);
  const [report, setReport] = useState(null);
  const load = () => setTimeout(() => setReport("Report ready: 42 rows"), 800);
  return React.createElement("div", null,
    React.createElement("label", { htmlFor: "bt" }, "Budget type"),
    React.createElement("select", { id: "bt", value: bt, onChange: (e) => setBt(e.target.value) },
      React.createElement("option", { value: "daily" }, "Daily"),
      React.createElement("option", { value: "daily-b" }, "Daily budget"),
      React.createElement("option", { value: "life" }, "Lifetime")),
    React.createElement("span", { id: "bt-state" }, bt),
    React.createElement("div", { role: "switch", "aria-checked": String(on), "aria-label": "Auto-renew", tabIndex: 0, id: "sw",
      onClick: () => setOn((v) => !v), style: { display: "inline-block", width: 40, height: 20, background: on ? "#0a0" : "#ccc" } }),
    React.createElement("button", { id: "load", onClick: load }, "Load report"),
    report && React.createElement("p", { id: "report" }, report),
    report && React.createElement("button", { id: "dl" }, "Download"));
}
createRoot(document.getElementById("controls-root")).render(React.createElement(App));
`;

const lateVisiblePage = page(
  "Late visible fixture",
  `<div style="margin-top:6000px">${Array.from({ length: 1000 }, (_, i) => `<button>Row ${i + 1}</button>`).join("")}</div>` +
    `<button style="position:fixed;top:10px;left:10px">Pinned action</button>`,
);

const bigPage = page(
  "Big fixture",
  Array.from({ length: 1500 }, (_, i) => `<button>Item ${i + 1}</button>`).join(""),
);

const framePage = (nestedSrc) => page(
  "Frame fixture",
  `<iframe id="nested" title="Nested" src="${nestedSrc}" width="300" height="60"></iframe><br>
<button id="inside" onclick="document.getElementById('fm').textContent='frame-clicked'">Inside frame</button>
<label for="fi">Frame input</label> <input id="fi" value="frame old">
<div id="fm"></div>`,
);

const nestedPage = page(
  "Nested fixture",
  `<button onclick="document.getElementById('nm').textContent='deep-clicked'">Deep button</button><span id="nm"></span>`,
);

const checkoutPage = page(
  "Checkout fixture",
  `<h1>Checkout</h1>
<p>Order total: $20.00</p>
<form id="payform" onsubmit="return false">
  <label for="cc">Card number</label> <input id="cc" name="card" autocomplete="cc-number">
  <button type="button" id="submit" onclick="document.getElementById('paid').textContent='paid'">Submit</button>
</form>
<a id="paylink" href="/pay/1">Pay now</a>
<div id="paid"></div>`,
);

const innerGridPage = page(
  "Inner grid fixture",
  `<style>html,body{height:100%;margin:0;overflow:hidden}#grid{height:700px;overflow:auto;border:1px solid #999}
.r{height:28px;border-bottom:1px solid #ddd;padding:0 8px}</style>
<div id="grid" role="grid" aria-label="Tasks">${Array.from({ length: 200 }, (_, i) => `<div class="r" role="row">Row ${i + 1}</div>`).join("")}</div>`,
);
const canvasGridPage = page(
  "Canvas grid fixture",
  `<style>html,body{height:100%;margin:0;overflow:hidden}</style>
<canvas id="cv" width="1000" height="760" style="display:block"></canvas>
<script>
  const cv = document.getElementById("cv"), g = cv.getContext("2d");
  let first = 0;
  const draw = () => {
    g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = "#000"; g.font = "16px sans-serif";
    for (let i = 0; i < 27; i++) g.fillText("Row " + (first + i + 1), 10, 24 + i * 28);
    cv.dataset.top = String(first);
  };
  cv.addEventListener("wheel", (e) => { e.preventDefault(); first = Math.max(0, Math.min(173, first + Math.sign(e.deltaY) * 20)); draw(); }, { passive: false });
  draw();
</script>`,
);
const staticEndPage = page(
  "Static end fixture",
  `<div style="height:1600px"></div>
<div id="box" style="height:300px;overflow:hidden;border:1px solid #999">${Array.from({ length: 5 }, (_, i) => `<p>Line ${i + 1}</p>`).join("")}</div>`,
);

const pointerPage = page(
  "Pointer fixture",
  `<button id="dbl" ondblclick="document.getElementById('dbl-m').textContent='dbl'">Double me</button><span id="dbl-m"></span>
<p id="para">Alpha beta gamma paragraph.</p>
<button id="mod" onclick="document.getElementById('mod-m').textContent=event.shiftKey?'shift':'plain'">Modifier me</button><span id="mod-m"></span>
<div style="position:fixed;inset:0;pointer-events:none;z-index:5"></div>
<div style="height:2400px"></div>
<button id="deep" onclick="document.getElementById('deep-m').textContent='deep'">Deep button</button><span id="deep-m"></span>
<div style="height:600px"></div>`,
);

function serve(routes) {
  return new Promise((res) => {
    const s = createServer((req, rsp) => {
      const path = new URL(req.url, "http://x").pathname;
      const r = routes(path);
      if (r == null) {
        rsp.writeHead(404).end("not found");
        return;
      }
      const { type, body } = typeof r === "string" ? { type: "text/html; charset=utf-8", body: r } : r;
      rsp.writeHead(200, { "content-type": type }).end(body);
    });
    s.listen(0, "127.0.0.1", () => res(s));
  });
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
async function poll(fn, ms = 3000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "zavi-ext-e2e-"));
  const servers = [];
  let context;
  let mode = "";
  try {
    const ext = await buildExtension(tmp);
    const bundle = async (contents) =>
      (
        await build({
          stdin: { contents, resolveDir: ROOT, loader: "js" },
          bundle: true,
          write: false,
          format: "iife",
          minify: true,
          define: { "process.env.NODE_ENV": '"production"' },
          logLevel: "warning",
        })
      ).outputFiles[0].text;
    const reactJs = await bundle(REACT_APP);
    const controlsJs = await bundle(CONTROLS_APP);
    let p2 = 0;
    const frameSrv = await serve((p) =>
      p === "/frame" ? framePage(`http://nested.test:${p2}/nested`) : p === "/nested" ? nestedPage : null,
    );
    p2 = frameSrv.address().port;
    const topSrv = await serve((p) =>
      p === "/main"
        ? mainPage(p2)
        : p === "/checkout"
          ? checkoutPage
          : p === "/react-app.js"
            ? { type: "text/javascript", body: reactJs }
            : p === "/controls"
            ? controlsPage
            : p === "/controls-app.js"
            ? { type: "text/javascript", body: controlsJs }
            : p === "/big"
            ? bigPage
            : p === "/late"
            ? lateVisiblePage
            : p === "/grid"
            ? innerGridPage
            : p === "/canvas"
            ? canvasGridPage
            : p === "/static-end"
            ? staticEndPage
            : p === "/pointer"
            ? pointerPage
            : p === "/pay/1"
            ? page("Pay", "<h1>Pay page</h1>")
            : null,
    );
    servers.push(frameSrv, topSrv);
    const p1 = topSrv.address().port;
    const TOP = `http://localhost:${p1}`;

    let launched;
    if (!HEADED) {
      try {
        launched = await launch(ext, join(tmp, "profile-headless"), true);
        mode = "headless (new headless, channel=chromium)";
      } catch (e) {
        console.log(`[e2e] headless launch did not load the extension (${e.message}); falling back to headed`);
      }
    }
    if (!launched) {
      launched = await launch(ext, join(tmp, "profile-headed"), false);
      mode = "headed";
    }
    context = launched.context;
    const { extId } = launched;
    console.log(`[e2e] mode=${mode} extension=${extId} top=${TOP} frame=http://127.0.0.1:${p2}`);

    const fixture = context.pages()[0] ?? (await context.newPage());
    await fixture.goto(`${TOP}/main`);
    const harness = await context.newPage();
    await harness.goto(`chrome-extension://${extId}/harness.html`);
    await harness.waitForSelector("body[data-ready='1']", { state: "attached" });
    await fixture.bringToFront();

    const tabId = await harness.evaluate(() => window.__zavi.findTab("http://localhost/*"));
    assert(Number.isInteger(tabId), "fixture tab not found from the extension");
    const run = (op) => harness.evaluate(([t, o]) => window.__zavi.run(t, o), [tabId, op]);
    const frameOf = () => fixture.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${p2}`));
    let nodes = [];
    const find = (role, name) => nodes.find((n) => n.role === role && n.name === name);

    await check("attach", async () => {
      const r = await harness.evaluate((t) => window.__zavi.attach(t), tabId);
      assert(r.ok, `attach failed: ${r.error}`);
    });

    await check("ax_snapshot: Save, input, iframe button", async () => {
      const out = await run({ op: "ax_snapshot" });
      assert(out.status === "done", JSON.stringify(out.result));
      nodes = out.result.nodes;
      const save = find("button", "Save");
      const when = find("textbox", "When");
      const inside = find("button", "Inside frame");
      assert(save, "no Save button");
      assert(when, "no When textbox");
      assert(inside, `no 'Inside frame' button (frames=${JSON.stringify(await harness.evaluate((t) => window.__zavi.frames(t), tabId))})`);
      assert(inside.ref.frame_session, "Inside frame has null frame_session");
      assert(out.result.top_url === `${TOP}/main`, `top_url=${out.result.top_url}`);
      return `${nodes.length} nodes; frame_session=${inside.ref.frame_session.slice(0, 8)}…`;
    });

    await check("click_ref Save → marker", async () => {
      const out = await run({ op: "click_ref", ref: find("button", "Save").ref });
      assert(out.status === "done", JSON.stringify(out.result));
      const m = await poll(() => fixture.textContent("#marker"));
      assert(m === "saved:Later", `marker=${JSON.stringify(m)}`);
    });

    await check("type_ref replaces 'Later' with 'Next quarter'", async () => {
      const out = await run({ op: "type_ref", ref: find("textbox", "When").ref, text: "Next quarter" });
      assert(out.status === "done", JSON.stringify(out.result));
      const v = await fixture.inputValue("#when");
      assert(v === "Next quarter", `value=${JSON.stringify(v)}`);
    });

    await check("type_ref on controlled input fires app handler", async () => {
      const out = await run({ op: "type_ref", ref: find("textbox", "Controlled").ref, text: "hello" });
      assert(out.status === "done", JSON.stringify(out.result));
      const v = await fixture.inputValue("#ctl");
      const st = await fixture.textContent("#ctl-state");
      const n = Number(await fixture.textContent("#ctl-count"));
      assert(v === "hello" && st === "hello" && n >= 1, `value=${v} state=${st} events=${n}`);
      return `input events=${n}`;
    });

    await check("type_ref on a REAL React controlled input fires onChange", async () => {
      await fixture.waitForSelector("#rx");
      const snap = await run({ op: "ax_snapshot" });
      nodes = snap.result.nodes;
      const rx = find("textbox", "React field");
      assert(rx, "React input not in snapshot");
      const out = await run({ op: "type_ref", ref: rx.ref, text: "from zavi" });
      assert(out.status === "done", JSON.stringify(out.result));
      const st = await poll(async () => ((await fixture.textContent("#rx-state")) === "from zavi" ? "ok" : null));
      const v = await fixture.inputValue("#rx");
      const n = Number(await fixture.textContent("#rx-count"));
      assert(st === "ok" && v === "from zavi" && n >= 1, `value=${v} state=${await fixture.textContent("#rx-state")} onChange=${n}`);
      return `onChange calls=${n}`;
    });

    await check("type_ref replaces contenteditable text", async () => {
      const ed = find("textbox", "Editor");
      assert(ed, `contenteditable not in snapshot (roles near: ${nodes.map((n) => `${n.role}:${n.name}`).join(", ")})`);
      const out = await run({ op: "type_ref", ref: ed.ref, text: "new text" });
      assert(out.status === "done", JSON.stringify(out.result));
      const t = await fixture.textContent("#ed");
      assert(t === "new text", `text=${JSON.stringify(t)}`);
    });

    await check("click_ref inside cross-origin iframe", async () => {
      const f = frameOf();
      assert(f, "iframe frame not found by Playwright");
      const out = await run({ op: "click_ref", ref: find("button", "Inside frame").ref });
      assert(out.status === "done", JSON.stringify(out.result));
      const m = await poll(() => f.textContent("#fm"));
      assert(m === "frame-clicked", `frame marker=${JSON.stringify(m)}`);
    });

    await check("type_ref inside cross-origin iframe", async () => {
      const fi = find("textbox", "Frame input");
      assert(fi && fi.ref.frame_session, "no frame input with a frame_session");
      const out = await run({ op: "type_ref", ref: fi.ref, text: "frame new" });
      assert(out.status === "done", JSON.stringify(out.result));
      const v = await frameOf().inputValue("#fi");
      assert(v === "frame new", `value=${JSON.stringify(v)}`);
    });

    await check("nested out-of-process iframe: snapshot + click", async () => {
      const deep = await poll(async () => {
        const snap = await run({ op: "ax_snapshot" });
        nodes = snap.result.nodes;
        return find("button", "Deep button");
      });
      assert(deep, `no 'Deep button' (frames=${JSON.stringify(await harness.evaluate((t) => window.__zavi.frames(t), tabId))})`);
      assert(deep.ref.frame_session && deep.ref.frame_session !== find("button", "Inside frame")?.ref.frame_session, "nested button not in its own session");
      const out = await run({ op: "click_ref", ref: deep.ref });
      assert(out.status === "done", JSON.stringify(out.result));
      const nf = fixture.frames().find((f) => f.url().startsWith("http://nested.test"));
      assert(nf, "nested frame not found by Playwright");
      const m = await poll(() => nf.textContent("#nm"));
      assert(m === "deep-clicked", `nested marker=${JSON.stringify(m)}`);
    });

    await check("resolve inside iframe reports the frame URL", async () => {
      const fi = find("textbox", "Frame input");
      const out = await run({ op: "resolve", ref: fi.ref });
      assert(out.status === "done", JSON.stringify(out.result));
      assert(String(out.result.frame_url).startsWith(`http://127.0.0.1:${p2}/frame`), `frame_url=${out.result.frame_url}`);
      assert(out.result.top_url === `${TOP}/main`, `top_url=${out.result.top_url}`);
    });

    await check("key Enter reaches the focused field", async () => {
      const box = find("textbox", "Enter box");
      let out = await run({ op: "click_ref", ref: box.ref });
      assert(out.status === "done", JSON.stringify(out.result));
      out = await run({ op: "key", key: "Enter" });
      assert(out.status === "done", JSON.stringify(out.result));
      const m = await poll(() => fixture.textContent("#enter-marker"));
      assert(m === "enter", `enter marker=${JSON.stringify(m)}`);
    });

    await check("resolve(null) names the focused field", async () => {
      const out = await run({ op: "resolve", ref: null });
      assert(out.status === "done", JSON.stringify(out.result));
      assert(out.result.name === "Enter box", `resolved name=${JSON.stringify(out.result.name)}`);
    });

    await check("scroll moves the page (centre is over an iframe)", async () => {
      const before = await fixture.evaluate(() => window.scrollY);
      const out = await run({ op: "scroll", dy: 600 });
      assert(out.status === "done", JSON.stringify(out.result));
      const after = await poll(async () => {
        const y = await fixture.evaluate(() => window.scrollY);
        return y > before ? y : 0;
      });
      assert(after > before, `scrollY ${before} → ${after}`);
      assert(out.result.page_moved === true, `page_moved=${out.result.page_moved}`);
      return `scrollY ${before} → ${after}`;
    });

    await check("screenshot returns a JPEG", async () => {
      const out = await run({ op: "screenshot" });
      assert(out.status === "done", JSON.stringify(out.result));
      const b = Buffer.from(out.result.image_base64, "base64");
      assert(b[0] === 0xff && b[1] === 0xd8, "not a JPEG");
      return `${b.length} bytes`;
    });

    await check("nav to checkout + assert_url", async () => {
      const out = await run({ op: "nav", url: `${TOP}/checkout` });
      assert(out.status === "done", JSON.stringify(out.result));
      assert(fixture.url() === `${TOP}/checkout`, `page url=${fixture.url()}`);
      assert(out.result.top_url === `${TOP}/checkout`, `top_url=${out.result.top_url}`);
      const ok = await run({ op: "assert_url", expected: "/checkout" });
      assert(ok.status === "done", "assert_url(/checkout) failed");
      const bad = await run({ op: "assert_url", expected: "/main" });
      assert(bad.status === "failed" && bad.result.error_code === "assert_url_mismatch", "assert_url(/main) did not fail");
    });

    await check("resolve script Submit: is_submit + card + $20.00", async () => {
      const snap = await run({ op: "ax_snapshot" });
      nodes = snap.result.nodes;
      const submit = find("button", "Submit");
      assert(submit, "no Submit button in checkout snapshot");
      const out = await run({ op: "resolve", ref: submit.ref });
      assert(out.status === "done", JSON.stringify(out.result));
      const r = out.result;
      assert(r.is_submit === true, `is_submit=${r.is_submit}`);
      assert(r.form?.has_card_field === true, `has_card_field=${r.form?.has_card_field}`);
      assert(r.amounts.includes("$20.00"), `amounts=${JSON.stringify(r.amounts)}`);
      return `amounts=${JSON.stringify(r.amounts)}`;
    });

    await check("resolve Pay now link reports href", async () => {
      const link = find("link", "Pay now");
      assert(link, "no Pay now link");
      const out = await run({ op: "resolve", ref: link.ref });
      assert(out.status === "done", JSON.stringify(out.result));
      assert(typeof out.result.href === "string" && out.result.href.includes("/pay/1"), `href=${out.result.href}`);
      return `href=${out.result.href}`;
    });

    await check("nav back: fresh iframe sessions, stale ones dropped", async () => {
      const stale = await harness.evaluate((t) => window.__zavi.frames(t), tabId);
      const out = await run({ op: "nav", url: `${TOP}/main` });
      assert(out.status === "done", JSON.stringify(out.result));
      const inside = await poll(async () => {
        const snap = await run({ op: "ax_snapshot" });
        nodes = snap.result.nodes;
        return find("button", "Inside frame");
      });
      assert(inside, "iframe button not in snapshot after nav back");
      const now = await harness.evaluate((t) => window.__zavi.frames(t), tabId);
      assert(!now.some((f) => stale.includes(f)), `stale sessions kept: ${JSON.stringify({ stale, now })}`);
      const c = await run({ op: "click_ref", ref: inside.ref });
      assert(c.status === "done", JSON.stringify(c.result));
      const m = await poll(() => frameOf()?.textContent("#fm"));
      assert(m === "frame-clicked", `frame marker=${JSON.stringify(m)}`);
      return `sessions ${stale.length} → ${now.length}`;
    });

    const snap = async () => {
      const out = await run({ op: "ax_snapshot" });
      assert(out.status === "done", JSON.stringify(out.result));
      nodes = out.result.nodes;
      return out.result;
    };

    await check("H1 perception: value, states, placeholder, near label, in_view, masked password", async () => {
      const out = await run({ op: "nav", url: `${TOP}/controls` });
      assert(out.status === "done", JSON.stringify(out.result));
      await fixture.waitForSelector("#bt");
      const r = await snap();
      const nick = find("textbox", "Nickname");
      assert(nick && nick.value === "Kit", `nickname=${JSON.stringify(nick)}`);
      assert(nick.states?.includes("required"), `nick states=${nick.states}`);
      assert(nick.desc === "e.g. Sam", `nick desc=${nick.desc}`);
      const cb = find("checkbox", "Enable alerts");
      assert(cb && cb.states?.includes("unchecked"), `cb=${JSON.stringify(cb)}`);
      const basic = find("radio", "Basic");
      assert(basic && basic.states?.includes("checked"), `basic=${JSON.stringify(basic)}`);
      const bt = find("combobox", "Budget type");
      assert(bt && bt.value === "Daily" && bt.states?.includes("collapsed"), `select=${JSON.stringify(bt)}`);
      const icon = nodes.find((n) => n.role === "button" && !n.name && n.near === "Rows per page");
      assert(icon, `no nameless button with near label (${JSON.stringify(nodes.filter((n) => !n.name))})`);
      const pw = find("textbox", "Password");
      assert(pw && !String(pw.value ?? "").includes("hunter2"), `password value leaked: ${JSON.stringify(pw)}`);
      const far = find("button", "Far away");
      assert(far && far.in_view === false, `far=${JSON.stringify(far)}`);
      assert(find("button", "Open promo")?.in_view === true, "Open promo not in view");
      const firstOff = nodes.findIndex((n) => n.in_view === false);
      assert(firstOff > 0 && nodes.slice(firstOff).every((n) => n.in_view !== true), "on-screen nodes are not first");
      assert(Array.isArray(r.texts) && r.texts.includes("Controls fixture"), `texts=${JSON.stringify(r.texts)}`);
      return `${nodes.length} nodes, ${JSON.stringify(r.nodes).length} chars, ${r.texts.length} texts`;
    });

    await check("H1 select_option on a native <select> fires React onChange", async () => {
      const bt = find("combobox", "Budget type");
      const out = await run({ op: "select_option", ref: bt.ref, label: "Lifetime" });
      assert(out.status === "done", JSON.stringify(out.result));
      assert((await fixture.textContent("#bt-state")) === "life", `state=${await fixture.textContent("#bt-state")}`);
      const again = await run({ op: "select_option", ref: bt.ref, value: "daily-b" });
      assert(again.status === "done", JSON.stringify(again.result));
      const st = await poll(async () => ((await fixture.textContent("#bt-state")) === "daily-b" ? "ok" : null));
      assert(st === "ok", `state=${await fixture.textContent("#bt-state")}`);
      const bad = await run({ op: "select_option", ref: bt.ref, label: "Weekly" });
      assert(bad.status === "failed" && bad.result.error_code === "no_such_option", JSON.stringify(bad.result));
      return `value=${again.result.value}`;
    });

    await check("H1 set_checked: checkbox, radio, ARIA switch (clicks only when needed)", async () => {
      let out = await run({ op: "set_checked", ref: find("checkbox", "Enable alerts").ref, checked: true });
      assert(out.status === "done" && out.result.changed === true, JSON.stringify(out.result));
      assert(await fixture.isChecked("#cb"), "checkbox not checked");
      out = await run({ op: "set_checked", ref: find("checkbox", "Enable alerts").ref, checked: true });
      assert(out.status === "done" && out.result.changed === false, `second set changed=${out.result.changed}`);
      assert(await fixture.isChecked("#cb"), "checkbox toggled off by a no-op set");
      out = await run({ op: "set_checked", ref: find("radio", "Pro").ref, checked: true });
      assert(out.status === "done" && (await fixture.isChecked("#r-pro")), JSON.stringify(out.result));
      await snap();
      const sw = find("switch", "Auto-renew");
      assert(sw && sw.states?.includes("unchecked"), `switch=${JSON.stringify(sw)}`);
      out = await run({ op: "set_checked", ref: sw.ref, checked: true });
      assert(out.status === "done", JSON.stringify(out.result));
      assert((await fixture.getAttribute("#sw", "aria-checked")) === "true", "switch not on");
    });

    await check("H1 type_ref into <input type=date> (ISO, locale-independent)", async () => {
      await snap();
      const d = nodes.find((n) => n.role === "Date" && n.name === "Start date");
      assert(d, `no Date node (${[...new Set(nodes.map((n) => n.role))].join(",")})`);
      const out = await run({ op: "type_ref", ref: d.ref, text: "2026-10-15" });
      assert(out.status === "done", JSON.stringify(out.result));
      const v = await fixture.inputValue("#start");
      assert(v === "2026-10-15", `value=${v}`);
      const bad = await run({ op: "type_ref", ref: d.ref, text: "10/15/2026" });
      assert(bad.status === "failed" && bad.result.error_code === "bad_date", JSON.stringify(bad.result));
    });

    await check("H1 arrow keys move an ARIA listbox (ArrowDown, Home)", async () => {
      await snap();
      const lb = find("listbox", "Fruits");
      let out = await run({ op: "click_ref", ref: lb.ref });
      assert(out.status === "done", JSON.stringify(out.result));
      for (const key of ["ArrowDown", "ArrowDown"]) {
        out = await run({ op: "key", key });
        assert(out.status === "done", JSON.stringify(out.result));
      }
      assert((await fixture.getAttribute("#lb", "aria-activedescendant")) === "o-cherry", "ArrowDown x2 did not reach Cherry");
      await run({ op: "key", key: "Home" });
      assert((await fixture.getAttribute("#lb", "aria-activedescendant")) === "o-apple", "Home did not reach Apple");
      await snap();
      const apple = find("option", "Apple");
      assert(apple?.states?.includes("selected"), `apple=${JSON.stringify(apple)}`);
      const bad = await run({ op: "key", key: "Delete" });
      assert(bad.status === "failed", "Delete key was accepted");
    });

    await check("H1 settle: React content that appears ~800ms after a click is in the next snapshot", async () => {
      await snap();
      const t0 = Date.now();
      const out = await run({ op: "click_ref", ref: find("button", "Load report").ref });
      const took = Date.now() - t0;
      assert(out.status === "done", JSON.stringify(out.result));
      const r = await snap();
      assert(find("button", "Download"), `no Download button right after the click (settle=${JSON.stringify(out.result.settle)})`);
      assert(r.texts.includes("Report ready: 42 rows"), `texts=${JSON.stringify(r.texts)}`);
      assert(out.result.settle?.settled === true, `settle=${JSON.stringify(out.result.settle)}`);
      return `click+settle ${took}ms (settle ${out.result.settle.ms}ms)`;
    });

    await check("H1 settle: a quiet step exits early (no multi-second wait)", async () => {
      const t0 = Date.now();
      const out = await run({ op: "type_ref", ref: find("textbox", "Nickname").ref, text: "Robin" });
      assert(out.status === "done", JSON.stringify(out.result));
      assert(out.result.settle?.settled === true && out.result.settle.ms < 1_000, `settle=${JSON.stringify(out.result.settle)}`);
      return `type+settle ${Date.now() - t0}ms (settle ${out.result.settle.ms}ms)`;
    });

    await check("H1 overlay eats the click → click_intercepted, nothing clicked; Escape clears it", async () => {
      let out = await run({ op: "click_ref", ref: find("button", "Open promo").ref });
      assert(out.status === "done", JSON.stringify(out.result));
      assert(await fixture.isVisible("#ov"), "overlay did not open");
      out = await run({ op: "click_ref", ref: find("button", "Behind").ref });
      assert(out.status === "failed" && out.result.error_code === "click_intercepted", JSON.stringify(out.result));
      assert((await fixture.textContent("#behind-m")) === "", "the covered button was clicked anyway");
      out = await run({ op: "key", key: "Escape" });
      assert(out.status === "done" && !(await fixture.isVisible("#ov")), "Escape did not close the overlay");
      out = await run({ op: "click_ref", ref: find("button", "Behind").ref });
      assert(out.status === "done", JSON.stringify(out.result));
      assert((await poll(() => fixture.textContent("#behind-m"))) === "behind-clicked", "Behind not clicked after Escape");
    });

    await check("F1 a small unrelated button over the target → click_intercepted, nothing clicked", async () => {
      await snap();
      const out = await run({ op: "click_ref", ref: find("button", "Confirm spend").ref });
      assert(out.status === "failed" && out.result.error_code === "click_intercepted", JSON.stringify(out.result));
      assert((await fixture.textContent("#tgt-m")) === "", `clicked: ${await fixture.textContent("#tgt-m")}`);
    });

    await check("F1 custom checkbox (hidden input under its styled label) still ticks", async () => {
      await snap();
      const dm = find("checkbox", "Dark mode");
      assert(dm, "no Dark mode checkbox");
      const out = await run({ op: "set_checked", ref: dm.ref, checked: true });
      assert(out.status === "done", JSON.stringify(out.result));
      assert(await fixture.isChecked("#dm"), "not checked");
    });

    await check("F2 focus moves to a Pay button between the check and the key → focus_changed, nothing pressed", async () => {
      await snap();
      let out = await run({ op: "click_ref", ref: find("textbox", "Nickname").ref });
      assert(out.status === "done", JSON.stringify(out.result));
      const checked = await run({ op: "resolve", ref: null });
      assert(checked.status === "done" && checked.result.name === "Nickname", `resolved=${checked.result.name}`);
      await fixture.focus("#paybtn");
      out = await run({ op: "key", key: "Enter", focus_ref: checked.result.ref });
      assert(out.status === "failed" && out.result.error_code === "focus_changed", JSON.stringify(out.result));
      out = await run({ op: "key", key: "Space", focus_ref: checked.result.ref });
      assert(out.status === "failed" && out.result.error_code === "focus_changed", JSON.stringify(out.result));
      assert((await fixture.textContent("#pay-m")) === "", "Pay was pressed");
      const payRef = (await run({ op: "resolve", ref: null })).result.ref;
      out = await run({ op: "key", key: "Space", focus_ref: payRef });
      assert(out.status === "done", JSON.stringify(out.result));
      assert((await poll(() => fixture.textContent("#pay-m"))) === "paid", "pinned key not pressed");
    });

    await check("H1 a node that left the page fails as stale_ref (nothing sent)", async () => {
      const out = await run({ op: "click_ref", ref: { frame_session: null, backend_node_id: 987654321 } });
      assert(out.status === "failed" && out.result.error_code === "stale_ref", JSON.stringify(out.result));
    });

    await check("H1 snapshot of 1500 buttons: capped, on-screen first, bounded size and time", async () => {
      const nav = await run({ op: "nav", url: `${TOP}/big` });
      assert(nav.status === "done", JSON.stringify(nav.result));
      const t0 = Date.now();
      const r = await snap();
      const ms = Date.now() - t0;
      const chars = JSON.stringify(r.nodes).length;
      assert(r.nodes.length <= 400 && r.truncated === true, `nodes=${r.nodes.length} truncated=${r.truncated}`);
      assert(chars <= 64_000, `chars=${chars}`);
      assert(r.nodes[0].name === "Item 1" && r.nodes[0].in_view === true, `first=${JSON.stringify(r.nodes[0])}`);
      assert(ms < 5_000, `snapshot took ${ms}ms`);
      return `${r.nodes.length} nodes, ${chars} chars, ${ms}ms`;
    });

    await check("F7 a visible control after 1,000 off-screen ones is measured and listed first", async () => {
      const nav = await run({ op: "nav", url: `${TOP}/late` });
      assert(nav.status === "done", JSON.stringify(nav.result));
      const t0 = Date.now();
      const r = await snap();
      const ms = Date.now() - t0;
      assert(r.nodes[0]?.name === "Pinned action" && r.nodes[0].in_view === true, `first=${JSON.stringify(r.nodes[0])}`);
      return `${ms}ms`;
    });

    const wheelScroll = async (path) => {
      const nav = await run({ op: "nav", url: `${TOP}${path}` });
      assert(nav.status === "done", JSON.stringify(nav.result));
      await fixture.waitForLoadState("load");
      return run({ op: "scroll", dy: 600 });
    };

    await check("scroll inside an inner grid (the page cannot move) succeeds; later rows come into view", async () => {
      const out = await wheelScroll("/grid");
      assert(out.status === "done", JSON.stringify(out.result));
      assert(out.result.page_moved === false, `page_moved=${out.result.page_moved}`);
      const st = await poll(async () => {
        const v = await fixture.evaluate(() => ({ top: document.getElementById("grid").scrollTop, y: window.scrollY }));
        return v.top > 0 ? v : null;
      });
      assert(st && st.top > 0, `grid scrollTop=${st?.top}`);
      assert(st.y === 0, `page scrollY=${st.y}`);
      const first = await fixture.evaluate(() => {
        const g = document.getElementById("grid").getBoundingClientRect();
        const el = document.elementFromPoint(g.left + 20, g.top + 5);
        return el ? el.textContent : "";
      });
      assert(first !== "Row 1" && /^Row \d+$/.test(first), `first visible row=${first}`);
      return `scrollTop ${st.top}, first visible ${first}, changed_by=${out.result.changed_by}`;
    });

    await check("scroll a canvas grid (rows are pixels) succeeds by the screenshot changing", async () => {
      const out = await wheelScroll("/canvas");
      assert(out.status === "done", JSON.stringify(out.result));
      assert(out.result.page_moved === false && out.result.changed_by === "screenshot", JSON.stringify(out.result));
      const top = await fixture.evaluate(() => Number(document.getElementById("cv").dataset.top));
      assert(top > 0, `canvas top row offset=${top}`);
      return `canvas offset ${top}`;
    });

    await check("scroll at the page bottom with a static inner area → scroll_no_move", async () => {
      const nav = await run({ op: "nav", url: `${TOP}/static-end` });
      assert(nav.status === "done", JSON.stringify(nav.result));
      await fixture.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const out = await run({ op: "scroll", dy: 600 });
      assert(out.status === "failed" && out.result.error_code === "scroll_no_move", JSON.stringify(out.result));
    });

    await check("B1 double / triple / Shift click (real events)", async () => {
      const nav = await run({ op: "nav", url: `${TOP}/pointer` });
      assert(nav.status === "done", JSON.stringify(nav.result));
      nodes = (await run({ op: "ax_snapshot" })).result.nodes;
      const d = await run({ op: "click_ref", ref: find("button", "Double me").ref, click_count: 2 });
      assert(d.status === "done" && (await poll(() => fixture.textContent("#dbl-m"))) === "dbl", `dblclick: ${JSON.stringify(d.result)}`);
      const m = await run({ op: "click_ref", ref: find("button", "Modifier me").ref, modifiers: ["Shift"] });
      assert(m.status === "done" && (await poll(() => fixture.textContent("#mod-m"))) === "shift", `shift click: ${await fixture.textContent("#mod-m")}`);
      const s = (await run({ op: "screenshot" })).result;
      const b = await fixture.locator("#para").boundingBox();
      const pt = { x: Math.round(((b.x + 20) * s.width) / s.css_width), y: Math.round(((b.y + b.height / 2) * s.height) / s.css_height), shot_w: s.width, shot_h: s.height };
      const t = await run({ op: "click_xy", ...pt, click_count: 3 });
      const sel = await fixture.evaluate(() => String(window.getSelection()).trim());
      assert(t.status === "done" && sel === "Alpha beta gamma paragraph.", `triple click selection=${JSON.stringify(sel)}`);
      return "dblclick, shiftKey, triple-click selection";
    });

    await check("B1 a click far down a SCROLLED page under a pointer-events:none layer lands (hit test in document coords)", async () => {
      nodes = (await run({ op: "ax_snapshot" })).result.nodes;
      const out = await run({ op: "click_ref", ref: find("button", "Deep button").ref });
      assert(out.status === "done", JSON.stringify(out.result));
      const y = await fixture.evaluate(() => window.scrollY);
      assert((await poll(() => fixture.textContent("#deep-m"))) === "deep" && y > 1000, `marker=${await fixture.textContent("#deep-m")} scrollY=${y}`);
      return `scrollY ${y}`;
    });

    await check("H1 nav back to the main fixture", async () => {
      const out = await run({ op: "nav", url: `${TOP}/main` });
      assert(out.status === "done", JSON.stringify(out.result));
    });

    await check("detach removes the debugger", async () => {
      const before = await harness.evaluate((t) => window.__zavi.rawProbe(t), tabId);
      assert(before === "attached", `probe before detach: ${before}`);
      await harness.evaluate((t) => window.__zavi.detach(t), tabId);
      const after = await harness.evaluate((t) => window.__zavi.rawProbe(t), tabId);
      assert(/not attached/i.test(after), `probe after detach: ${after}`);
      const st = await harness.evaluate((t) => window.__zavi.isAttached(t), tabId);
      assert(st === false, "OwnTabCdp still thinks it is attached");
      return after;
    });

    await check("onDetach fires when the tab closes (Chrome-side detach)", async () => {
      const r = await harness.evaluate((t) => window.__zavi.attach(t), tabId);
      assert(r.ok, `re-attach failed: ${r.error}`);
      await fixture.close();
      const ev = await poll(async () => {
        const evs = await harness.evaluate(() => window.__zavi.detachEvents());
        return evs.find((e) => e.tabId === tabId && !e.sessionId);
      });
      assert(ev, "no onDetach event for the tab");
      const st = await harness.evaluate((t) => window.__zavi.isAttached(t), tabId);
      assert(st === false, "OwnTabCdp still attached after onDetach");
      return `reason=${ev.reason}`;
    });
  } finally {
    if (context) await context.close().catch(() => undefined);
    for (const s of servers) s.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  const w = Math.max(...results.map((r) => r.name.length));
  console.log(`\nZavi extension e2e (${mode})\n${"-".repeat(w + 10)}`);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  ${r.detail}`);
  const failedN = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failedN}/${results.length} passed`);
  process.exitCode = failedN ? 1 : 0;
}

(process.argv.includes("--loop") ? import("./loop.mjs").then((m) => m.main()) : main()).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
