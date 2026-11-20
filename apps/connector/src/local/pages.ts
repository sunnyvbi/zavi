import { TOTALS_ONLY_LIMITATION_NOTE, isSensitiveColumn } from "@zavi/shared/db-guard";
import { html, attr, localHref, type SafeHtml } from "../html";
import { GENERATED_KEY_WARNING } from "../keys";
import { DIALECT_LABEL, maskConnection } from "../db";
import type { Introspection } from "../db/types";
import type { ActivityEntry, ActivityRow } from "../activity";
import { REVOKED_MESSAGE } from "../runtime";
import type { AppContext } from "./server";

export const BANNER = "This page runs on your machine. Your password is saved here and never sent to Zavi.";

export const STYLE = `
:root{color-scheme:light dark;--bg:#f4f4f5;--fg:#18181b;--muted:#52525b;--card:#fff;--line:#a1a1aa;--ok:#166534;--bad:#991b1b;--warn:#fef9c3}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--fg:#f4f4f5;--muted:#a1a1aa;--card:#27272a;--line:#52525b;--ok:#4ade80;--bad:#f87171;--warn:#422006}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header b{margin-right:8px}nav a{margin-right:12px;color:inherit}
.banner{background:var(--warn);padding:8px 16px;border-bottom:1px solid var(--line)}
main{max-width:1000px;margin:0 auto;padding:16px}
h1{font-size:17px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 6px}p{margin:4px 0}
.muted{color:var(--muted)}.ok{color:var(--ok);font-weight:bold}.bad{color:var(--bad);font-weight:bold}
.box{border:1px solid var(--line);background:var(--card);padding:10px 12px;margin:10px 0}
.box.ok{border-color:var(--ok)}.box.bad{border-color:var(--bad)}
label{display:block;margin:6px 0}input[type=text],input[type=password],input[type=number],select,textarea{font:inherit;padding:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);width:100%;max-width:560px}
input[type=number]{max-width:120px}textarea{min-height:80px}
button{font:inherit;padding:6px 14px;border:1px solid var(--fg);background:var(--fg);color:var(--bg);cursor:pointer}
button.secondary{background:transparent;color:var(--fg)}
fieldset{border:1px solid var(--line);margin:10px 0;padding:8px 12px}legend{font-weight:bold}
.check{display:flex;gap:8px;align-items:baseline;margin:3px 0}.check input{margin:0}
table{border-collapse:collapse;width:100%;background:var(--card)}th,td{border-top:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
td.q{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
pre{background:var(--card);border:1px solid var(--line);padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-all;max-height:70vh}
form.inline{display:inline}
`;

export type View = {
  machine: string;
  version: string;
  status: AppContext["runtime"]["status"];
  online: boolean;
  lastError: string | null;
  lastContactAt: number | null;
  pairNote: string | null;
  keySource: AppContext["keySource"];
  database: { dialect: keyof typeof DIALECT_LABEL; masked: string; transport: string | null } | null;
  rules: ReturnType<AppContext["rules"]["current"]>;
  rulesPath: string;
};

export function viewOf(ctx: AppContext): View {
  const cfg = ctx.db.config();
  return {
    machine: ctx.cfg.machine,
    version: ctx.cfg.version,
    status: ctx.runtime.status,
    online: ctx.runtime.online(),
    lastError: ctx.runtime.lastError,
    lastContactAt: ctx.runtime.lastContactAt,
    pairNote: ctx.runtime.pairNote,
    keySource: ctx.keySource,
    database: cfg ? { dialect: cfg.dialect, masked: maskConnection(cfg.connection_string), transport: ctx.db.driver()?.transport() ?? null } : null,
    rules: ctx.rules.current(),
    rulesPath: ctx.rules.path,
  };
}

const when = (iso: string | number) => new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

function layout(title: string, body: SafeHtml, csrf: string | null): SafeHtml {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin"><title>${title} · Zavi Connector</title><link rel="stylesheet" href="/style.css"></head>
<body><header><b>Zavi Connector</b>${
    csrf
      ? html`<nav><a href="/">Status</a><a href="/database">Database</a><a href="/rules">Rules</a><a href="/activity">Activity</a></nav>
<form class="inline" method="post" action="/logout"><input type="hidden" name="csrf" value="${attr(csrf)}"><button class="secondary" type="submit">Log out</button></form>`
      : ""
  }</header>
<div class="banner">${BANNER}</div>
<main>${body}</main></body></html>`;
}

export function errorPage(message: string): SafeHtml {
  return layout("Error", html`<p class="bad">${message}</p><p><a href="/">Back</a></p>`, null);
}

export function loginPage(error: string | null): SafeHtml {
  return layout(
    "Log in",
    html`<h1>Log in</h1>
<p class="muted">Paste the admin token. It was printed once in the connector's log: <code>docker logs zavi-connector</code>. Lost it? <code>docker exec zavi-connector node dist/main.js reset-admin-token</code></p>
${error ? html`<div class="box bad">${error}</div>` : ""}
<form method="post" action="/login"><label>Admin token<input type="password" name="token" autocomplete="off" required></label><button type="submit">Log in</button></form>`,
    null,
  );
}

const TRANSPORT_TEXT: Record<string, string> = {
  verified_tls: "Encrypted, certificate verified.",
  unverified_tls: "Encrypted, certificate not verified (add sslmode=verify-full or the database's own TLS options to verify it).",
  plaintext: "Not encrypted: the connection string turns encryption off, or the database is on this machine.",
};

function zaviLine(v: View): SafeHtml {
  switch (v.status.kind) {
    case "unpaired":
      return html`<p class="bad">Not paired.</p><p>Start the connector with the docker command from Zavi (Connectors &gt; Your database &gt; Keep data on your server). It carries a one-time pairing code.</p>`;
    case "pairing":
      return html`<p>Pairing with Zavi…</p>`;
    case "pair_failed":
      return html`<p class="bad">Pairing failed.</p><p>${v.status.message}</p>`;
    case "revoked":
      return html`<p class="bad">${REVOKED_MESSAGE}</p>`;
    case "stopped":
      return html`<p>Stopping.</p>`;
    default:
      return v.online
        ? html`<p class="ok">Paired · online</p>`
        : html`<p class="bad">Paired · not reaching Zavi right now</p><p class="muted">${v.lastContactAt ? `Last contact ${when(v.lastContactAt)}.` : "No contact yet."} Needs to reach api.zaviagent.com on port 443.</p>`;
  }
}

export function statusPage(v: View, csrf: string): SafeHtml {
  const r = v.rules;
  return layout(
    "Status",
    html`<h1>Status</h1>
<div class="box">${zaviLine(v)}${v.pairNote ? html`<p class="muted">${v.pairNote}</p>` : ""}
<p class="muted">Machine: ${v.machine} · version ${v.version}</p>
${v.lastError && v.status.kind === "running" ? html`<p class="muted">Last problem: ${v.lastError}</p>` : ""}</div>
${
  v.keySource === "generated"
    ? html`<div class="box bad"><p>${GENERATED_KEY_WARNING}</p><p class="muted">Recommended: keep the encryption key outside the data volume with a Docker secret named zavi_connector_key. Restart with it and the connector moves the stored secrets to the new key by itself.</p></div>`
    : html`<p class="muted">Stored secrets are encrypted with a key from ${v.keySource === "docker_secret" ? "a Docker secret" : "the ZAVI_SECRET_KEY setting"}.</p>`
}
<h2>Database</h2>
${
  v.database
    ? html`<p>${DIALECT_LABEL[v.database.dialect]} · ${v.database.masked}</p>${v.database.transport ? html`<p class="muted">${TRANSPORT_TEXT[v.database.transport] ?? ""}</p>` : ""}`
    : html`<p>No database yet. <a href="/database">Add a database</a>.</p>`
}
<h2>Rules</h2>
${
  r.status === "invalid"
    ? html`<div class="box bad"><p>${r.error}</p><p>Every request is refused until this is fixed. <a href="/rules">Open rules</a>.</p></div>`
    : r.status === "missing"
      ? html`<p>No rules saved yet, so nothing is allowed. <a href="/rules">Set the rules</a>.</p>`
      : html`<p>${r.rules.allowed.length} allowed · ${r.rules.blocked.length} blocked · ${r.rules.what_can_leave === "totals_and_counts_only" ? "Totals and counts only" : "Rows, with blocked columns removed"} · max ${r.rules.max_rows} rows per query. <a href="/rules">Change</a>.</p>`
}
<p class="muted"><a href="/activity">Activity</a>: every request from Zavi, kept only on this machine.</p>`,
    csrf,
  );
}

export function connectedLine(intro: Introspection, database: string | null): string {
  const unit = intro.dialect === "mongodb" ? "collection" : "table";
  const list = intro.tables.slice(0, 50).map((t) => `${t.name}${t.rowEstimate !== null ? ` (${t.rowEstimate.toLocaleString("en-US")} rows)` : ""}`);
  const more = intro.tables.length > 50 ? `, and ${intro.tables.length - 50} more` : "";
  return `[OK] Connected${database ? ` to ${database}` : ""}. Found ${intro.tables.length} ${unit}${intro.tables.length === 1 ? "" : "s"}${list.length ? `: ${list.join(", ")}${more}` : ""}.`;
}

export function databasePage(v: View, csrf: string, flash: { ok: boolean; text: string } | null): SafeHtml {
  return layout(
    "Database",
    html`<h1>Add a database</h1>
<p class="muted">The connector connects to it from inside your network. Use a login that can only read.</p>
${flash ? html`<div class="box ${flash.ok ? "ok" : "bad"}">${flash.text}</div>` : ""}
${
  v.database
    ? html`<div class="box"><p>Saved: ${DIALECT_LABEL[v.database.dialect]} · ${v.database.masked}</p>${v.database.transport ? html`<p class="muted">${TRANSPORT_TEXT[v.database.transport] ?? ""}</p>` : ""}
<form class="inline" method="post" action="/database"><input type="hidden" name="csrf" value="${attr(csrf)}"><input type="hidden" name="action" value="remove"><button class="secondary" type="submit">Remove database</button></form>
<p class="muted">Saving a new one below replaces it.</p></div>`
    : ""
}
<form method="post" action="/database" autocomplete="off">
<input type="hidden" name="csrf" value="${attr(csrf)}"><input type="hidden" name="action" value="test">
<label>Database type<select name="dialect" required>
<option value="postgres"${v.database?.dialect === "postgres" ? html` selected` : ""}>PostgreSQL</option>
<option value="mysql"${v.database?.dialect === "mysql" ? html` selected` : ""}>MySQL</option>
<option value="mongodb"${v.database?.dialect === "mongodb" ? html` selected` : ""}>MongoDB</option>
</select></label>
<label>Connection string<input type="password" name="connection_string" required spellcheck="false" placeholder="postgres://readonly:password@db.internal:5432/app"></label>
<p class="muted">Saved encrypted on this machine only. It is saved only if the test connects.</p>
<button type="submit">Test</button></form>`,
    csrf,
  );
}

export function rulesPage(v: View, csrf: string, intro: Introspection | null, error: string | null, saved: boolean): SafeHtml {
  const r = v.rules;
  const unit = intro?.dialect === "mongodb" ? "collection" : "table";
  const colWord = unit === "collection" ? "fields" : "columns";
  const fresh = r.status !== "ok";
  const allowed = new Set(r.rules.allowed);
  const blocked = new Set(r.rules.blocked);
  const tables = (intro?.tables ?? []).filter((t) => !t.view_of);
  const sensitive = tables.flatMap((t) => t.columns.filter((c) => isSensitiveColumn(t.name, c)).map((c) => `${t.name}.${c.name}`));
  const listed = new Set(tables.flatMap((t) => t.columns.map((c) => `${t.name}.${c.name}`)));
  const extra = [...blocked].filter((b) => !listed.has(b));
  return layout(
    "Rules",
    html`<h1>Rules: what can leave this machine</h1>
<p class="muted">Every request from Zavi is checked against these. Only you can change them, here.</p>
${saved ? html`<div class="box ok">Saved. Zavi gets the new rules summary within seconds; the rules apply to the next request.</div>` : ""}
${error ? html`<div class="box bad">${error}</div>` : ""}
${r.status === "invalid" ? html`<div class="box bad">${r.error} Every request is refused until you save valid rules.</div>` : ""}
${
  !intro
    ? html`<p>${v.database ? "The database's tables could not be listed right now." : html`Add a database first: <a href="/database">Database</a>.`}</p>`
    : html`<form method="post" action="/rules">
<input type="hidden" name="csrf" value="${attr(csrf)}">
<fieldset><legend>${unit === "collection" ? "Collections" : "Tables"} Zavi may query</legend>
${tables.length === 0 ? html`<p class="muted">None found.</p>` : ""}
${tables.map(
  (t) => html`<label class="check"><input type="checkbox" name="allowed" value="${attr(t.name)}"${allowed.has(t.name) ? html` checked` : ""}><span><b>${t.name}</b> <span class="muted">${t.rowEstimate !== null ? `${t.rowEstimate.toLocaleString("en-US")} rows` : ""}</span></span></label>`,
)}
</fieldset>
<fieldset><legend>Blocked ${colWord} (ticked for you, they look personal)</legend>
${sensitive.length === 0 ? html`<p class="muted">Nothing looks personal by name. You can still block any ${unit === "collection" ? "field" : "column"} below.</p>` : ""}
${sensitive.map((b) => html`<label class="check"><input type="checkbox" name="blocked" value="${attr(b)}"${fresh || blocked.has(b) ? html` checked` : ""}><span>${b}</span></label>`)}
<details><summary>Block other ${colWord}</summary>
${tables.map(
  (t) => html`<p><b>${t.name}</b></p>${t.columns
    .filter((c) => !isSensitiveColumn(t.name, c))
    .map((c) => html`<label class="check"><input type="checkbox" name="blocked" value="${attr(`${t.name}.${c.name}`)}"${blocked.has(`${t.name}.${c.name}`) ? html` checked` : ""}><span>${c.name}</span></label>`)}`,
)}
</details>
<label>More ${colWord} to block, one per line (${unit}.${unit === "collection" ? "field" : "column"})<textarea name="blocked_extra" spellcheck="false">${extra.join("\n")}</textarea></label>
</fieldset>
<fieldset><legend>What can leave</legend>
<label class="check"><input type="radio" name="what_can_leave" value="totals_and_counts_only"${r.rules.what_can_leave === "totals_and_counts_only" ? html` checked` : ""}><span>Totals and counts only</span></label>
<label class="check"><input type="radio" name="what_can_leave" value="rows_without_blocked_columns"${r.rules.what_can_leave === "rows_without_blocked_columns" ? html` checked` : ""}><span>Rows, with blocked ${colWord} removed</span></label>
<p class="muted">${TOTALS_ONLY_LIMITATION_NOTE}</p>
</fieldset>
<label>Max rows per query<input type="number" name="max_rows" min="1" max="1000" value="${attr(r.rules.max_rows)}" required></label>
<button type="submit">Save rules</button>
</form>`
}
<h2>Saved as ${v.rulesPath}</h2>
${r.text ? html`<pre>${r.text}</pre>` : html`<p class="muted">Not saved yet: nothing is allowed.</p>`}`,
    csrf,
  );
}

function decisionCell(e: ActivityRow): SafeHtml {
  const word = e.decision === "allowed" ? html`<span class="ok">ALLOWED</span>` : e.decision === "refused" ? html`<span class="bad">REFUSED</span>` : html`<span class="bad">FAILED</span>`;
  const delivery = e.delivery === "delivered" ? "" : e.delivery === "stale" ? "Zavi had already stopped waiting." : e.delivery === "rejected" ? "Zavi did not accept the reply." : "Could not reach Zavi.";
  return html`${word}${e.reason ? html`<br><span class="muted">${e.reason}</span>` : ""}${delivery ? html`<br><span class="muted">${delivery}</span>` : ""}`;
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

export function activityPage(v: View, csrf: string, rows: ActivityRow[]): SafeHtml {
  return layout(
    "Activity",
    html`<h1>Activity: every request from Zavi</h1>
<p class="muted">This log lives only on this machine. Zavi cannot read or delete it. It keeps about the last 100 MB.</p>
<table><thead><tr><th>Time</th><th>Query</th><th>Decision</th><th>Rows</th><th>Bytes sent</th></tr></thead><tbody>
${
  rows.length === 0
    ? html`<tr><td colspan="5" class="muted">No requests yet.</td></tr>`
    : rows.map(
        (e) => html`<tr><td><a href="${localHref(`/activity/${encodeURIComponent(e.id)}`)}">${when(e.at)}</a></td><td class="q" title="${attr(e.query.slice(0, 500))}">${e.query.split("\n")[0]}</td><td>${decisionCell(e)}</td><td>${e.rows}</td><td>${fmtBytes(e.bytes)}</td></tr>`,
      )
}
</tbody></table>
<p class="muted">Open a time to see exactly what was sent.</p>`,
    csrf,
  );
}

export function activityDetailPage(v: View, csrf: string, e: ActivityEntry): SafeHtml {
  return layout(
    "Activity",
    html`<h1>Request at ${when(e.at)}</h1>
<p><a href="/activity">All activity</a></p>
<h2>What Zavi asked</h2><pre>${e.query}</pre>
<h2>Decision</h2><p>${decisionCell(e)}</p><p class="muted">${e.rows} rows · ${fmtBytes(e.bytes)}</p>
<h2>Exactly what was sent to Zavi for the ${when(e.at)} request</h2><pre>${e.sent}</pre>`,
    csrf,
  );
}
