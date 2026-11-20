import React, { createContext, useContext } from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { MONO, SANS, SERIF } from '../r10/fonts';

export { MONO, SANS, SERIF };
export const W = 1920;
export const H = 1080;

export type Pal = {
  A: string;
  AI: string;
  AT: string;
  G: string;
  G2: string;
  CARD: string;
  INK: string;
  SOFT: string;
  MUTED: string;
  RULE: string;
  GOOD: string;
  WARN: string;
  BAD: string;
};

const hex = (h: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lum = (rgb: [number, number, number]) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const mix = (a: string, b: string, t: number) => {
  const x = hex(a) ?? [0, 0, 0];
  const y = hex(b) ?? [255, 255, 255];
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

export function makePal(brand?: { accent?: string; accent_ink?: string; ground?: string }): Pal {
  const A = brand?.accent && hex(brand.accent) ? brand.accent : '#3F5BD9';
  const g = brand?.ground && hex(brand.ground) && lum(hex(brand.ground)!) > 215 ? brand.ground : '#F6F4EF';
  const AI = brand?.accent_ink && hex(brand.accent_ink) ? brand.accent_ink : mix(A, '#000000', 0.32);
  return {
    A,
    AI,
    AT: mix(A, '#FFFFFF', 0.86),
    G: g,
    G2: mix(g, '#000000', 0.045),
    CARD: '#FFFFFF',
    INK: '#191919',
    SOFT: '#2E2C29',
    MUTED: '#76716A',
    RULE: '#DCD7CD',
    GOOD: '#16794C',
    WARN: '#B26B00',
    BAD: '#C62828',
  };
}

export const PalCtx = createContext<Pal>(makePal());
export const usePal = () => useContext(PalCtx);

const SOFT_E = Easing.bezier(0.22, 0.61, 0.36, 1);
const CAM_E = Easing.bezier(0.33, 0, 0.15, 1);
export const ez = (f: number, a: number, b: number) =>
  interpolate(f, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: SOFT_E });
export const fast = (f: number, i: number) => ez(f, i * 1.5, 8 + i * 1.5);
export const br = (f: number, seed: number, amp = 1, period = 40) =>
  Math.sin((f + seed * 13) / (period / (2 * Math.PI))) * amp;
export const drop = (f: number, at: number) => {
  const t = Math.max(0, f - at);
  if (t <= 0) return 0;
  return 1 - Math.exp(-t / 3.2) * Math.cos(t / 2.6);
};
export const typed = (f: number, t: string, at: number, per = 1) =>
  t.slice(0, Math.max(0, Math.round((f - at) / per)));
export const caret = (f: number) => (Math.floor(f / 8) % 2 === 0 ? '▌' : ' ');
export const lerp = (f: number, dur: number, a: number, b: number) =>
  a + (b - a) * Math.min(Math.max(f / Math.max(dur, 1), 0), 1);

export type Cam = { x: number; y: number; s: number };

export const Stage: React.FC<{
  dur: number;
  from?: Cam;
  to?: Cam;
  slate: string;
  bg?: string;
  children: React.ReactNode;
}> = ({ dur, from = { x: 960, y: 540, s: 1 }, to = { x: 960, y: 540, s: 1.035 }, slate, bg, children }) => {
  const f = useCurrentFrame();
  const P = usePal();
  const k = interpolate(f, [0, dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: CAM_E });
  const s = from.s + (to.s - from.s) * k;
  const hw = 960 / s, hh = 540 / s;
  const cl = (v: number, a: number, b: number) => (a > b ? (a + b) / 2 : Math.min(b, Math.max(a, v)));
  const x = cl(from.x + (to.x - from.x) * k, hw, 1920 - hw);
  const y = cl(from.y + (to.y - from.y) * k, hh, 1080 - hh);
  const fade = Math.max(2, Math.min(5, Math.round(dur * 0.06)));
  const o = Math.min(ez(f, 0, fade), 1 - ez(f, dur - fade, dur));
  return (
    <AbsoluteFill style={{ background: bg ?? P.G, fontFamily: SANS, color: P.INK, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute', left: 0, top: 0, width: W, height: H,
          background: `radial-gradient(1100px 700px at ${70 + br(f, 1, 6, 120)}% ${18 + br(f, 2, 5, 140)}%, ${P.AT}, transparent 70%)`,
          opacity: 0.85,
        }}
      />
      <div
        style={{
          position: 'absolute', left: 0, top: 0, width: W, height: H, opacity: o,
          transformOrigin: '0 0',
          transform: `translate(${960 - x * s}px, ${540 - y * s}px) scale(${s})`,
        }}
      >
        {children}
      </div>
      <div style={{ position: 'absolute', left: 44, top: 30, display: 'flex', alignItems: 'center', gap: 12, opacity: o }}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: P.A }} />
        <span style={{ fontFamily: MONO, fontSize: 14, letterSpacing: 1.6, textTransform: 'uppercase', color: P.SOFT, background: `${P.G}E6`, padding: '3px 6px', borderRadius: 4 }}>
          {slate}
        </span>
      </div>
    </AbsoluteFill>
  );
};

export const Mono: React.FC<{ children: React.ReactNode; s?: number; c?: string; ls?: number }> = ({ children, s = 14, c, ls = 1.4 }) => {
  const P = usePal();
  return (
    <span style={{ fontFamily: MONO, fontSize: Math.max(14, s * 1.12), letterSpacing: ls, textTransform: 'uppercase', color: c ?? P.MUTED, fontWeight: 500 }}>
      {children}
    </span>
  );
};

export const serif = (P: Pal, s = 72, c?: string): React.CSSProperties => ({
  fontFamily: SERIF, fontSize: s, fontWeight: 620, letterSpacing: -s * 0.025, lineHeight: 1.04, color: c ?? P.INK,
});

export const bullet = (P: Pal, s = 22, c?: string) => (
  <span style={{ width: s * 0.5, height: s * 0.5, borderRadius: 3, background: c ?? P.A, flex: 'none', display: 'inline-block' }} />
);

export const AppBar: React.FC<{ name: string; nav: string[]; active?: number; w?: number; at?: number }> = ({ name, nav, active = 0, w = 1640, at = 0 }) => {
  const f = useCurrentFrame();
  const P = usePal();
  return (
    <div style={{ width: w, height: 70, display: 'flex', alignItems: 'center', gap: 14, padding: '0 26px', background: P.CARD, borderBottom: `1px solid ${P.RULE}`, opacity: fast(f, at) }}>
      <span style={{ width: 30, height: 30, borderRadius: 8, background: P.A, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 17 }}>
        {name.slice(0, 1).toUpperCase()}
      </span>
      <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: -0.6, marginRight: 'auto' }}>{name}</span>
      {nav.slice(0, 5).map((n, i) => (
        <span key={n} style={{ fontSize: 16, fontWeight: 600, padding: '8px 14px', borderRadius: 8, border: `1px solid ${i === active ? P.INK : P.RULE}`, background: i === active ? P.INK : 'transparent', color: i === active ? '#fff' : P.SOFT }}>
          {n}
        </span>
      ))}
    </div>
  );
};

export const Pill: React.FC<{ t: string; at?: number; on?: boolean; s?: number; c?: string }> = ({ t, at = 0, on, s = 1, c }) => {
  const f = useCurrentFrame();
  const P = usePal();
  const g = ez(f, at, at + 8);
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8 * s, whiteSpace: 'nowrap',
        padding: `${8 * s}px ${15 * s}px`, borderRadius: 999, fontSize: 17 * s, fontWeight: 600,
        border: `1.5px solid ${on ? (c ?? P.A) : P.RULE}`, background: on ? (c ?? P.A) : P.CARD,
        color: on ? '#fff' : P.SOFT, opacity: g, transform: `translateY(${(1 - g) * 10}px)`,
      }}
    >
      {t}
    </span>
  );
};

export const Btn: React.FC<{ t: string; at?: number; press?: number; s?: number; ghost?: boolean; w?: number | string }> = ({ t, at = 0, press, s = 1, ghost, w }) => {
  const f = useCurrentFrame();
  const P = usePal();
  const g = ez(f, at, at + 8);
  const down = press !== undefined && f >= press - 2 && f <= press + 4 ? 0.95 : 1;
  const done = press !== undefined && f > press + 4;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10, width: w,
        padding: `${15 * s}px ${28 * s}px`, borderRadius: 12, fontSize: 20 * s, fontWeight: 700,
        background: ghost ? P.CARD : done ? P.A : P.INK, color: ghost ? P.INK : '#fff',
        border: `1.5px solid ${ghost ? P.RULE : done ? P.A : P.INK}`,
        opacity: g, transform: `scale(${down})`, boxShadow: ghost ? 'none' : '0 14px 30px -18px rgba(0,0,0,.55)',
      }}
    >
      {t}
    </span>
  );
};

export const Field: React.FC<{ label: string; value?: string; at?: number; open?: boolean; w?: number; s?: number }> = ({ label, value, at = 0, open, w = 300, s = 1 }) => {
  const f = useCurrentFrame();
  const P = usePal();
  const g = fast(f, at);
  return (
    <div style={{ width: w, opacity: g, transform: `translateY(${(1 - g) * 10}px)` }}>
      <Mono s={12 * s}>{label}</Mono>
      <div
        style={{
          marginTop: 7 * s, height: 58 * s, borderRadius: 12, border: `1.5px solid ${open ? P.A : P.RULE}`,
          background: P.CARD, display: 'flex', alignItems: 'center', padding: `0 ${16 * s}px`, gap: 10,
          fontSize: 20 * s, fontWeight: 600, color: value ? P.INK : P.MUTED,
          boxShadow: open ? `0 0 0 5px ${P.AT}` : 'none',
        }}
      >
        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value ?? label}</span>
        <span style={{ fontSize: 15 * s, color: P.MUTED, transform: `rotate(${open ? 180 : 0}deg)` }}>▼</span>
      </div>
    </div>
  );
};

export const Avatar: React.FC<{ t: string; s?: number; ring?: boolean }> = ({ t, s = 56, ring }) => {
  const P = usePal();
  return (
    <span
      style={{
        width: s, height: s, borderRadius: 999, flex: 'none', display: 'grid', placeItems: 'center',
        background: P.AT, color: P.AI, fontWeight: 800, fontSize: s * 0.42, fontFamily: SERIF,
        border: ring ? `3px solid ${P.A}` : `1.5px solid ${P.RULE}`,
      }}
    >
      {t.slice(0, 1).toUpperCase()}
    </span>
  );
};

export const Tick: React.FC<{ at: number; s?: number; c?: string }> = ({ at, s = 28, c }) => {
  const f = useCurrentFrame();
  const P = usePal();
  const k = ez(f, at, at + 9);
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" style={{ flex: 'none' }}>
      <circle cx={12} cy={12} r={11} fill={c ?? P.A} opacity={0.15 + 0.85 * k} />
      <path d="M6.5 12.5 L10.5 16.5 L17.5 8.5" fill="none" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={20} strokeDashoffset={20 * (1 - k)} />
    </svg>
  );
};

export const Cursor: React.FC<{ path: [number, number, number][]; clicks?: number[]; s?: number }> = ({ path, clicks = [], s = 1 }) => {
  const f = useCurrentFrame();
  const P = usePal();
  const fs = path.map((p) => p[2]);
  const x = interpolate(f, fs, path.map((p) => p[0]), { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: CAM_E });
  const y = interpolate(f, fs, path.map((p) => p[1]), { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: CAM_E });
  const hit = clicks.find((c) => f >= c && f < c + 16);
  const ring = hit === undefined ? 0 : ez(f, hit, hit + 16);
  const down = clicks.some((c) => f >= c - 2 && f <= c + 3) ? 0.86 : 1;
  return (
    <div style={{ position: 'absolute', left: x, top: y, zIndex: 50, pointerEvents: 'none' }}>
      {hit !== undefined ? (
        <span style={{ position: 'absolute', left: -40 * s, top: -40 * s, width: 80 * s, height: 80 * s, borderRadius: 99, border: `3px solid ${P.A}`, opacity: 1 - ring, transform: `scale(${0.3 + ring})` }} />
      ) : null}
      <svg width={30 * s} height={38 * s} viewBox="0 0 24 30" style={{ transform: `scale(${down})`, transformOrigin: '0 0', filter: 'drop-shadow(0 4px 7px rgba(0,0,0,.35))' }}>
        <path d="M3 2 L3 23 L8.5 18 L12 27 L16 25 L12.5 16.5 L20 16 Z" fill="#fff" stroke={P.INK} strokeWidth={1.7} strokeLinejoin="round" />
      </svg>
    </div>
  );
};

export const Phone: React.FC<{ x: number; y: number; h?: number; title: string; sub?: string; children: React.ReactNode; tilt?: number }> = ({ x, y, h = 860, title, sub, children, tilt = 0 }) => {
  const f = useCurrentFrame();
  const P = usePal();
  const g = fast(f, 0);
  const w = Math.round(h * 0.49);
  return (
    <div
      style={{
        position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: 52, background: P.CARD,
        border: `12px solid ${P.INK}`, overflow: 'hidden', boxShadow: '0 50px 90px -40px rgba(0,0,0,.5)',
        opacity: g, transform: `translateY(${(1 - g) * 30}px) rotate(${tilt + br(f, 4, 0.4, 70)}deg)`,
      }}
    >
      <div style={{ height: 96, background: P.G2, display: 'flex', alignItems: 'flex-end', gap: 12, padding: '0 20px 14px', borderBottom: `1px solid ${P.RULE}` }}>
        <Avatar t={title} s={46} />
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{title}</div>
          {sub ? <div style={{ fontSize: 14, color: P.MUTED }}>{sub}</div> : null}
        </div>
      </div>
      <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  );
};

export const Bubble: React.FC<{ me?: boolean; at: number; t: string; w?: number; s?: number; typing?: boolean }> = ({ me, at, t, w = 340, s = 19, typing }) => {
  const f = useCurrentFrame();
  const P = usePal();
  const g = ez(f, at, at + 8);
  return (
    <div style={{ display: 'flex', justifyContent: me ? 'flex-end' : 'flex-start', opacity: g, transform: `translateY(${(1 - g) * 14}px) scale(${0.96 + 0.04 * g})` }}>
      <div
        style={{
          maxWidth: w, padding: '11px 15px', borderRadius: 16, fontSize: s, lineHeight: 1.35, fontWeight: 500,
          background: me ? P.INK : P.CARD, color: me ? '#fff' : P.INK, border: me ? 'none' : `1.5px solid ${P.RULE}`,
          borderBottomRightRadius: me ? 4 : 16, borderBottomLeftRadius: me ? 16 : 4,
        }}
      >
        {typing ? (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            {[0, 1, 2].map((i) => (
              <span key={i} style={{ width: 9, height: 9, borderRadius: 9, background: P.MUTED, opacity: 0.35 + 0.65 * Math.abs(Math.sin((f + i * 6) / 7)) }} />
            ))}
          </span>
        ) : (
          t
        )}
      </div>
    </div>
  );
};

export const Clock: React.FC<{ r: number; hour: number; phase: 'morning' | 'evening'; spin: number }> = ({ r, hour, phase, spin }) => {
  const P = usePal();
  const d = r * 2;
  const hA = (hour / 12) * 360 + spin * 0.5;
  const mA = spin * 6;
  const sun = phase === 'morning';
  return (
    <svg width={d} height={d} viewBox={`0 0 ${d} ${d}`}>
      <circle cx={r} cy={r} r={r - 4} fill={sun ? '#FFF7E6' : '#EEF0FA'} stroke={P.INK} strokeWidth={4} />
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i / 12) * Math.PI * 2;
        const r1 = r - 16, r2 = r - (i % 3 === 0 ? 40 : 28);
        return <line key={i} x1={r + Math.sin(a) * r1} y1={r - Math.cos(a) * r1} x2={r + Math.sin(a) * r2} y2={r - Math.cos(a) * r2} stroke={P.INK} strokeWidth={i % 3 === 0 ? 5 : 2.5} strokeLinecap="round" />;
      })}
      <line x1={r} y1={r} x2={r + Math.sin((hA * Math.PI) / 180) * r * 0.48} y2={r - Math.cos((hA * Math.PI) / 180) * r * 0.48} stroke={P.INK} strokeWidth={9} strokeLinecap="round" />
      <line x1={r} y1={r} x2={r + Math.sin((mA * Math.PI) / 180) * r * 0.72} y2={r - Math.cos((mA * Math.PI) / 180) * r * 0.72} stroke={P.A} strokeWidth={5} strokeLinecap="round" />
      <circle cx={r} cy={r} r={9} fill={P.INK} />
      {sun ? (
        <circle cx={r} cy={r * 0.52} r={r * 0.09} fill="#F2A900" />
      ) : (
        <path d={`M ${r - r * 0.08} ${r * 0.44} a ${r * 0.1} ${r * 0.1} 0 1 0 ${r * 0.16} ${r * 0.16} a ${r * 0.08} ${r * 0.08} 0 1 1 ${-r * 0.16} ${-r * 0.16} Z`} fill="#4B5BA8" />
      )}
    </svg>
  );
};
