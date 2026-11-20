
import { createHash } from "node:crypto";
import { buildReport, parseSources, type ReportModel, type UiBlock } from "@zavi/shared";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function stripLinks(md: string): string {
  return md
    .replace(
      /\[([^\]\n]*)\]\(\s*(<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"\n]*")?\s*\)/g,
      (_, label: string, url: string) => (/^<?https?:\/\//i.test(url) ? label : ""),
    )
    .replace(/\s*\(call \d+\)/gi, "")
    .replace(UUID, "")
    .replace(/[ \t]+([.,;])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}

function isFounderLine(line: string): boolean {
  const t = line.replace(/^\s*(?:[-*]\s+)?(?:\*\*)?/, "");
  if (/^(?:recommended next (?:action|step)s?|next action)\s*(?:\*\*)?\s*:/i.test(t)) return true;
  return /(?:^|[\s(:])(?:reply|say|answer|type)\b[^.\n]{0,60}?\band I(?:'|\u2019)?(?:ll| will)\b/i.test(t) &&
    !/["\u201c](?:reply|say|answer|type)\b/i.test(t);
}

export function publicSummary(md: string): string {
  const lines = stripLinks(md)
    .split("\n")
    .filter((l) => !isFounderLine(l));
  const text = lines.join("\n").trim().replace(/^((?:\*\*)?\s*)(?:yes|no)[.!,]\s+(?=[*_"\u201c]*[A-Za-z])/i, "$1");
  return text.replace(/\n{3,}/g, "\n\n");
}

const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const isRow = (l: string) => /(?<!\\)\|/.test(l);

function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

function table(lines: string[]): string {
  const head = cells(lines[0]);
  const body = lines.slice(2).map(cells);
  const fit = (r: string[]) => head.map((_, j) => r[j] ?? "");
  return (
    `<div class="tw"><table class="md"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
    `<tbody>${body.map((r) => `<tr>${fit(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
  );
}

export function miniMarkdown(md: string): string {
  const lines = md.trim().split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
    para = [];
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) {
      flush();
    } else if (
      isRow(l) &&
      i + 1 < lines.length &&
      TABLE_SEP.test(lines[i + 1]) &&
      cells(lines[i + 1]).length === cells(l).length
    ) {
      flush();
      const rows = [l, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() && isRow(lines[i])) rows.push(lines[i++]);
      i--;
      out.push(table(rows));
    } else if (/^\s*[-*]\s+/.test(l)) {
      if (para.length) {
        out.push(`<p>${para.map(inline).join("<br>")}</p>`);
        para = [];
      }
      list.push(l.replace(/^\s*[-*]\s+/, ""));
    } else {
      if (list.length) {
        out.push(`<ul>${list.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
        list = [];
      }
      para.push(l);
    }
  }
  flush();
  return out.join("\n");
}

export function plainText(md: string, max = 150): string {
  const t = md
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, " ")
    .replace(/^\s*[#>]+\s*/gm, "")
    .replace(/[*`|]+/g, " ")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}\u2026`;
}

export function groupThousands(cell: string): string {
  return /^-?\d{4,}$/.test(cell.trim()) ? Number(cell.trim()).toLocaleString("en-US") : cell;
}

const num = (s: string) => Number(s.replace(/,/g, ""));
const norm = (s: string) => s.toLowerCase().replace(/\*+/g, "").replace(/[-_\u2013\u2014]/g, " ").replace(/\s+/g, " ");

export function textContradicts(model: ReportModel, summary: string): boolean {
  const text = norm(summary);
  const counts = model.measures.filter((m) => m.kind === "count");
  if (!counts.length) return false;
  return model.labels.some((raw, j) => {
    const label = norm(raw.replace(/\*+$/, "")).trim();
    if (label.length < 4) return false;
    const row = counts.map((m) => m.values[j]).filter((v): v is number => v !== null);
    if (!row.length) return false;
    const ok = new Set([...row, row.reduce((a, b) => a + b, 0)]);
    let at = text.indexOf(label);
    while (at >= 0) {
      const end = at + label.length;
      const whole = !/[a-z0-9]/.test(text[at - 1] ?? "") && !/[a-z0-9]/.test(text[end] ?? "");
      const after = whole ? text.slice(end, end + 40).split(/\.\s/)[0] : "";
      const m = after.match(
        /^[^\d$]*?(\$)?(\d[\d,]*(?:\.\d+)?)(\s*%|\s*[km]\b|\s*x\b|\s+(?:days?|weeks?|months?|years?|hours?|minutes?|pts?|points?)\b)?/,
      );
      if (m && !m[1] && !m[3] && !m[2].includes(".")) {
        const n = num(m[2]);
        if (!(n >= 1900 && n <= 2100 && !m[2].includes(",")) && !ok.has(n)) return true;
      }
      at = text.indexOf(label, end);
    }
    return false;
  });
}

export function chartFromCode(model: ReportModel, pulled: string[]): boolean {
  const lines = pulled.map((l) => {
    const [src, rest = ""] = l.split(/\breturned\b/);
    return { code: /\b(code search|a file in your repo|github)\b/i.test(src), nums: (rest.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(num) };
  });
  if (!lines.some((l) => l.code)) return false;
  return model.measures.some((m) =>
    m.values.some(
      (v) =>
        v !== null &&
        v >= 10 &&
        lines.some((l) => l.code && l.nums.includes(v)) &&
        !lines.some((l) => !l.code && l.nums.includes(v)),
    ),
  );
}

const STEP_WORDS = /\b(step|steps|funnel)\b/i;

function isSteps(model: ReportModel, block: UiBlock): boolean {
  if (block.kind === "chart" && block.variant === "funnel") return true;
  return STEP_WORDS.test(model.dimension ?? "") || STEP_WORDS.test(model.title);
}

export function nonMonotonic(model: ReportModel): boolean {
  return model.measures.some((m) =>
    m.values.some((v, j) => v !== null && m.values.slice(0, j).some((p) => p !== null && v > p)),
  );
}

export function mixedWindows(text: string): boolean {
  const MON = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
  const re = new RegExp(
    `\\b(?:last|past) \\d+ (?:days?|weeks?|months?)\\b|\\b\\d+ (?:days|weeks)\\b|\\b${MON} \\d{1,2}\\s*(?:to|-|\\u2013|through)\\s*(?:${MON} )?\\d{1,2}\\b|\\bsince ${MON} \\d{1,2}\\b`,
    "gi",
  );
  const found = new Set(
    (text.match(re) ?? []).map((s) => s.toLowerCase().replace(/\s+/g, " ").replace(/^past /, "last ").replace(/\s*(?:-|\u2013|through)\s*/, " to ")),
  );
  return found.size >= 2;
}

function bars(model: ReportModel, i: number, twoLine: boolean): string {
  const m = model.measures[i];
  const formula = model.kpis.some((k) => k.name === m.name) ? undefined : m.formula;
  const W = 220;
  const H = 120;
  const top = 18;
  const base = H - 18;
  const vals = m.values.map((v) => (v === null ? null : Math.max(0, v)));
  const max = Math.max(1, ...vals.map((v) => v ?? 0));
  const slot = W / Math.max(1, vals.length);
  const bw = Math.min(24, slot * 0.6);
  const parts = vals.map((v, j) => {
    const x = slot * j + (slot - bw) / 2;
    const label = esc(model.labels[j].replace(/\*+$/, "").slice(0, 8));
    const tick = `<text x="${x + bw / 2}" y="${H - 4}" text-anchor="middle" class="tick">${label}</text>`;
    if (v === null) return tick;
    const h = ((base - top) * v) / max;
    const y = base - h;
    return (
      `<path d="M${x},${base} V${y + 4} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${base} Z" fill="#3b82f6"/>` +
      `<text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" class="val">${esc(groupThousands(m.display[j]))}</text>` +
      tick
    );
  });
  const name = m.name === model.title ? "" : m.name;
  return (
    `<figure><figcaption${twoLine ? ' class="two"' : ""}>${esc(name)}${formula ? `<span class="f">= ${esc(formula)}</span>` : ""}</figcaption>` +
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.name)}">` +
    `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="#e5e2dc"/>${parts.join("")}</svg></figure>`
  );
}

export function reportMarker(artifactId: string): string {
  const tag = createHash("sha256").update(`zavi-report:${artifactId.toLowerCase()}`).digest("hex").slice(0, 32);
  return `<!--zavi-report:v2:${tag}-->`;
}

const STEP_NOTE =
  "Counts aren't a strict sequence. Each step counts people who did it at least once, so a later step can be larger than an earlier one.";
const WINDOW_NOTE = "Some numbers in the text cover different date ranges from this table.";
const CONFLICT_NOTE = "The chart is left out because some of these numbers don't match the text. Check them before relying on them.";

const MAX_PAGE_TITLE = 120;

export function renderReportPage(input: {
  block: UiBlock;
  summary: string;
  sources: string | null;
  createdAt: string;
  artifactId: string;
  company?: string | null;
}): { title: string; html: string } | null {
  const built = buildReport(input.block);
  if (!built) return null;
  const model = { ...built, title: built.title.slice(0, MAX_PAGE_TITLE).trim() || "Report" };
  const parsed = parseSources(input.sources ? stripLinks(input.sources) : null);
  const src = parsed && { ...parsed, pulled: parsed.pulled.filter((l) => l.trim()) };
  const summary = publicSummary(input.summary);
  const company = (input.company ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const contradiction = textContradicts(model, summary) || (src ? chartFromCode(model, src.pulled) : false);
  const steps = isSteps(model, input.block);
  const notes = [
    model.note,
    steps && nonMonotonic(model) && !/strict sequence/i.test(summary) ? STEP_NOTE : null,
    steps && mixedWindows(summary) ? WINDOW_NOTE : null,
    contradiction ? CONFLICT_NOTE : null,
  ].filter((n): n is string => !!n);
  const when = new Date(input.createdAt);
  const date = Number.isNaN(when.getTime())
    ? ""
    : when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const isMeasure = (j: number) => model.measures.some((m) => m.name === model.columns[j]);

  const kpis = model.kpis.length
    ? `<section class="kpis">${
        model.kpis[0].period
          ? `<p class="cap">${esc(model.kpis[0].period)}${model.kpis[0].previous ? `, compared with ${esc(model.kpis[0].previous)}` : ""}</p>`
          : ""
      }<div class="kgrid">${model.kpis
        .map((k) => {
          const formula = model.measures.find((m) => m.name === k.name)?.formula;
          const arrow = k.direction === "up" ? "▲ " : k.direction === "down" ? "▼ " : "";
          return `<div class="kpi"><div class="kl">${esc(k.name)}</div><div class="kv">${esc(k.value)}</div>${
            k.change ? `<div class="kc">${arrow}${esc(k.change)}</div>` : ""
          }${formula ? `<div class="kf">${esc(formula)}</div>` : ""}</div>`;
        })
        .join("")}</div></section>`
    : "";

  const charts =
    model.measures.length > 0 && model.labels.length > 1 && !contradiction
      ? `<section><h2>${esc(model.dimension ? `By ${model.dimension.toLowerCase()}` : "Breakdown")}</h2><div class="charts">${model.measures
          .slice(0, 4)
          .map((_, i, all) =>
            bars(
              model,
              i,
              all.some((x) => x.formula && !model.kpis.some((k) => k.name === x.name)),
            ),
          )
          .join("")}</div></section>`
      : "";

  const head = (c: string, j: number) =>
    c === model.title ? (model.measures.find((m) => m.name === c)?.kind === "percent" ? "Share" : isMeasure(j) ? "Count" : "") : c;
  const table = `<section><h2>Data</h2><table><thead><tr>${model.columns
    .map((c, j) => `<th class="${isMeasure(j) ? "r" : ""}">${esc(head(c, j))}</th>`)
    .join("")}</tr></thead><tbody>${model.rows
    .map((r) => `<tr>${r.map((c, j) => `<td class="${isMeasure(j) ? "r" : ""}">${esc((isMeasure(j) ? groupThousands(c) : c) || "—")}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>${notes.map((n) => `<p class="note${n === CONFLICT_NOTE ? " warn" : ""}">${esc(n)}</p>`).join("")}</section>`;

  const sources = src
    ? `<section class="src"><h2>Where these numbers came from</h2><p>${esc(src.summary)}</p><dl>${
        src.pulled.length ? `<dt>Pulled from the data</dt><dd>${src.pulled.map(esc).join("<br>")}</dd>` : ""
      }${src.checked.length ? `<dt>Checks out as arithmetic</dt><dd>${src.checked.map(esc).join("<br>")}</dd>` : ""}${
        src.missing ? `<dt class="warn">Not in this run's data</dt><dd class="warn">${esc(src.missing.replace(/^Not in this run's data:\s*/, ""))}</dd>` : ""
      }</dl></section>`
    : "";

  const html = `<!doctype html>${/^[0-9a-f-]{36}$/i.test(input.artifactId) ? reportMarker(input.artifactId) : ""}<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.title)}</title>
<meta name="description" content="${esc(plainText(summary) || model.title)}">
<style>
body{margin:0;background:#f7f5f0;color:#1f1f1f;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
article{max-width:760px;margin:32px auto;background:#fff;border-radius:12px;padding:40px 44px;box-shadow:0 1px 2px rgba(16,18,20,.06),0 8px 28px rgba(16,18,20,.06)}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#6b6b6b;margin:0}
h1{font:600 30px/1.2 Georgia,"Source Serif 4",serif;margin:8px 0 0;letter-spacing:-.01em}
.rule{width:48px;height:1px;background:#1f1f1f;margin:16px 0}
.summary{font:16px/1.7 Georgia,"Source Serif 4",serif;color:#333}
h2{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b6b6b;margin:36px 0 12px}
.kpis{border-top:1px solid #ebe8e2;border-bottom:1px solid #ebe8e2;padding:16px 0 20px;margin-top:28px}
.cap{font-size:12px;color:#6b6b6b;margin:0 0 12px}
.kgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}
.kpi{border-left:1px solid #ebe8e2;padding:0 16px}.kpi:first-child{border-left:0;padding-left:0}
.kl{font-size:12px;color:#6b6b6b}.kv{font:600 30px/1 Georgia,serif;margin-top:6px}.kc,.kf{font-size:12px;color:#6b6b6b;margin-top:8px}.kf{margin-top:2px;color:#9a9a9a}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:24px}
figure{margin:0}figcaption{font-size:13px;font-weight:600;margin-bottom:6px}figcaption.two{min-height:36px}figcaption .f{display:block;font-size:11px;font-weight:400;color:#6b6b6b}svg{width:100%;height:auto}
.val{font-size:10px;fill:#1f1f1f}.tick{font-size:10px;fill:#6b6b6b}
table{width:100%;border-collapse:collapse;font-size:13px}th{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b6b6b;text-align:left;padding:8px 16px 8px 0;border-bottom:1px solid #d9d5ce}
td{padding:10px 16px 10px 0;border-bottom:1px solid #f0ede7}.r{text-align:right;font-variant-numeric:tabular-nums}th:last-child,td:last-child{padding-right:0}
.note{font-size:12px;color:#6b6b6b}.note.warn{color:#b45309}
.tw{overflow-x:auto;margin:12px 0}table.md{font-size:13px;line-height:1.45;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}table.md th{text-transform:none;letter-spacing:0;font-size:12px;color:#1f1f1f}table.md td{vertical-align:top;color:#333}
.src{border-top:1px solid #ebe8e2;margin-top:36px}.src p{font-size:13px;color:#444}
dl{display:grid;grid-template-columns:170px 1fr;gap:10px 16px;font-size:13px}dt{font-weight:600}dd{margin:0;color:#444}.warn{color:#b45309}
@media (max-width:640px){article{margin:0;border-radius:0;padding:28px 20px}dl{grid-template-columns:1fr}}
</style></head><body><article>
<p class="eyebrow">${company ? `Shared by ${esc(company)}` : "Analysis"}${src && src.pulled.length ? " · From the company's data" : ""}${date ? ` · ${esc(date)}` : ""}</p>
<h1>${esc(model.title)}</h1><div class="rule"></div>
<div class="summary">${miniMarkdown(summary)}</div>
${kpis}${charts}${table}${sources}
</article></body></html>`;
  return { title: model.title, html };
}
