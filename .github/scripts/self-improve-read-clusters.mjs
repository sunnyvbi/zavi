#!/usr/bin/env node

import { appendFileSync } from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';
const READ_TOKEN = process.env.SELF_IMPROVE_READ_TOKEN || '';
const OUT = process.env.GITHUB_OUTPUT;

function emit(count, clusters) {
  const line1 = `count=${count}`;
  const line2 = `clusters=${JSON.stringify(clusters)}`;
  if (OUT) {
    appendFileSync(OUT, line1 + '\n');
    appendFileSync(OUT, line2 + '\n');
  }
  console.log(`[read-clusters] ${count} pending cluster(s).`);
}

async function main() {
  if (!SUPABASE_URL || !ANON) {
    console.log('[read-clusters] SUPABASE_URL/ANON not set — emitting 0 (fail-safe inert).');
    emit(0, []);
    return;
  }

  try {
    const reapRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/reap_stale_improvement_leases`,
      {
        method: 'POST',
        headers: {
          apikey: ANON,
          Authorization: `Bearer ${READ_TOKEN || ANON}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );
    if (reapRes.ok) {
      const reaped = await reapRes.json();
      if (typeof reaped === 'number' && reaped > 0) {
        console.log(`[read-clusters] reaped ${reaped} stale lease(s) back to pending.`);
      }
    } else {
      console.log(`[read-clusters] reaper not ready (status ${reapRes.status}) — continuing.`);
    }
  } catch (e) {
    console.log(`[read-clusters] reaper error (${e?.message ?? e}) — continuing.`);
  }

  let rows = [];
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/list_pending_improvement_requests`, {
      method: 'POST',
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${READ_TOKEN || ANON}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_limit: 50 }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.log(`[read-clusters] RPC not ready or denied (status ${res.status}): ${body.slice(0, 200)} — emitting 0.`);
      emit(0, []);
      return;
    }
    rows = await res.json();
  } catch (e) {
    console.log(`[read-clusters] read error (${e?.message ?? e}) — emitting 0 (fail-safe).`);
    emit(0, []);
    return;
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    emit(0, []);
    return;
  }

  const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const REASON_RE = /^[a-z][a-z0-9_]{1,48}$/;
  const clusters = [];
  for (const r of rows) {
    const slug = String(r.agent_slug ?? '').trim();
    const sig = String(r.cluster_signature ?? '').trim();
    if (!SLUG_RE.test(slug)) continue;
    const runIds = Array.isArray(r.run_ids)
      ? r.run_ids.filter((x) => typeof x === 'string' && UUID_RE.test(x)).slice(0, 50)
      : [];
    const reasonRaw = String(r.digest_reason ?? '').trim();
    const digest_reason = REASON_RE.test(reasonRaw) ? reasonRaw : '';
    const idNum = Number(r.id);
    const request_id = Number.isInteger(idNum) && idNum > 0 ? idNum : null;
    clusters.push({
      request_id,
      agent_slug: slug,
      cluster_signature: sig.slice(0, 64),
      run_ids: runIds,
      digest_reason,
    });
  }
  emit(clusters.length, clusters);
}

main().catch((e) => {
  console.log(`[read-clusters] fatal (${e?.message ?? e}) — emitting 0.`);
  emit(0, []);
});
