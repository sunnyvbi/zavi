
import type { RenderDocInput, DocSection } from "./doc-schema";
import { DEFAULT_DOC_THEME, type DocTheme } from "./brand-theme";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mdToHtml(md: string): string {
  const blocks = md.split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return "";
      const inline = (t: string) =>
        esc(t)
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(/`(.+?)`/g, "<code>$1</code>");
      if (lines.every((l) => /^[-*+]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${inline(l.replace(/^[-*+]\s+/, ""))}</li>`).join("");
        return `<ul>${items}</ul>`;
      }
      return `<p>${lines.map(inline).join(" ")}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

function renderSteps(steps: NonNullable<DocSection["steps"]>): string {
  const items = steps
    .map(
      (s) => `<li>
      <div class="step-h">${esc(s.title)}</div>
      ${s.body ? `<p class="step-b">${esc(s.body)}</p>` : ""}
      ${s.meta ? `<p class="step-meta">${esc(s.meta)}</p>` : ""}
    </li>`,
    )
    .join("");
  return `<ol class="pipeline">${items}</ol>`;
}

function renderLedger(rows: NonNullable<DocSection["ledger"]>): string {
  const body = rows
    .map((r) => {
      const cls = ["row", r.emphasis === "total" ? "total" : ""].filter(Boolean).join(" ");
      const vcls = ["v", r.emphasis === "positive" ? "pay" : r.emphasis === "negative" ? "cut" : ""]
        .filter(Boolean)
        .join(" ");
      return `<div class="${cls}">
        <div class="k">${esc(r.label)}${r.note ? `<small>${esc(r.note)}</small>` : ""}</div>
        <div class="${vcls}">${esc(r.value)}</div>
      </div>`;
    })
    .join("");
  return `<div class="ledger">${body}</div>`;
}

function renderTable(t: NonNullable<DocSection["table"]>): string {
  const head = t.columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const rows = t.rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="twrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderSection(s: DocSection, i: number): string {
  return `<section>
    <h2>${String(i + 1).padStart(2, "0")}</h2>
    <h3>${esc(s.heading)}</h3>
    ${s.callout ? `<div class="callout ${esc(s.callout.tone)}"><p>${esc(s.callout.body)}</p></div>` : ""}
    ${s.body_markdown ? mdToHtml(s.body_markdown) : ""}
    ${s.steps ? renderSteps(s.steps) : ""}
    ${s.ledger ? renderLedger(s.ledger) : ""}
    ${s.table ? renderTable(s.table) : ""}
  </section>`;
}

const STYLE = `
:root{--blue:#027BFF;--blue-soft:#EAF3FF;--blue-line:#B9D9FF;--ink:#1F1F1F;--ink-2:#414652;--hint:#626F86;--rule:#E6E9EF;--ground:#FBFCFD;--panel:#FFF;--panel-2:#F4F6F9;--ok:#167F50;--ok-soft:#EFF7F3;--warn:#946300;--warn-soft:#FFF8EA;--warn-line:#F0DCB4;--money:#008605;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--blue:#62AEFF;--blue-soft:#10243B;--blue-line:#244C79;--ink:#EDEFF3;--ink-2:#C0C6D2;--hint:#8E99AB;--rule:#262B34;--ground:#0E1116;--panel:#161A21;--panel-2:#1D222B;--ok:#5CC89A;--ok-soft:#10231B;--warn:#E0B15C;--warn-soft:#241D0F;--warn-line:#4A3A18;--money:#5FC06A}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:780px;margin:0 auto;padding-inline:20px;padding-block:48px 72px}
.eyebrow{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--hint);margin:0 0 14px}
h1{font-size:clamp(28px,6vw,42px);line-height:1.1;letter-spacing:-.025em;font-weight:800;margin:0 0 14px;text-wrap:balance}
.standfirst{font-size:18px;color:var(--ink-2);margin:0 0 36px;max-width:62ch}
section{margin-bottom:48px}
h2{font-size:12px;font-family:var(--mono);font-weight:600;letter-spacing:.1em;color:var(--blue);margin:0 0 6px;padding-bottom:10px;border-bottom:1px solid var(--rule)}
h3{font-size:23px;letter-spacing:-.015em;font-weight:700;margin:16px 0 12px;text-wrap:balance}
p{margin:0 0 14px;max-width:68ch}
ul{margin:0 0 14px;padding-left:20px;max-width:68ch}
li{margin-bottom:6px}
code{font-family:var(--mono);font-size:.86em;background:var(--panel-2);border:1px solid var(--rule);border-radius:4px;padding:1px 5px;word-break:break-word}
ol.pipeline{list-style:none;margin:20px 0 0;padding:0;counter-reset:step}
ol.pipeline>li{counter-increment:step;display:grid;grid-template-columns:34px 1fr;gap:16px;padding:16px 0;border-top:1px solid var(--rule)}
ol.pipeline>li:last-child{border-bottom:1px solid var(--rule)}
ol.pipeline>li::before{content:counter(step);font-family:var(--mono);font-size:13px;font-weight:600;color:var(--blue);background:var(--blue-soft);border:1px solid var(--blue-line);border-radius:6px;width:30px;height:30px;display:grid;place-items:center;margin-top:2px}
.step-h{font-weight:700;font-size:16.5px;margin:2px 0 4px}
.step-b{margin:0;font-size:15px;color:var(--ink-2)}
.step-meta{margin:8px 0 0;font-family:var(--mono);font-size:12px;color:var(--hint);line-height:1.7;word-break:break-word}
.ledger{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:4px 20px 12px;margin:20px 0 0}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:11px 0;border-bottom:1px solid var(--rule);font-size:15px}
.row:last-child{border-bottom:none}
.row .k{color:var(--ink-2)}
.row .k small{display:block;color:var(--hint);font-size:12.5px}
.row .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap}
.row.total{padding-top:14px}.row.total .k{font-weight:700;color:var(--ink)}.row.total .v{font-weight:600}
.v.pay{color:var(--money)}.v.cut{color:var(--warn)}
.callout{border-radius:10px;padding:14px 16px;margin:0 0 18px;border:1px solid var(--rule);background:var(--panel-2)}
.callout p{margin:0;font-size:14.5px;color:var(--ink-2)}
.callout.warn{background:var(--warn-soft);border-color:var(--warn-line)}
.callout.success{background:var(--ok-soft)}
.callout.info{background:var(--blue-soft);border-color:var(--blue-line)}
.twrap{overflow-x:auto;margin:0 0 16px}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--hint);font-weight:600}
img{max-width:100%}
.foot{margin-top:48px;padding-top:18px;border-top:1px solid var(--rule);font-size:13px;color:var(--hint)}
`;

function brandOverride(theme: DocTheme): string {
  if (
    theme.blue === DEFAULT_DOC_THEME.blue &&
    theme.blueSoft === DEFAULT_DOC_THEME.blueSoft &&
    theme.blueLine === DEFAULT_DOC_THEME.blueLine &&
    theme.blueDark === DEFAULT_DOC_THEME.blueDark &&
    theme.blueSoftDark === DEFAULT_DOC_THEME.blueSoftDark &&
    theme.blueLineDark === DEFAULT_DOC_THEME.blueLineDark
  ) {
    return "";
  }
  return `
:root{--blue:${theme.blue};--blue-soft:${theme.blueSoft};--blue-line:${theme.blueLine}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--blue:${theme.blueDark};--blue-soft:${theme.blueSoftDark};--blue-line:${theme.blueLineDark}}}`;
}

export function renderDocHtml(
  input: RenderDocInput,
  footer?: string,
  theme: DocTheme = DEFAULT_DOC_THEME,
): string {
  const sections = input.sections.map(renderSection).join("\n");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${esc(input.title)}</title>
<style>${STYLE}${brandOverride(theme)}</style>
</head><body><div class="wrap">
${input.eyebrow ? `<p class="eyebrow">${esc(input.eyebrow)}</p>` : ""}
<h1>${esc(input.title)}</h1>
${input.subtitle ? `<p class="standfirst">${esc(input.subtitle)}</p>` : ""}
${sections}
${footer ? `<p class="foot">${esc(footer)}</p>` : ""}
</div></body></html>`;
}
