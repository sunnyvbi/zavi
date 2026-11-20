import React from 'react';
import { Easing, interpolate } from 'remotion';
import { serifFamily, monoFamily, groteskFamily } from '../../fonts';

export const SERIF = serifFamily;
export const MONO = monoFamily;
export const SANS = groteskFamily;

export const VW = 1920;
export const VH = 1080;

const hexToRgb = (h: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return [224, 69, 123];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export const mix = (a: string, b: string, t: number): string => {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
};
export const alpha = (h: string, a: number): string => {
  const [r, g, b] = hexToRgb(h);
  return `rgba(${r},${g},${b},${a})`;
};
const lum = (h: string) => {
  const [r, g, b] = hexToRgb(h);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

export type Tokens = {
  accent: string;
  accentInk: string;
  wash: string;
  ground: string;
  card: string;
  ink: string;
  ink2: string;
  faint: string;
  rule: string;
  green: string;
  amber: string;
  red: string;
};

export function makeTokens(brand?: { accent?: string; ground?: string; ink?: string }): Tokens {
  const accent = brand?.accent && /^#[0-9a-f]{6}$/i.test(brand.accent) ? brand.accent : '#E0457B';
  const groundIn = brand?.ground && /^#[0-9a-f]{6}$/i.test(brand.ground) ? brand.ground : '#FBF7F1';
  const ground = lum(groundIn) > 0.85 ? groundIn : '#FBF7F1';
  const ink = brand?.ink && /^#[0-9a-f]{6}$/i.test(brand.ink) && lum(brand.ink) < 0.25 ? brand.ink : '#1D1A17';
  let accentInk = accent;
  for (let i = 0; i < 6 && lum(accentInk) > 0.42; i++) accentInk = mix(accentInk, '#000000', 0.16);
  return {
    accent,
    accentInk,
    wash: mix(accent, ground, 0.86),
    ground,
    card: '#FFFFFF',
    ink,
    ink2: mix(ink, ground, 0.38),
    faint: mix(ink, ground, 0.66),
    rule: mix(ink, ground, 0.86),
    green: '#2E8B57',
    amber: '#C9821B',
    red: '#CC3F35',
  };
}

export const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const EO = Easing.bezier(0.16, 0.84, 0.28, 1);
export const EIO = Easing.bezier(0.6, 0, 0.25, 1);

export const ez = (f: number, a: number, b: number): number =>
  interpolate(f, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EO });

export const land = (f: number, i: number, start = -6): number => ez(f, start + i * 1.5, start + 9 + i * 1.5);

export const pop = (f: number, i: number, start = -6): number => {
  const t = clamp((f - (start + i * 1.5)) / 14);
  if (t <= 0) return 0;
  return 1 + Math.sin(t * Math.PI * 1.15) * 0.12 * (1 - t) - Math.pow(1 - t, 3);
};

export const br = (f: number, seed: number, amp = 1, period = 40) => Math.sin((f + seed * 13.7) / (period / (2 * Math.PI))) * amp;

export const across = (f: number, dur: number, a: number, b: number) => a + (b - a) * clamp(f / Math.max(1, dur));

export function countStr(s: string, t: number): string {
  if (t >= 1) return s;
  return s.replace(/\d+(?:\.\d+)?/g, (m) => {
    const n = parseFloat(m);
    const dec = m.includes('.') ? m.split('.')[1].length : 0;
    return (n * clamp(t)).toFixed(dec);
  });
}

export const NUM_CAP = 100000;
export const numbersIn = (s: string): number[] =>
  (String(s ?? '').match(/\d+(?:\.\d+)?/g) ?? [])
    .slice(0, 8)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.min(n, NUM_CAP));

export const safeCount = (n: unknown, lo: number, hi: number, fallback: number): number => {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(v)));
};

export const Mono: React.FC<{ c: string; s?: number; ls?: number; w?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({
  c,
  s = 16,
  ls = 2.4,
  w = 500,
  children,
  style,
}) => (
  <div style={{ fontFamily: MONO, fontSize: s, letterSpacing: ls, fontWeight: w, color: c, textTransform: 'uppercase', ...style }}>{children}</div>
);

export const Serif: React.FC<{ c: string; s: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ c, s, children, style }) => (
  <div style={{ fontFamily: SERIF, fontSize: s, fontWeight: 600, letterSpacing: -s * 0.025, lineHeight: 1.04, color: c, ...style }}>{children}</div>
);

export const Sans: React.FC<{ c: string; s: number; w?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ c, s, w = 500, children, style }) => (
  <div style={{ fontFamily: SANS, fontSize: s, fontWeight: w, lineHeight: 1.25, color: c, ...style }}>{children}</div>
);

export const card = (T: Tokens, extra: React.CSSProperties = {}): React.CSSProperties => ({
  background: T.card,
  borderRadius: 12,
  border: `1px solid ${T.rule}`,
  boxShadow: `0 22px 60px ${alpha(T.ink, 0.08)}, 0 2px 6px ${alpha(T.ink, 0.05)}`,
  ...extra,
});
