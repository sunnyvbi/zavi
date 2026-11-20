import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import type { FilmContent } from '../content';
import type { Station } from './types';
import { STATION_COMPONENTS } from './stations';
import { makeTokens, Tokens, Mono, alpha, clamp, EIO, VW, VH } from './kit';
import { interpolate } from 'remotion';

export const FPS = 30;
export const JOURNEY_FRAMES = 1530;

const WEIGHT: Record<Station['kind'], number> = {
  title: 1.25,
  numeral: 1.0,
  versus: 1.15,
  ring: 0.95,
  wall: 1.15,
  burst: 1.0,
  ladder: 0.85,
  filter: 1.05,
  steps: 1.2,
  chat: 1.15,
  range: 0.9,
  repeat: 1.0,
  clock: 1.0,
  strike: 0.9,
  redact: 0.95,
  options: 0.9,
  gate: 1.05,
  flow: 1.05,
  countdown: 1.0,
  quad: 1.15,
  cycle: 0.95,
  terms: 1.0,
  cta: 1.45,
};

const nonEmpty = (xs: (string | undefined)[] | undefined) => (xs ?? []).filter((x): x is string => !!x && x.trim().length > 0);

function usable(st: Station): boolean {
  switch (st.kind) {
    case 'wall':
      return nonEmpty(st.items).length >= 6;
    case 'burst':
      return nonEmpty(st.items).length >= 3;
    case 'ladder':
      return nonEmpty(st.rungs).length >= 3;
    case 'filter':
      return st.fields.length >= 1 && st.fields.every((x) => x.values.length > 0);
    case 'steps':
      return st.steps.length >= 2;
    case 'chat':
      return !!st.message;
    case 'strike':
      return nonEmpty(st.items).length >= 2;
    case 'options':
      return nonEmpty(st.items).length >= 2;
    case 'gate':
      return st.pass.length >= 2;
    case 'flow':
      return st.via.length >= 1;
    case 'quad':
      return st.items.length >= 2;
    case 'cycle':
      return st.nodes.length >= 3;
    case 'terms':
      return st.rows.length >= 2;
    case 'ring':
      return st.rows.length >= 1;
    default:
      return true;
  }
}

function deriveJourney(c: FilmContent): Station[] {
  const out: Station[] = [];
  const feats = c.features.filter((x) => x.title);
  out.push({
    kind: 'title',
    kicker: c.product_name,
    headline: c.one_liner || c.product_name,
    chips: feats.map((x) => x.title).slice(0, 10),
    notes: (c.surface?.items ?? []).map((i) => i.title).slice(0, 3),
  });
  for (const m of (c.metrics ?? []).slice(0, 2)) out.push({ kind: 'numeral', label: m.label, value: m.stat });
  if (c.problem) out.push({ kind: 'chat', title: c.product_name, from: 'You', message: c.problem, checks: feats.map((x) => x.title).slice(0, 3) });
  if (c.surface && c.surface.items.length >= 2)
    out.push({ kind: 'steps', title: c.surface.title, steps: c.surface.items.map((i) => ({ title: i.title, detail: i.chips.join(' · ') })) });
  if (feats.length >= 6) out.push({ kind: 'wall', title: 'What it does', items: feats.map((x) => x.title), countLabel: 'capabilities' });
  if (feats.length >= 4) out.push({ kind: 'quad', title: c.product_name, items: feats.slice(0, 4) });
  if (feats.length >= 3) out.push({ kind: 'burst', title: 'capabilities', center: c.product_name, items: feats.map((x) => x.title).slice(0, 10) });
  if ((c.regions ?? []).length >= 3) out.push({ kind: 'ladder', title: 'Where', rungs: c.regions ?? [] });
  if (feats.length >= 3) out.push({ kind: 'cycle', title: c.product_name, center: c.product_name, nodes: feats.slice(-3).map((x) => x.title) });
  if (feats.length >= 2) out.push({ kind: 'terms', title: c.one_liner || c.product_name, rows: feats.slice(0, 4).map((x) => ({ label: x.title, value: x.detail || x.title })) });
  out.push({ kind: 'cta', headline: c.cta_text, button: c.cta_text, url: c.cta_url.replace(/^https?:\/\//, '').replace(/\/$/, '') });
  return out;
}

export type Planned = { st: Station; from: number; dur: number; cx: number; cy: number; rot: number };

const MOVES = 'RDRUURDDRRURDRU';
const SX = 2250;
const SY = 1350;
const ROT = [0, -2.5, 2, -1.5, 3, -2, 1.5, -3, 2.5, -1];

export function planStations(c: FilmContent): Planned[] {
  let list = (Array.isArray(c.journey) && c.journey.length > 0 ? c.journey.slice(0, 40) : deriveJourney(c)).filter(usable);
  for (let i = 1; i < list.length - 2; i++) {
    if (list[i].kind === list[i - 1].kind) [list[i], list[i + 1]] = [list[i + 1], list[i]];
  }
  if (list.length >= 4 && list[list.length - 2].kind === list[list.length - 3].kind) list.splice(list.length - 2, 1);
  if (list.length > 30) list = [...list.slice(0, 29), list[list.length - 1]];
  const W = list.reduce((sum, st) => sum + WEIGHT[st.kind], 0);
  let acc = 0;
  let col = 0;
  let row = 0;
  return list.map((st, i) => {
    const from = Math.round((acc / W) * JOURNEY_FRAMES);
    acc += WEIGHT[st.kind];
    const to = Math.round((acc / W) * JOURNEY_FRAMES);
    if (i > 0) {
      const m = MOVES[(i - 1) % MOVES.length];
      if (m === 'R') col += 1;
      else if (m === 'D') row += 1;
      else row -= 1;
    }
    return { st, from, dur: to - from, cx: col * SX, cy: row * SY, rot: i === 0 ? 0 : ROT[i % ROT.length] };
  });
}

export const filmFrames = (_c: FilmContent): number => JOURNEY_FRAMES;

type Cam = { x: number; y: number; s: number; rz: number; tilt: number; yaw: number };
const TRANSIT = 20;

const FOCUS: Record<Station['kind'], [number, number]> = {
  title: [1440, 520], numeral: [960, 420], versus: [1300, 300], ring: [600, 560], wall: [960, 600],
  burst: [1100, 560], ladder: [960, 700], filter: [900, 420], steps: [960, 600], chat: [600, 500],
  range: [960, 700], repeat: [1100, 500], clock: [560, 540], strike: [700, 500], redact: [640, 560],
  options: [960, 450], gate: [600, 420], flow: [960, 560], countdown: [540, 560], quad: [1300, 550],
  cycle: [1240, 560], terms: [960, 450], cta: [960, 600],
};
const LONG_HOLD = 84;

function holdCam(p: Planned, f: number): Cam {
  const t = clamp((f - p.from) / Math.max(1, p.dur));
  let ox = 0;
  let oy = 0;
  let push = 0;
  if (p.dur > LONG_HOLD) {
    push = interpolate(t, [0.38, 0.72], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EIO });
    const [fx, fy] = FOCUS[p.st.kind];
    const lx = (Math.max(880, Math.min(1040, fx)) - VW / 2) * push;
    const ly = (Math.max(500, Math.min(600, fy)) - VH / 2) * push;
    const r = (p.rot * Math.PI) / 180;
    ox = lx * Math.cos(r) - ly * Math.sin(r);
    oy = lx * Math.sin(r) + ly * Math.cos(r);
  }
  return {
    x: p.cx + ox + Math.sin(f / 37) * 10,
    y: p.cy + oy + Math.cos(f / 43) * 7,
    s: 1.0 + 0.045 * t + 0.11 * push,
    rz: -p.rot + Math.sin(f / 51) * 0.25,
    tilt: 0,
    yaw: 0,
  };
}

function cameraAt(plan: Planned[], f: number): Cam {
  let i = 0;
  for (let j = 0; j < plan.length; j++) if (f >= plan[j].from) i = j;
  const cur = plan[i];
  const half = TRANSIT / 2;
  const next = plan[i + 1];
  const prev = plan[i - 1];
  let a: Planned | null = null;
  let b: Planned | null = null;
  let t = 0;
  if (next && f >= next.from - half) {
    a = cur;
    b = next;
    t = (f - (next.from - half)) / TRANSIT;
  } else if (prev && f < cur.from + half) {
    a = prev;
    b = cur;
    t = (f - (cur.from - half)) / TRANSIT;
  }
  if (!a || !b) return holdCam(cur, f);
  const e = interpolate(clamp(t), [0, 1], [0, 1], { easing: EIO });
  const A = holdCam(a, b.from - half);
  const B = holdCam(b, b.from + half);
  const arch = Math.sin(clamp(t) * Math.PI);
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  return {
    x: A.x + (B.x - A.x) * e,
    y: A.y + (B.y - A.y) * e,
    s: (A.s + (B.s - A.s) * e) * (1 - 0.44 * arch),
    rz: A.rz + (B.rz - A.rz) * e + arch * (dx !== 0 ? -2.5 : 2.5),
    tilt: arch * (dy !== 0 ? 9 : 16) * (dy < 0 ? -1 : 1),
    yaw: arch * (dx !== 0 ? -9 : 0),
  };
}

function port(p: Planned, toward: Planned): [number, number] {
  const dx = toward.cx - p.cx;
  const dy = toward.cy - p.cy;
  const lx = dx > 0 ? VW / 2 + 40 : dx < 0 ? -VW / 2 - 40 : 0;
  const ly = dy > 0 ? VH / 2 + 30 : dy < 0 ? -VH / 2 - 30 : 0;
  const r = (p.rot * Math.PI) / 180;
  return [p.cx + lx * Math.cos(r) - ly * Math.sin(r), p.cy + lx * Math.sin(r) + ly * Math.cos(r)];
}

const Thread: React.FC<{ a: Planned; b: Planned; f: number; T: Tokens }> = ({ a, b, f, T }) => {
  const [x0, y0] = port(a, b);
  const [x1, y1] = port(b, a);
  const minX = Math.min(x0, x1) - 80;
  const minY = Math.min(y0, y1) - 80;
  const w = Math.abs(x1 - x0) + 160;
  const h = Math.abs(y1 - y0) + 160;
  const horiz = Math.abs(b.cx - a.cx) > 0;
  const mx = (x0 + x1) / 2 - minX;
  const my = (y0 + y1) / 2 - minY;
  const p0x = x0 - minX;
  const p0y = y0 - minY;
  const p1x = x1 - minX;
  const p1y = y1 - minY;
  const d = horiz
    ? `M ${p0x} ${p0y} C ${mx} ${p0y}, ${mx} ${p1y}, ${p1x} ${p1y}`
    : `M ${p0x} ${p0y} C ${p0x} ${my}, ${p1x} ${my}, ${p1x} ${p1y}`;
  const drawn = clamp((f - (b.from - TRANSIT)) / (TRANSIT * 0.9));
  const bead = clamp((f - (b.from - TRANSIT / 2)) / TRANSIT);
  return (
    <svg width={w} height={h} style={{ position: 'absolute', left: minX, top: minY, overflow: 'visible' }}>
      <path d={d} fill="none" stroke={T.rule} strokeWidth={6} strokeLinecap="round" strokeDasharray="2 14" />
      <path d={d} fill="none" stroke={T.accent} strokeWidth={7} strokeLinecap="round" pathLength={1} strokeDasharray={`${drawn} 1`} />
      <circle cx={p0x} cy={p0y} r={13} fill={T.accent} />
      <circle cx={p1x} cy={p1y} r={13} fill={drawn >= 1 ? T.accent : T.card} stroke={T.accent} strokeWidth={4} />
      {bead > 0 && bead < 1 ? (
        <circle cx={p0x + (p1x - p0x) * bead} cy={horiz ? p0y + (p1y - p0y) * (bead * bead * (3 - 2 * bead)) : p0y + (p1y - p0y) * bead} r={20} fill={T.accentInk} />
      ) : null}
    </svg>
  );
};

const Hud: React.FC<{ plan: Planned[]; f: number; T: Tokens; name: string; url: string }> = ({ plan, f, T, name, url }) => {
  let i = 0;
  for (let j = 0; j < plan.length; j++) if (f >= plan[j].from) i = j;
  const n = plan.length;
  const p = plan[i];
  const prog = clamp((f - p.from) / Math.max(1, p.dur));
  const slate = p.st.slate ?? p.st.kind;
  const RX = 56;
  const RW = VW - 112;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: 56, top: 40, display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ width: 12, height: 12, borderRadius: 3, background: T.accent }} />
        <Mono c={T.ink} s={17} ls={2.6} w={700}>
          {name}
        </Mono>
        <Mono c={T.ink2} s={17} ls={2.6}>
          · {slate}
        </Mono>
      </div>
      <div style={{ position: 'absolute', right: 56, top: 40, display: 'flex', gap: 22 }}>
        <Mono c={T.ink2} s={17} ls={2.2}>
          {url}
        </Mono>
        <Mono c={T.ink} s={17} ls={2.2} w={700} style={{ fontVariantNumeric: 'tabular-nums' }}>
          {String(i + 1).padStart(2, '0')} / {String(n).padStart(2, '0')}
        </Mono>
      </div>
      <div style={{ position: 'absolute', left: RX, top: VH - 40, width: RW, height: 2, background: alpha(T.ink, 0.1) }} />
      <div style={{ position: 'absolute', left: RX, top: VH - 40, width: RW * clamp(f / JOURNEY_FRAMES), height: 2, background: T.accent }} />
      {plan.map((q, k) => (
        <div
          key={k}
          style={{
            position: 'absolute',
            left: RX + RW * (q.from / JOURNEY_FRAMES) - 4,
            top: VH - 44,
            width: 8,
            height: 10,
            borderRadius: 2,
            background: k < i ? T.accent : k === i ? T.ink : alpha(T.ink, 0.18),
            transform: k === i ? `scaleY(${1 + prog * 0.6})` : undefined,
          }}
        />
      ))}
    </AbsoluteFill>
  );
};

export const JourneyFilm: React.FC<{ content: FilmContent }> = ({ content }) => {
  const f = useCurrentFrame();
  const T = makeTokens(content.brand);
  const plan = planStations(content);
  const cam = cameraAt(plan, f);
  const route = plan.map((q) => q.st.slate ?? q.st.kind);
  const url = (content.cta_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  let cur = 0;
  for (let j = 0; j < plan.length; j++) if (f >= plan[j].from) cur = j;
  const near = plan.map((_, k) => k).filter((k) => Math.abs(k - cur) <= 1);
  const G = 60;
  const gx = Math.round(cam.x / G) * G;
  const gy = Math.round(cam.y / G) * G;
  return (
    <AbsoluteFill style={{ background: T.ground, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: VW / 2,
          top: VH / 2,
          width: 0,
          height: 0,
          transformOrigin: '0 0',
          transform: `perspective(2600px) rotateX(${cam.tilt}deg) rotateY(${cam.yaw}deg) rotateZ(${cam.rz}deg) scale(${cam.s}) translate(${-cam.x}px, ${-cam.y}px)`,
        }}
      >
        {}
        <div
          style={{
            position: 'absolute',
            left: gx - 4800,
            top: gy - 3200,
            width: 9600,
            height: 6400,
            backgroundImage: `radial-gradient(${alpha(T.ink, 0.13)} 2.2px, transparent 2.6px)`,
            backgroundSize: `${G}px ${G}px`,
            WebkitMaskImage: 'radial-gradient(ellipse at center, #000 30%, transparent 70%)',
            maskImage: 'radial-gradient(ellipse at center, #000 30%, transparent 70%)',
          }}
        />
        {near.slice(0, -1).map((k) => (k + 1 < plan.length ? <Thread key={`t${k}`} a={plan[k]} b={plan[k + 1]} f={f} T={T} /> : null))}
        {near.map((k) => {
          const p = plan[k];
          const Comp = STATION_COMPONENTS[p.st.kind] as React.FC<{ s: Station; f: number; dur: number; T: Tokens; name: string; route: string[] }>;
          return (
            <div
              key={k}
              style={{
                position: 'absolute',
                left: p.cx - VW / 2,
                top: p.cy - VH / 2,
                width: VW,
                height: VH,
                transform: `rotate(${p.rot}deg)`,
              }}
            >
              <div style={{ position: 'absolute', inset: 0, borderRadius: 18, border: `1.5px solid ${alpha(T.ink, 0.07)}` }} />
              <Comp s={p.st} f={f - p.from} dur={p.dur} T={T} name={content.product_name} route={route} />
            </div>
          );
        })}
      </div>
      <Hud plan={plan} f={f} T={T} name={content.product_name} url={url} />
    </AbsoluteFill>
  );
};
