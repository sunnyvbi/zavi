#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const ENTRY = join(PKG_ROOT, 'src', 'index.ts');
const COMPOSITION = 'LaunchVideo';
const FPS = 30;

const DEFAULT_BEAT_FRAMES = { hook: 120, problem: 132, feature: 132, proof: 132, cta: 120, chat: 162, cardwall: 132, metric: 156, productui: 162, coverage: 132, broll: 180 };

function parseArgs(argv) {
  const a = { scale: null, still: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--brief') a.brief = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--scale') a.scale = argv[++i];
    else if (k === '--still') a.still = argv[++i];
  }
  return a;
}

function die(msg) {
  console.error(`[render] ERROR: ${msg}`);
  process.exit(1);
}

function preValidate(brief) {
  if (!brief || typeof brief !== 'object') die('brief is not an object');
  if (!brief.product?.name) die('brief.product.name is required');
  if (!brief.brand?.primaryColor || !brief.brand?.accentColor) die('brief.brand.primaryColor/accentColor required');
  if (!Array.isArray(brief.beats) || brief.beats.length === 0) die('brief.beats must be a non-empty array');
  if (!brief.cta?.text || !brief.cta?.url) die('brief.cta.text/url required');
}

function beatFrames(beat) {
  return beat.durationFrames && beat.durationFrames > 0
    ? Math.round(beat.durationFrames)
    : DEFAULT_BEAT_FRAMES[beat.kind] ?? 90;
}

function beatTimeline(brief, briefDir) {
  const out = [];
  let frame = 0;
  for (const beat of brief.beats) {
    const dur = beatFrames(beat);
    const startSec = frame / FPS;
    const endSec = (frame + dur) / FPS;
    const audioFile = beat.vo?.audioFile ? resolvePath(beat.vo.audioFile, briefDir) : null;
    out.push({ startSec, endSec, srtText: beat.vo?.srtText ?? null, audioFile });
    frame += dur;
  }
  return out;
}

function resolvePath(p, baseDir) {
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

function fmtTs(sec) {
  const ms = Math.round((sec % 1) * 1000);
  const total = Math.floor(sec);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms).padStart(3, '0')}`;
}

function stripDashes(s) {
  return String(s)
    .replace(/\s*[—―]\s*/g, ', ')
    .replace(/,\s*,/g, ', ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*([.!?;:])/g, '$1')
    .trim();
}

function writeSrt(timeline, srtPath) {
  const cues = [];
  let idx = 1;
  for (const t of timeline) {
    if (!t.srtText) continue;
    cues.push(`${idx}\n${fmtTs(t.startSec)} --> ${fmtTs(t.endSec)}\n${stripDashes(t.srtText)}\n`);
    idx++;
  }
  if (cues.length === 0) return null;
  writeFileSync(srtPath, cues.join('\n'), 'utf8');
  return srtPath;
}

function hasBin(bin) {
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  return r.status === 0;
}

function mixAudio({ silentMp4, finalMp4, timeline, musicFile, videoDurSec }) {
  if (!hasBin('ffmpeg')) {
    console.warn('[render] ffmpeg not found on PATH — keeping silent render. `apt-get install -y ffmpeg` in the sandbox.');
    if (silentMp4 !== finalMp4) renameSync(silentMp4, finalMp4);
    return false;
  }

  const inputs = ['-i', silentMp4];
  const filters = [];
  const labels = [];
  let inIdx = 1;

  for (const t of timeline) {
    if (!t.audioFile) continue;
    if (!existsSync(t.audioFile)) {
      console.warn(`[render] VO audio missing, skipping: ${t.audioFile}`);
      continue;
    }
    inputs.push('-i', t.audioFile);
    const ms = Math.round(t.startSec * 1000);
    const lbl = `v${inIdx}`;
    filters.push(`[${inIdx}:a]adelay=${ms}|${ms}:all=1[${lbl}]`);
    labels.push(lbl);
    inIdx++;
  }

  if (musicFile && existsSync(musicFile)) {
    inputs.push('-stream_loop', '-1', '-i', musicFile);
    const lbl = `mbed`;
    filters.push(`[${inIdx}:a]volume=0.12[${lbl}]`);
    labels.push(lbl);
    inIdx++;
  }

  if (labels.length === 0) {
    console.warn('[render] no usable audio inputs — keeping silent render.');
    if (silentMp4 !== finalMp4) renameSync(silentMp4, finalMp4);
    return false;
  }

  let aout;
  if (labels.length === 1) {
    aout = 'aout';
    filters.push(`[${labels[0]}]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
  } else {
    const joined = labels.map((l) => `[${l}]`).join('');
    filters.push(`${joined}amix=inputs=${labels.length}:duration=longest:normalize=0[amixed]`);
    filters.push(`[amixed]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
    aout = 'aout';
  }

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '0:v',
    '-map', `[${aout}]`,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-t', videoDurSec.toFixed(3),
    finalMp4,
  ];
  console.log('[render] ffmpeg audio mix...');
  const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.warn('[render] ffmpeg mix failed — keeping silent render.');
    if (silentMp4 !== finalMp4 && existsSync(silentMp4)) copyFileSync(silentMp4, finalMp4);
    return false;
  }
  if (silentMp4 !== finalMp4 && existsSync(silentMp4)) {
    try { unlinkSync(silentMp4); } catch {  }
  }
  return true;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.brief) die('--brief <path.json> is required');
  const briefPath = resolve(args.brief);
  if (!existsSync(briefPath)) die(`brief not found: ${briefPath}`);
  const briefDir = dirname(briefPath);

  const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
  preValidate(brief);

  const timeline = beatTimeline(brief, briefDir);
  const totalFrames = brief.authored
    ? brief.authoredFrames ?? Math.round((brief.beats ?? []).reduce((s, b) => s + beatFrames(b), 0))
    : brief.beats.reduce((s, b) => s + beatFrames(b), 0);
  const videoDurSec = totalFrames / FPS;

  if (args.still != null) {
    const out = resolve(args.out || join(PKG_ROOT, 'out', 'still.png'));
    mkdirSync(dirname(out), { recursive: true });
    const a = ['remotion', 'still', ENTRY, COMPOSITION, out, `--props=${briefPath}`, `--frame=${args.still}`, '--log=error'];
    if (args.scale) a.push(`--scale=${args.scale}`);
    const r = spawnSync('npx', a, { stdio: 'inherit', cwd: PKG_ROOT });
    if (r.status !== 0) die('remotion still failed');
    console.log(`[render] still -> ${out}`);
    return;
  }

  const out = resolve(args.out || join(PKG_ROOT, 'out', 'launch.mp4'));
  mkdirSync(dirname(out), { recursive: true });

  const hasAudio = timeline.some((t) => t.audioFile) || !!brief.music?.file;
  const silentMp4 = hasAudio ? out.replace(/\.mp4$/, '') + '.silent.mp4' : out;

  const renderArgs = ['remotion', 'render', ENTRY, COMPOSITION, silentMp4, `--props=${briefPath}`, '--log=error'];
  if (args.scale) renderArgs.push(`--scale=${args.scale}`);
  console.log(
    brief.authored
      ? `[render] rendering an authored film, ${totalFrames}f (~${videoDurSec.toFixed(1)}s)...`
      : `[render] rendering ${brief.beats.length} beats, ${totalFrames}f (~${videoDurSec.toFixed(1)}s)...`,
  );
  const r = spawnSync('npx', renderArgs, { stdio: 'inherit', cwd: PKG_ROOT });
  if (r.status !== 0) die('remotion render failed');

  const srtPath = out.replace(/\.mp4$/, '') + '.srt';
  const wroteSrt = writeSrt(timeline, srtPath);
  if (wroteSrt) console.log(`[render] captions -> ${wroteSrt}`);

  if (hasAudio) {
    const musicFile = brief.music?.file ? resolvePath(brief.music.file, briefDir) : null;
    mixAudio({ silentMp4, finalMp4: out, timeline, musicFile, videoDurSec });
  }

  console.log(`[render] DONE -> ${out}`);
}

main();
