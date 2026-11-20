#!/usr/bin/env node
import { bundle } from '@remotion/bundler';
import { selectComposition, renderStill } from '@remotion/renderer';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const FPS = 30;
const DEFAULT_BEAT_FRAMES = { hook: 120, problem: 132, feature: 132, proof: 132, cta: 120, chat: 162, cardwall: 132, metric: 156, productui: 162, coverage: 132 };

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--brief') a.brief = argv[++i];
    else if (argv[i] === '--outdir') a.outdir = argv[++i];
  }
  return a;
}
const beatFrames = (b) => (b.durationFrames && b.durationFrames > 0 ? Math.round(b.durationFrames) : DEFAULT_BEAT_FRAMES[b.kind] ?? 90);

async function main() {
  const args = parseArgs(process.argv);
  const briefPath = resolve(args.brief);
  const outdir = resolve(args.outdir);
  mkdirSync(outdir, { recursive: true });
  const brief = JSON.parse(readFileSync(briefPath, 'utf8'));

  const picks = [];
  let f = 0;
  brief.beats.forEach((b, i) => {
    const dur = beatFrames(b);
    picks.push({ i, kind: b.kind, frame: Math.min(f + Math.round(dur * 0.62), f + dur - 1) });
    f += dur;
  });

  console.log('[frames] bundling...');
  const serveUrl = await bundle({ entryPoint: join(PKG_ROOT, 'src', 'index.ts'), onProgress: () => {} });
  const composition = await selectComposition({ serveUrl, id: 'LaunchVideo', inputProps: brief });
  console.log(`[frames] ${composition.width}x${composition.height}, ${composition.durationInFrames}f`);

  for (const p of picks) {
    const out = join(outdir, `beat_${p.i}_${p.kind}.png`);
    await renderStill({ composition, serveUrl, output: out, frame: p.frame, inputProps: brief, overwrite: true });
    console.log(`[frames] beat ${p.i} (${p.kind}) @${p.frame} -> ${out}`);
  }
  console.log('[frames] DONE');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
