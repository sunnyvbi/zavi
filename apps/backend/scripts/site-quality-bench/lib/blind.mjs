import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { seededRng, shuffle } from "./rng.mjs";
import { stripPngMetadata } from "./png.mjs";
import { resolveShot } from "./io.mjs";
import { SCORE_AXES, VIEWPORTS, isEvidence } from "./schema.mjs";

const SIDES = ["A", "B"];
const PREFS = ["A", "B", "tie"];

function latest(entries) {
  return [...entries].sort((a, b) => String(b.record.captured_at).localeCompare(String(a.record.captured_at)) || a.file.localeCompare(b.file))[0];
}

export function planBlindPack(entries, { seed, systems = ["zavi", "lovable"], allowNonEvidence = false } = {}) {
  if (seed === undefined || seed === null || seed === "") throw new Error("planBlindPack needs a seed");
  if (systems.length !== 2 || systems[0] === systems[1]) throw new Error("blind pack compares exactly two different systems");
  const usable = entries.filter(
    (e) => systems.includes(e.record.system) && e.record.screenshots?.desktop && e.record.screenshots?.mobile && (allowNonEvidence || isEvidence(e.record)),
  );
  const briefIds = [...new Set(usable.map((e) => e.record.brief_id))].sort();
  const skipped = [];
  const pairs = [];
  for (const briefId of briefIds) {
    const picks = systems.map((s) => usable.filter((e) => e.record.brief_id === briefId && e.record.system === s));
    const missing = systems.filter((_, i) => picks[i].length === 0);
    if (missing.length) {
      skipped.push({ brief_id: briefId, reason: `no ${allowNonEvidence ? "" : "evidence "}record with both screenshots for ${missing.join(", ")}` });
      continue;
    }
    pairs.push({ brief_id: briefId, entries: picks.map(latest) });
  }
  const rng = seededRng(seed);
  const ordered = shuffle(pairs, rng);
  const items = ordered.map((p, i) => {
    const flip = rng() < 0.5;
    const [a, b] = flip ? [p.entries[1], p.entries[0]] : p.entries;
    return { item_id: `item-${String(i + 1).padStart(2, "0")}`, brief_id: p.brief_id, A: a, B: b };
  });
  return { items, skipped };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function axisLabel(axis) {
  return axis.replace(/_/g, " ");
}

export function renderRatingSheet({ packId, items, briefsById, containsNonEvidence }) {
  const banner = containsNonEvidence
    ? `<p class="warn">This pack contains mocked or hand-written placeholder outputs. Ratings from it are practice only, not evidence.</p>`
    : "";
  const blocks = items
    .map((it) => {
      const brief = briefsById[it.brief_id];
      const viewports = Object.keys(VIEWPORTS)
        .map((vp) => {
          const sides = SIDES.map((side) => {
            const radios = SCORE_AXES.map(
              (axis) =>
                `<div class="axis"><span>${esc(axisLabel(axis))}</span>${[1, 2, 3, 4, 5]
                  .map((n) => `<label><input type="radio" name="${it.item_id}|${vp}|${side}|${axis}" value="${n}">${n}</label>`)
                  .join("")}</div>`,
            ).join("");
            return `<div class="side"><h4>${side}</h4><a href="images/${it.item_id}-${side}-${vp}.png" target="_blank"><img src="images/${it.item_id}-${side}-${vp}.png" alt="Output ${side}, ${vp}"></a>${radios}</div>`;
          }).join("");
          const pref = PREFS.map(
            (p) => `<label><input type="radio" name="${it.item_id}|${vp}|preference" value="${p}">${p === "tie" ? "Tie" : p}</label>`,
          ).join("");
          return `<section class="vp" data-item="${it.item_id}" data-vp="${vp}"><h3>${vp} (${VIEWPORTS[vp].width}px)</h3><div class="pair">${sides}</div><div class="pref"><span>Which would you rather ship?</span>${pref}</div></section>`;
        })
        .join("");
      return `<article><h2>${esc(it.item_id)}: ${esc(brief?.title ?? "")}</h2><p class="brief">${esc(brief?.prompt ?? "")}</p>${viewports}</article>`;
    })
    .join("");
  const script = `
const PACK_ID=${JSON.stringify(packId)};
const AXES=${JSON.stringify(SCORE_AXES)};
function collect(){
  const rater=document.getElementById("rater").value.trim();
  if(!rater){alert("Enter your rater id first.");return null;}
  const out=[];
  document.querySelectorAll("section.vp").forEach(sec=>{
    const item=sec.dataset.item, vp=sec.dataset.vp;
    const pick=n=>{const el=document.querySelector('input[name="'+n+'"]:checked');return el?el.value:null;};
    const side=s=>{const o={};AXES.forEach(a=>{const v=pick(item+"|"+vp+"|"+s+"|"+a);o[a]=v===null?null:Number(v);});return o;};
    out.push({item_id:item,viewport:vp,A:side("A"),B:side("B"),preference:pick(item+"|"+vp+"|preference")});
  });
  return {pack_id:PACK_ID,rater:rater,rated_at:new Date().toISOString(),ratings:out};
}
document.getElementById("save").addEventListener("click",()=>{
  const doc=collect(); if(!doc) return;
  const blob=new Blob([JSON.stringify(doc,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download="ratings-"+doc.rater.replace(/[^a-z0-9_-]/gi,"_")+".json"; a.click();
});`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blind rating sheet</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#6b6b66;--line:#deded8;--warn:#8a4b00}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1400px;margin:0 auto}
article{border-top:2px solid var(--fg);padding:16px 0 32px}
.brief{color:var(--muted);max-width:80ch}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.side img{width:100%;max-height:640px;object-fit:cover;object-position:top;border:1px solid var(--line);background:#fff}
section.vp[data-vp=mobile] .side img{max-width:260px}
.axis{display:flex;gap:8px;align-items:center;font-size:13px}
.axis span{width:150px;text-transform:capitalize}
.pref{margin-top:12px;display:flex;gap:12px;font-weight:600}
.warn{color:var(--warn);font-weight:600}
header{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
@media (max-width:700px){.pair{grid-template-columns:1fr}}
</style></head>
<body><main>
<header><h1>Blind rating sheet</h1><label>Rater id <input id="rater" autocomplete="off"></label><button id="save" type="button">Download ratings JSON</button></header>
<p>Each brief shows two outputs, A and B, at desktop and mobile width. Rate each axis 1 (poor) to 5 (excellent), then pick which you would rather ship. Leave an axis empty if you cannot judge it. Send the downloaded JSON back to the person running the benchmark.</p>
${banner}
${blocks}
</main><script>${script}</script></body></html>
`;
}

function sideKey(entry) {
  return { run_id: entry.record.run_id, system: entry.record.system, provenance: entry.record.provenance, record_file: entry.file };
}

export function assertKeyOutside(outDir, keyPath) {
  const o = resolve(outDir);
  const k = resolve(keyPath);
  if (k === o || k.startsWith(o + sep)) throw new Error("the key file must live outside the rater pack directory");
}

export function writeBlindPack({ entries, briefs, outDir, keyPath, seed = null, systems, allowNonEvidence = false, packId = null, now = new Date() }) {
  if (!keyPath) throw new Error("blind-pack needs a key path (--key)");
  assertKeyOutside(outDir, keyPath);
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`output directory ${outDir} is not empty`);
  const effectiveSeed = seed ?? randomBytes(16).toString("hex");
  const { items, skipped } = planBlindPack(entries, { seed: effectiveSeed, systems, allowNonEvidence });
  if (items.length === 0) {
    const hint = allowNonEvidence ? "" : " (only actual_ai_build and manual_import records count; pass --allow-mocked for a practice pack)";
    throw new Error(`no brief has a record for both ${systems?.join(" and ") ?? "systems"}${hint}; nothing to pack`);
  }
  const id = packId ?? randomBytes(8).toString("hex");
  const imgDir = join(outDir, "images");
  mkdirSync(imgDir, { recursive: true });
  for (const it of items) {
    for (const side of SIDES) {
      for (const vp of Object.keys(VIEWPORTS)) {
        const src = resolveShot(it[side], vp);
        writeFileSync(join(imgDir, `${it.item_id}-${side}-${vp}.png`), stripPngMetadata(readFileSync(src)));
      }
    }
  }
  const briefsById = Object.fromEntries(briefs.map((b) => [b.id, b]));
  const containsNonEvidence = items.some((it) => !isEvidence(it.A.record) || !isEvidence(it.B.record));
  writeFileSync(join(outDir, "rate.html"), renderRatingSheet({ packId: id, items, briefsById, containsNonEvidence }));
  const key = {
    kind: "site-quality-bench/blind-key",
    pack_id: id,
    seed: effectiveSeed,
    systems,
    created_at: now.toISOString(),
    contains_non_evidence: containsNonEvidence,
    items: items.map((it) => ({ item_id: it.item_id, brief_id: it.brief_id, A: sideKey(it.A), B: sideKey(it.B) })),
    skipped,
  };
  mkdirSync(dirname(resolve(keyPath)), { recursive: true });
  writeFileSync(keyPath, JSON.stringify(key, null, 2));
  return { key, items, skipped, digest: createHash("sha256").update(JSON.stringify(key.items)).digest("hex") };
}

function checkAxes(obj, where, errors) {
  const out = {};
  for (const axis of SCORE_AXES) {
    const v = obj?.[axis];
    if (v === null || v === undefined) out[axis] = null;
    else if (Number.isInteger(v) && v >= 1 && v <= 5) out[axis] = v;
    else {
      errors.push(`${where}.${axis} must be 1-5 or null`);
      out[axis] = null;
    }
  }
  return out;
}

export function unblind(key, ratingDocs) {
  if (key?.kind !== "site-quality-bench/blind-key") throw new Error("not a blind key file");
  const itemsById = Object.fromEntries(key.items.map((i) => [i.item_id, i]));
  const errors = [];
  const rows = [];
  const seen = new Set();
  ratingDocs.forEach((doc, d) => {
    const where = `ratings[${d}]`;
    if (doc?.pack_id !== key.pack_id) {
      errors.push(`${where}: pack_id ${doc?.pack_id} does not match key ${key.pack_id}`);
      return;
    }
    if (typeof doc.rater !== "string" || !doc.rater.trim()) {
      errors.push(`${where}: rater is required`);
      return;
    }
    (doc.ratings || []).forEach((r, i) => {
      const at = `${where}.ratings[${i}]`;
      const item = itemsById[r?.item_id];
      if (!item) return errors.push(`${at}: unknown item_id ${r?.item_id}`);
      if (!VIEWPORTS[r.viewport]) return errors.push(`${at}: unknown viewport ${r.viewport}`);
      const dup = `${doc.rater}|${r.item_id}|${r.viewport}`;
      if (seen.has(dup)) return errors.push(`${at}: duplicate rating for ${dup}`);
      seen.add(dup);
      if (r.preference != null && !PREFS.includes(r.preference)) errors.push(`${at}.preference must be A, B, tie or null`);
      const pref = PREFS.includes(r.preference) ? r.preference : null;
      for (const side of SIDES) {
        const other = side === "A" ? "B" : "A";
        const scores = checkAxes(r[side], `${at}.${side}`, errors);
        rows.push({
          rater: doc.rater,
          item_id: item.item_id,
          brief_id: item.brief_id,
          viewport: r.viewport,
          side,
          run_id: item[side].run_id,
          system: item[side].system,
          provenance: item[side].provenance,
          opponent_run_id: item[other].run_id,
          opponent_system: item[other].system,
          opponent_provenance: item[other].provenance,
          scores: { rater: doc.rater, ...scores },
          outcome: pref === null ? null : pref === "tie" ? "tie" : pref === side ? "win" : "loss",
        });
      }
    });
  });
  return { rows, errors };
}
