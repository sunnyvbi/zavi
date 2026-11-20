import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const DIR = process.env.VERDICT_REPLAY_DIR ?? ".verdict-replay";
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

const lanes = String(arg("lanes", "")).split(",").filter(Boolean);
const names = String(arg("names", "")).split(",").filter(Boolean);
if (!lanes.length) throw new Error("--lanes L1,L2,L3 required");

const byLane = new Map();
for (const l of lanes) {
  const f = readdirSync(DIR).find((x) => x === `cards-${l}.jsonl`);
  if (!f) throw new Error(`missing cards-${l}.jsonl in ${DIR}`);
  byLane.set(l, readFileSync(`${DIR}/${f}`, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
}
const runIds = [...new Set(byLane.get(lanes[0]).map((r) => r.run_id))]
  .filter((id) => lanes.every((l) => byLane.get(l).some((r) => r.run_id === id)));

const company = (row) => {
  const m = row.evidence_company ?? null;
  return m ?? `run ${String(row.run_id).slice(0, 8)}`;
};

const cardHtml = (c, i) => `
  <div class="card">
    <div class="ch"><span class="n">${i + 1}</span>${esc(c.headline)}</div>
    <div class="why">${esc(c.rationale)}</div>
    ${(c.evidence ?? []).map((e) => `<div class="ev"><b>${esc(e.value)}</b> ${esc(e.caption)}</div>`).join("")}
    ${String(c.deliverable?.text ?? "").trim().length > 0
      ? `<div class="dl"><div class="dlh">paste this${c.deliverable?.kind && c.deliverable.kind !== "none" ? ` · ${esc(c.deliverable.kind)}` : ""}</div><pre>${esc(c.deliverable.text)}</pre></div>`
      : '<div class="manual">No text — this is a check the owner performs.</div>'}
    ${c.kind === "manual" ? '<div class="manual">Owner or developer does this.</div>' : ""}
  </div>`;

const tabs = runIds.map((id, ti) => {
  const cols = lanes.map((l, li) => {
    const row = byLane.get(l).find((r) => r.run_id === id);
    const cards = row?.cards ?? [];
    return `<div class="col${li === 0 ? " base" : ""}">
      <div class="colh">
        <div class="cn">${esc(names[li] ?? l)}</div>
        <div class="cm">${cards.length} action${cards.length === 1 ? "" : "s"}${row?.err ? " · <span class='err'>run errored</span>" : ""}</div>
      </div>
      ${cards.length ? cards.map(cardHtml).join("") : '<div class="none">No actions produced.</div>'}
    </div>`;
  }).join("");
  const tenant = byLane.get(lanes[0]).find((r) => r.run_id === id)?.tenant_id ?? null;
  return { id, ti, tenant, html: `<section class="tab" id="t${ti}" ${ti ? 'hidden' : ""}><div class="cols">${cols}</div></section>` };
});

const html = `<!doctype html><meta charset="utf-8"><title>Reddit recipe cook</title>
<style>
:root{--bg:#fff;--fg:#111;--mut:#666;--line:#e3e3e3;--base:#f6f8fb;--acc:#1a56db}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#101215;--fg:#e8e8e8;--mut:#9aa0a6;--line:#2a2e33;--base:#161a20;--acc:#7aa2f7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{max-width:1600px;margin:0 auto;padding:24px 16px 64px}
.top{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:18px;background:var(--base)}
.tabsbar{display:flex;gap:6px;flex-wrap:wrap;margin:18px 0 14px}
.tb{padding:7px 12px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--fg);cursor:pointer;font-size:13px}
.tb[aria-selected=true]{background:var(--acc);color:#fff;border-color:var(--acc)}
.cols{display:grid;grid-template-columns:repeat(${lanes.length},1fr);gap:14px}
@media(max-width:1100px){.cols{grid-template-columns:1fr 1fr}}
@media(max-width:700px){.cols{grid-template-columns:1fr}}
.col{border:1px solid var(--line);border-radius:10px;padding:12px;min-width:0}
.col.base{background:var(--base)}
.colh{border-bottom:1px solid var(--line);padding-bottom:9px;margin-bottom:11px}
.cn{font-weight:650}.cm{color:var(--mut);font-size:12.5px;margin-top:2px}
.err{color:#c0392b}
.card{border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:9px}
.ch{font-weight:600;margin-bottom:5px}.n{display:inline-block;min-width:18px;color:var(--mut)}
.why{color:var(--mut);font-size:13.5px}
.ev{margin-top:6px;font-size:12.5px}
.manual{margin-top:6px;font-size:12px;color:var(--mut);font-style:italic}
.none{color:var(--mut);font-style:italic;padding:10px}
.dl{margin-top:8px;border:1px solid var(--line);border-radius:6px;overflow:hidden}
.dlh{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);padding:5px 8px;border-bottom:1px solid var(--line)}
.dl pre{margin:0;padding:9px;white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
<div class="wrap">
<div class="top"><b>Pick a run, read the columns as that owner, and tell me which column you would rather get.</b><br>
<span style="color:var(--mut)">${runIds.length} runs across ${new Set(tabs.map((t) => t.tenant)).size} DISTINCT TENANTS. A run is not a business: the same tenant can appear more than once, so read the tenant count, not the tab count.</span><br>
<span style="color:var(--mut)">Same evidence in every column. Only the instructions and the model change. Ratings are deliberately not on this page.</span></div>
<div class="tabsbar" role="tablist">${tabs.map((t) => `<button class="tb" role="tab" aria-selected="${t.ti === 0}" data-t="${t.ti}">run ${esc(String(t.id).slice(0, 8))} · tenant ${esc(String(t.tenant ?? "?").slice(0, 8))}</button>`).join("")}</div>
${tabs.map((t) => t.html).join("")}
</div>
<script>
const bs=[...document.querySelectorAll('.tb')];
bs.forEach(b=>b.onclick=()=>{bs.forEach(x=>x.setAttribute('aria-selected',x===b));
document.querySelectorAll('.tab').forEach((s,i)=>s.hidden=(i!==+b.dataset.t));});
</script>`;
const out = arg("out", `${DIR}/cook-page.html`);
writeFileSync(out, html);
console.log(`page -> ${out}  (${runIds.length} runs / ${new Set(tabs.map((t) => t.tenant)).size} distinct tenants x ${lanes.length} columns)`);
