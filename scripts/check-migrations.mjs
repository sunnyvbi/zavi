#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

function die(msg) {
  console.error(`check-migrations: FAIL — ${msg}`);
  process.exit(1);
}

function migrationListArgs() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (dbUrl) return ['migration', 'list', '--db-url', dbUrl];
  return ['migration', 'list', '--linked'];
}

function redactSecrets(value) {
  let out = String(value ?? '');
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (dbUrl) out = out.split(dbUrl).join('<SUPABASE_DB_URL>');
  return out.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgres://<credentials>@');
}

function checkDivergence() {
  let raw;
  try {
    raw = execFileSync('supabase', migrationListArgs(), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    die(`\`supabase migration list\` failed: ${redactSecrets(e.stderr || e.message)}`);
  }

  const lines = String(raw).split('\n');
  const headerIdx = lines.findIndex(
    (l) => /\blocal\b/i.test(l) && /\bremote\b/i.test(l) && l.includes('|'),
  );
  if (headerIdx === -1) {
    die(
      'migration list output has no recognizable "Local | Remote" header ' +
        `(fail-closed — CLI format changed?). Raw head: ${String(raw).slice(0, 200)}`,
    );
  }

  const isSeparator = (l) => /^[\s|+-]+$/.test(l) && l.includes('-');
  const diverged = [];
  let dataRows = 0;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.includes('|') || isSeparator(line)) continue;
    const cols = line.split('|').map((c) => c.trim());
    const l = cols[0] || '';
    const rem = cols[1] || '';
    if (!l && !rem) continue;
    dataRows += 1;
    if (!l || !rem) {
      diverged.push(`${l || rem} (local=${l ? 'yes' : 'NO'} remote=${rem ? 'yes' : 'NO'})`);
    } else if (l !== rem) {
      diverged.push(`local=${l} != remote=${rem}`);
    }
  }

  if (dataRows === 0) {
    die('migration list table had a header but zero data rows (fail-closed — unexpected)');
  }
  if (diverged.length > 0) {
    die(`migration divergence — local/remote mismatch:\n  - ${diverged.join('\n  - ')}`);
  }
  console.log(`check-migrations: divergence OK (${dataRows} migrations, local==remote)`);
}

checkDivergence();
console.log('check-migrations: divergence check passed');
