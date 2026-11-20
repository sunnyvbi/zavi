#!/usr/bin/env node

import { createScriptClient } from "./_supabase-script-client.mjs";

const argv = process.argv.slice(2);
const days = Math.max(1, Math.min(60, Number(argv.find((a) => /^\d+$/.test(a)) ?? 7)));
const withText = argv.includes("--text");
const LIMIT = 300;

const sb = createScriptClient();
const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const cols =
  "tenant_id, family, status, primary_key, severity, opened_on, last_eval_on, recovered_on, notices, last_notice_mode, last_channel, wake_status, last_message_subject" +
  (withText ? ", last_message_text" : "");
const { data: incidents, error } = await sb
  .from("metric_incidents")
  .select(cols)
  .gte("last_eval_on", since)
  .order("tenant_id")
  .order("opened_on", { ascending: false })
  .limit(LIMIT);
if (error) {
  console.error(`metric_incidents read failed: ${error.message}`);
  process.exit(1);
}

const { data: moves, error: mvErr } = await sb
  .from("metric_moves")
  .select("tenant_id, good")
  .gte("move_date", since)
  .limit(5000);
if (mvErr) console.error(`metric_moves read failed: ${mvErr.message}`);

const tenantIds = [...new Set((incidents ?? []).map((r) => r.tenant_id))];
const names = new Map();
if (tenantIds.length) {
  const { data: t } = await sb.from("tenants").select("id, slug").in("id", tenantIds).limit(LIMIT);
  for (const r of t ?? []) names.set(r.id, r.slug);
}

const movesBy = new Map();
for (const m of moves ?? []) {
  const c = movesBy.get(m.tenant_id) ?? { good: 0, minor_bad: 0 };
  if (m.good) c.good += 1;
  else c.minor_bad += 1;
  movesBy.set(m.tenant_id, c);
}

console.log(`Anomaly watch, last ${days} days (since ${since}). ${incidents?.length ?? 0} incidents${(incidents?.length ?? 0) >= LIMIT ? ` (capped at ${LIMIT})` : ""}.`);
let current = null;
for (const r of incidents ?? []) {
  if (r.tenant_id !== current) {
    current = r.tenant_id;
    const mv = movesBy.get(r.tenant_id) ?? { good: 0, minor_bad: 0 };
    console.log(`\n== ${names.get(r.tenant_id) ?? r.tenant_id}  (What moved: ${mv.good} good, ${mv.minor_bad} minor bad)`);
  }
  const sev = Number(r.severity).toFixed(1);
  console.log(
    `  [${r.status}] ${r.family}  primary=${r.primary_key}  severity=${sev}  opened=${r.opened_on}  last=${r.last_eval_on}` +
      `${r.recovered_on ? `  recovered=${r.recovered_on}` : ""}  notices=${r.notices}  mode=${r.last_notice_mode ?? "-"}` +
      `${r.last_channel ? `  channel=${r.last_channel}` : ""}${r.wake_status ? `  wake=${r.wake_status}` : ""}`,
  );
  if (r.last_message_subject) console.log(`      would send: ${r.last_message_subject}`);
  if (withText && r.last_message_text) console.log(r.last_message_text.split("\n").map((l) => `        ${l}`).join("\n"));
}
const quiet = [...movesBy.keys()].filter((t) => !tenantIds.includes(t));
if (quiet.length) console.log(`\n${quiet.length} more tenant(s) had only minor moves, no incident.`);
