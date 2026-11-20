#!/usr/bin/env node
import { bundle } from '@remotion/bundler';
import { selectComposition, renderStill, openBrowser } from '@remotion/renderer';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..');
const AUTHORED = join(PKG, 'src', 'Authored.tsx');
const FPS = 30;
const SW = 480, SH = 270;

export const LIMITS = {
  minShots: 20, maxShots: 30,
  minSec: 45, maxSec: 60,
  minShotFrames: 36, maxShotFrames: 102,
  minAvgSec: 1.6, maxAvgSec: 2.6,
  maxLayoutUses: 2,
  minMotion: 0.35,
  minShotDifference: 7,
  darkGround: 120, lightGround: 200, maxNonLightShots: 3,
  minOccupancy: 0.22, minBottomOccupancy: 0.12,
};

export const SAMPLE_LIMITS = {
  every: 60,
  minMotion: 0.12,
  minOccupancy: 0.12,
  minBottomOccupancy: 0.05,
  maxStillShare: 0.15,
  maxSparseShare: 0.2,
  maxEmptyBottomShare: 0.25,
};

export function parseFilm(src) {
  const declared = [...src.matchAll(/export\s+const\s+AUTHORED_FRAMES\s*(?::\s*number\s*)?=\s*(\d+)/g)].map((m) => Number(m[1]));
  const anchor = src.indexOf('const SHOTS');
  const body = anchor >= 0 ? src.slice(anchor) : '';
  const shots = [...body.matchAll(/\{\s*dur:\s*(\d+)\s*,\s*layout:\s*['"]([a-z-]+)['"]/g)].map((m) => ({ dur: Number(m[1]), layout: m[2] }));
  return { declared: declared.length === 1 ? declared[0] : null, shots };
}

export function staticReasons({ declared, shots }) {
  const r = [];
  if (declared == null) r.push('no single numeric AUTHORED_FRAMES export');
  if (shots.length === 0) { r.push('no SHOTS table in the kit shape ({ dur: N, layout: "x", ... })'); return r; }
  const total = shots.reduce((a, s) => a + s.dur, 0);
  if (declared != null && total !== declared) r.push(`shot durations sum to ${total} frames but AUTHORED_FRAMES is ${declared}`);
  const n = shots.length, sec = total / FPS, avg = sec / n;
  if (n < LIMITS.minShots || n > LIMITS.maxShots) r.push(`${n} shots; write ${LIMITS.minShots}-${LIMITS.maxShots}`);
  if (sec < LIMITS.minSec || sec > LIMITS.maxSec) r.push(`runtime ${sec.toFixed(1)}s; must be ${LIMITS.minSec}-${LIMITS.maxSec}s`);
  if (avg < LIMITS.minAvgSec || avg > LIMITS.maxAvgSec) r.push(`average shot ${avg.toFixed(2)}s; aim for ~2s (${LIMITS.minAvgSec}-${LIMITS.maxAvgSec})`);
  shots.forEach((s, i) => {
    if (s.dur < LIMITS.minShotFrames || s.dur > LIMITS.maxShotFrames) r.push(`shot ${i + 1} is ${(s.dur / FPS).toFixed(1)}s; every shot 1.2-3.4s`);
    if (i > 0 && shots[i - 1].layout === s.layout) r.push(`shots ${i} and ${i + 1} share layout "${s.layout}"`);
  });
  const uses = {};
  for (const s of shots) uses[s.layout] = (uses[s.layout] || 0) + 1;
  for (const [k, v] of Object.entries(uses)) if (v > LIMITS.maxLayoutUses) r.push(`layout "${k}" used ${v} times (max ${LIMITS.maxLayoutUses})`);
  return r;
}

function grey(png, w, h) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`ffmpeg could not read ${png}: ${r.stderr}`);
  return r.stdout;
}
function rgbCorners(png) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', `scale=${SW}:${SH}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
  const b = r.stdout;
  const pts = [[8, 8], [SW - 9, 8], [8, SH - 9], [SW - 9, SH - 9], [SW / 2, 6]];
  let sum = 0;
  for (const [x, y] of pts) {
    const i = (Math.round(y) * SW + Math.round(x)) * 3;
    sum += 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
  }
  return sum / pts.length;
}
const mad = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

function occupancy(g, w, h, groundLevel) {
  const T = 15, cols = Math.floor(w / T), rows = Math.floor(h / T);
  let occ = 0, bottomOcc = 0, bottomTiles = 0;
  for (let ty = 1; ty < rows - 1; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      let s = 0, s2 = 0;
      for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) { const v = g[(ty * T + y) * w + tx * T + x]; s += v; s2 += v * v; }
      const n = T * T, mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
      const on = sd > 5 || Math.abs(mean - groundLevel) > 10;
      if (on) occ++;
      if (ty >= rows * 0.6) { bottomTiles++; if (on) bottomOcc++; }
    }
  }
  return { occ: occ / ((rows - 2) * cols), bottom: bottomOcc / Math.max(1, bottomTiles) };
}

async function sampleFilm(total, still, report, reasons) {
  const L = SAMPLE_LIMITS;
  const rows = [];
  for (let m = 30; m + 3 < total - 6; m += L.every) {
    const [p0, p3] = [await still(m), await still(m + 3)];
    const g = grey(p0, SW, SH);
    const sorted = [...g].sort((x, y) => x - y);
    const dens = occupancy(g, SW, SH, sorted[Math.floor(sorted.length * 0.6)]);
    rows.push({
      frame: m,
      motion: +mad(g, grey(p3, SW, SH)).toFixed(2),
      ground: Math.round(rgbCorners(p0)),
      occupancy: +dens.occ.toFixed(2),
      bottom: +dens.bottom.toFixed(2),
    });
  }
  report.shots = rows;
  const n = Math.max(1, rows.length);
  const share = (f) => rows.filter(f).length / n;
  const at = (f) => rows.filter(f).map((r) => `${(r.frame / FPS).toFixed(1)}s`).join(', ');
  const still_ = (r) => r.motion < L.minMotion;
  const sparse = (r) => r.occupancy < L.minOccupancy;
  const empty = (r) => r.bottom < L.minBottomOccupancy;
  if (share(still_) > L.maxStillShare) reasons.push(`still at ${at(still_)}`);
  if (share(sparse) > L.maxSparseShare) reasons.push(`sparse at ${at(sparse)}`);
  if (share(empty) > L.maxEmptyBottomShare) reasons.push(`bottom of the frame empty at ${at(empty)}`);
  const dark = rows.filter((r) => r.ground < LIMITS.darkGround);
  if (dark.length > 0) reasons.push(`dark ground at ${at((r) => r.ground < LIMITS.darkGround)}`);
}

function args(argv) {
  const a = { all: false, sample: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--film') a.film = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--stills') a.stills = argv[++i];
    else if (argv[i] === '--all') a.all = true;
    else if (argv[i] === '--sample') a.sample = true;
  }
  return a;
}

async function main() {
  const a = args(process.argv);
  const filmPath = a.film ? resolve(a.film) : AUTHORED;
  const src = readFileSync(filmPath, 'utf8');
  const parsed = a.sample ? { declared: null, shots: [] } : parseFilm(src);
  const reasons = a.sample ? [] : staticReasons(parsed);
  const report = { pass: false, static: { shots: parsed.shots.length, frames: parsed.declared }, shots: [], reasons };
  const finish = () => {
    report.pass = reasons.length === 0;
    if (a.out) writeFileSync(a.out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ pass: report.pass, reasons }, null, 2));
    process.exit(report.pass ? 0 : 1);
  };
  if (reasons.length && !a.all) return finish();

  const stillDir = a.stills ? resolve(a.stills) : join(tmpdir(), `gate-film-${process.pid}`);
  mkdirSync(stillDir, { recursive: true });
  let backup = null;
  if (a.film && filmPath !== AUTHORED) {
    backup = readFileSync(AUTHORED, 'utf8');
    copyFileSync(filmPath, AUTHORED);
  }
  try {
    const serveUrl = await bundle({ entryPoint: join(PKG, 'src', 'index.ts'), onProgress: () => {} });
    const inputProps = { authored: true, aspect: '16:9' };
    const composition = await selectComposition({ serveUrl, id: 'LaunchVideo', inputProps });
    const browser = await openBrowser('chrome');
    const still = async (frame) => {
      const out = join(stillDir, `f${String(frame).padStart(5, '0')}.png`);
      if (!existsSync(out)) await renderStill({ composition, serveUrl, output: out, frame, inputProps, scale: 0.25, puppeteerInstance: browser, overwrite: true });
      return out;
    };
    if (a.sample) {
      await sampleFilm(composition.durationInFrames, still, report, reasons);
      await browser.close({ silent: true });
      return finish();
    }
    let from = 0;
    const mids = [];
    for (let i = 0; i < parsed.shots.length; i++) {
      const d = parsed.shots[i].dur;
      const m = from + Math.round(d * 0.5), e = from + d - 1;
      const [pm, pm3, pe4, pe] = [await still(m), await still(m + 3), await still(e - 3), await still(e)];
      const gm = grey(pm, SW, SH);
      const ground = rgbCorners(pm);
      const motionMid = mad(gm, grey(pm3, SW, SH));
      const motionEnd = mad(grey(pe4, SW, SH), grey(pe, SW, SH));
      const sorted = [...gm].sort((x, y) => x - y);
      const groundLevel = sorted[Math.floor(sorted.length * 0.6)];
      const dens = occupancy(gm, SW, SH, groundLevel);
      const thumb = grey(pm, 48, 27);
      mids.push(thumb);
      const row = { shot: i + 1, layout: parsed.shots[i].layout, mid: m, motionMid: +motionMid.toFixed(2), motionEnd: +motionEnd.toFixed(2), ground: Math.round(ground), occupancy: +dens.occ.toFixed(2), bottom: +dens.bottom.toFixed(2) };
      if (i > 0) row.diffFromPrev = +mad(mids[i - 1], thumb).toFixed(1);
      report.shots.push(row);
      if (motionMid < LIMITS.minMotion) reasons.push(`shot ${i + 1} (${row.layout}) is still mid-shot (change ${row.motionMid} < ${LIMITS.minMotion})`);
      if (motionEnd < LIMITS.minMotion) reasons.push(`shot ${i + 1} (${row.layout}) has stopped by its last frames (change ${row.motionEnd} < ${LIMITS.minMotion})`);
      if (ground < LIMITS.darkGround) reasons.push(`shot ${i + 1} has a dark ground (${row.ground}); the film is light`);
      if (dens.occ < LIMITS.minOccupancy) reasons.push(`shot ${i + 1} is sparse (${Math.round(dens.occ * 100)}% of the frame carries content)`);
      if (dens.bottom < LIMITS.minBottomOccupancy) reasons.push(`shot ${i + 1} leaves the bottom 40% empty (${Math.round(dens.bottom * 100)}%)`);
      if (i > 0 && row.diffFromPrev < LIMITS.minShotDifference) reasons.push(`shot ${i + 1} looks like shot ${i} (difference ${row.diffFromPrev})`);
      from += d;
    }
    const nonLight = report.shots.filter((s) => s.ground < LIMITS.lightGround).length;
    if (nonLight > LIMITS.maxNonLightShots) reasons.push(`${nonLight} shots are not on a light ground (max ${LIMITS.maxNonLightShots})`);
    await browser.close({ silent: true });
  } finally {
    if (backup != null) writeFileSync(AUTHORED, backup);
    if (!a.stills) rmSync(stillDir, { recursive: true, force: true });
  }
  return finish();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
