import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, Easing } from 'remotion';
import { serifFamily, groteskFamily, monoFamily } from '../../fonts';

export const SANS = groteskFamily;
export const MONO = monoFamily;
export const SERIF = serifFamily;

export const C = {
  paper: '#F7F6F3',
  ink: '#141310',
  soft: '#39362F',
  muted: '#8A8478',
  faint: '#B6B0A3',
  rule: '#E3DFD3',
  card: '#FFFFFF',
  sunk: '#F3F1EA',
  good: '#2F8B5B',
  warn: '#C08A14',
  star: '#E8A80B',
};

const EASE = Easing.bezier(0.22, 0.61, 0.36, 1);

export const ez = (f: number, a: number, b: number): number =>
  interpolate(f, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE });

export const win = (f: number, a: number, b: number, c: number, d: number): number =>
  Math.max(0, Math.min(ez(f, a, b), 1 - ez(f, c, d)));

export const br = (f: number, seed: number, amp = 1, period = 96): number =>
  Math.sin((f + seed * 17) / (period / (2 * Math.PI))) * amp;

export const across = (f: number, dur: number, a: number, b: number): number =>
  a + (b - a) * Math.min(Math.max(f / Math.max(dur, 1), 0), 1);

export const Ground: React.FC<{ f: number }> = ({ f }) => {
  const ax = 22 + br(f, 1, 7, 620);
  const ay = 24 + br(f, 4, 6, 540);
  const bx = 80 + br(f, 9, 8, 700);
  const by = 70 + br(f, 2, 7, 660);
  const cx = 52 + br(f, 6, 10, 800);
  const cy = 96 + br(f, 11, 5, 580);
  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <AbsoluteFill style={{ background: `radial-gradient(1500px 1080px at ${ax}% ${ay}%, #E7EFF8 0%, rgba(231,239,248,0) 66%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(1300px 980px at ${bx}% ${by}%, #F6EFE1 0%, rgba(246,239,225,0) 62%)` }} />
      <AbsoluteFill style={{ background: `radial-gradient(1200px 900px at ${cx}% ${cy}%, #EBF3EC 0%, rgba(235,243,236,0) 60%)` }} />
    </AbsoluteFill>
  );
};

export const Zavi: React.FC<{ pose?: string; size: number; o?: number; rot?: number }> = ({
  pose = 'front-512',
  size,
  o = 1,
  rot = 0,
}) => (
  <Img
    src={staticFile(`mascot/zavi-${pose}.png`)}
    style={{ width: size, height: size, objectFit: 'contain', display: 'block', flex: 'none', opacity: o, transform: `rotate(${rot}deg)` }}
  />
);

export const Pill: React.FC<{
  label: string;
  f: number;
  seed?: number;
  o?: number;
  mark?: { src: string; hex: string };
  size?: number;
}> = ({ label, f, seed = 0, o = 1, mark, size = 26 }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 12,
      opacity: o,
      background: C.card,
      border: `1px solid ${C.rule}`,
      borderRadius: 999,
      padding: mark ? '12px 26px 12px 14px' : '12px 26px',
      boxShadow: '0 12px 34px rgba(30,26,18,0.08)',
      transform: `translateY(${br(f, seed, 3, 150)}px)`,
      whiteSpace: 'nowrap',
    }}
  >
    {mark ? (
      <Img src={mark.src} style={{ width: size, height: size, objectFit: 'contain', display: 'block', flex: 'none' }} />
    ) : (
      <span style={{ width: 10, height: 10, borderRadius: 99, background: C.good, opacity: 0.5 + 0.5 * (0.5 + 0.5 * br(f, seed + 3, 1, 44)), flex: 'none' }} />
    )}
    <span style={{ fontFamily: SANS, fontSize: 27, fontWeight: 640, color: C.ink }}>{label}</span>
  </div>
);

export const Card: React.FC<{
  w?: number;
  o?: number;
  dx?: number;
  dy?: number;
  scale?: number;
  children?: React.ReactNode;
}> = ({ w = 660, o = 1, dx = 0, dy = 0, scale = 1, children }) => (
  <div
    style={{
      width: w,
      background: C.card,
      border: `1px solid ${C.rule}`,
      borderRadius: 22,
      boxShadow: '0 30px 70px rgba(32,28,18,0.10), 0 4px 12px rgba(32,28,18,0.05)',
      opacity: o,
      transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
      overflow: 'hidden',
    }}
  >
    {children}
  </div>
);

export const CardHead: React.FC<{ word: string; right?: string }> = ({ word, right }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '16px 22px',
      borderBottom: `1px solid ${C.rule}`,
      background: C.sunk,
    }}
  >
    <span style={{ fontFamily: MONO, fontSize: 17, letterSpacing: 2.2, color: C.muted, textTransform: 'uppercase' }}>
      {word}
    </span>
    {right ? (
      <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 16, color: C.faint }}>{right}</span>
    ) : null}
  </div>
);

export const Big: React.FC<{
  children: React.ReactNode;
  size?: number;
  color?: string;
  o?: number;
  dy?: number;
  ls?: number;
  weight?: number;
}> = ({ children, size = 96, color = C.ink, o = 1, dy = 0, ls = -2.6, weight = 600 }) => (
  <div
    style={{
      fontFamily: SERIF,
      fontWeight: weight,
      fontSize: size,
      lineHeight: 1.04,
      letterSpacing: ls,
      color,
      opacity: o,
      transform: `translateY(${dy}px)`,
    }}
  >
    {children}
  </div>
);

export const Label: React.FC<{ children: React.ReactNode; c?: string }> = ({ children, c = C.muted }) => (
  <div style={{ fontFamily: MONO, fontSize: 17, letterSpacing: 2.6, textTransform: 'uppercase', color: c }}>
    {children}
  </div>
);

export const Illustrative: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      right: 58,
      bottom: 46,
      fontFamily: MONO,
      fontSize: 14,
      letterSpacing: 3,
      color: C.faint,
    }}
  >
    ILLUSTRATIVE
  </div>
);
