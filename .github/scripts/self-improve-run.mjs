#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';
const READ_TOKEN = process.env.SELF_IMPROVE_READ_TOKEN || '';

async function finalizeSurfaced(requestId) {
  if (!Number.isInteger(requestId) || requestId <= 0) return;
  if (!SUPABASE_URL || !ANON) return;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/finalize_improvement_request`,
      {
        method: 'POST',
        headers: {
          apikey: ANON,
          Authorization: `Bearer ${READ_TOKEN || ANON}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_request_id: requestId, p_status: 'surfaced' }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      console.log(`[run] finalize(req=${requestId}) not applied (status ${res.status}): ${body.slice(0, 120)}`);
    }
  } catch (e) {
    console.log(`[run] finalize(req=${requestId}) error (${e?.message ?? e}) — reaper will retry.`);
  }
}

function parseClusters() {
  const raw = process.env.CLUSTERS_JSON || '[]';
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    console.log('[run] CLUSTERS_JSON not parseable — nothing to do.');
    return [];
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_RE = /^[a-z][a-z0-9_]{1,48}$/;

function runOne(cluster) {
  const slug = String(cluster?.agent_slug ?? '').trim();
  const runIds = Array.isArray(cluster?.run_ids)
    ? cluster.run_ids.filter((x) => typeof x === 'string' && UUID_RE.test(x)).slice(0, 50)
    : [];
  const reasonRaw = String(cluster?.digest_reason ?? '').trim();
  const digestReason = REASON_RE.test(reasonRaw) ? reasonRaw : '';

  const prompt = `/compare-with-claude-super-automation ${slug}`;
  console.log(
    `[run] cluster agent=${slug} reason=${digestReason || 'none'} run_ids=${runIds.length}` +
      ` → claude -p (skill owns gate+allowlist+e3)`,
  );
  const res = spawnSync(
    'claude',
    [
      '-p',
      prompt,
      '--allowedTools',
      'Read,Grep,Glob,Edit,Write,Bash,Skill',
      '--permission-mode',
      'acceptEdits',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        SELF_IMPROVE_RUN_IDS: runIds.join(','),
        SELF_IMPROVE_DIGEST_REASON: digestReason,
      },
      timeout: 1000 * 60 * 30,
    }
  );
  if (res.status !== 0) {
    console.log(`[run] cluster agent=${slug} exited non-zero (status=${res.status}, signal=${res.signal ?? 'none'}) — continuing other clusters.`);
    return false;
  }
  return true;
}

async function main() {
  const clusters = parseClusters();
  if (clusters.length === 0) {
    console.log('[run] no clusters — done.');
    return;
  }
  let ok = 0;
  for (const c of clusters) {
    const slug = String(c?.agent_slug ?? '').trim();
    if (!SLUG_RE.test(slug)) {
      console.log(`[run] skip malformed slug: ${JSON.stringify(c?.agent_slug)}`);
      continue;
    }
    if (runOne(c)) {
      ok += 1;
      await finalizeSurfaced(Number(c?.request_id));
    }
  }
  console.log(`[run] done — ${ok}/${clusters.length} cluster(s) completed cleanly.`);
}

main();
