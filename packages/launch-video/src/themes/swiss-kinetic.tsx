import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, interpolate, Easing } from 'remotion';
import type { FilmContent } from './content';

export type { FilmContent };

export const FPS = 30;
const BEAT = 15;

const W = 1920;
const H = 1080;
const MX = 100;
const MY = 80;
const COLS = 12;
const ROWS = 8;
const GUT = 20;
const CW = (W - 2 * MX - (COLS - 1) * GUT) / COLS;
const RH = (H - 2 * MY - (ROWS - 1) * GUT) / ROWS;
const gx = (c: number) => MX + c * (CW + GUT);
const gy = (r: number) => MY + r * (RH + GUT);
const gw = (s: number) => s * CW + (s - 1) * GUT;
const gh = (s: number) => s * RH + (s - 1) * GUT;

const SANS = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

export type FilmTheme = {
  ink: string;
  paper: string;
  sub: string;
  accent: string;
  hair: string;
  rule: string;
  card: string;
  chip: string;
};

export const THEMES: Record<string, FilmTheme> = {
  swiss: {
    ink: '#0e0f11',
    paper: '#fbfbfa',
    sub: '#54585e',
    accent: '#8c3a1e',
    hair: 'rgba(14,15,17,0.07)',
    card: '#ffffff',
    chip: 'rgba(14,15,17,0.05)',
    rule: 'rgba(14,15,17,0.22)',
  },
  editorial: {
    ink: '#111014',
    paper: '#f7f4ee',
    sub: '#5b5750',
    accent: '#a23c1a',
    hair: 'rgba(17,16,20,0.07)',
    card: '#fffdf8',
    chip: 'rgba(17,16,20,0.05)',
    rule: 'rgba(17,16,20,0.22)',
  },
  neon: {
    ink: '#f2f4f8',
    paper: '#0b0d10',
    sub: '#98a1ad',
    accent: '#ff5a3c',
    hair: 'rgba(242,244,248,0.08)',
    card: '#141821',
    chip: 'rgba(242,244,248,0.07)',
    rule: 'rgba(242,244,248,0.22)',
  },
};

const HARD = Easing.bezier(0.86, 0, 0.12, 1);
const snap = (f: number, at: number, len = 5) =>
  interpolate(f, [at, at + len], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: HARD });

const drift = (f: number, dur: number, from: number, to: number) =>
  interpolate(f, [0, Math.max(dur, 1)], [from, to], { extrapolateLeft: 'clamp' });

const wipeX = (p: number) => ({ clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` });

const timecode = (f: number): string => {
  const total = Math.max(f, 0);
  const s = Math.floor(total / FPS);
  const fr = total % FPS;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
};

const Grid: React.FC<{ f: number; dur: number; t: FilmTheme }> = ({ f, dur, t }) => {
  const p = snap(f, 0, 8);
  const breath = 0.72 + 0.28 * Math.sin(f / 19);
  return (
    <svg width={W} height={H} style={{ position: 'absolute', inset: 0 }}>
      {Array.from({ length: COLS }, (_, c) => (
        <line
          key={`c${c}`}
          x1={gx(c)}
          x2={gx(c)}
          y1={MY}
          y2={MY + gh(ROWS) * p}
          stroke={t.hair}
          strokeWidth={1}
          opacity={breath}
        />
      ))}
      {Array.from({ length: ROWS }, (_, r) => (
        <line
          key={`r${r}`}
          x1={MX}
          x2={MX + gw(COLS) * p}
          y1={gy(r)}
          y2={gy(r)}
          stroke={t.hair}
          strokeWidth={1}
          opacity={breath}
        />
      ))}
      {}
      <line
        x1={MX}
        x2={MX + gw(COLS) * drift(f, dur, 0.06, 1)}
        y1={H - MY + 26}
        y2={H - MY + 26}
        stroke={t.accent}
        strokeWidth={2}
      />
    </svg>
  );
};

const Push: React.FC<{ f: number; dur: number; children: React.ReactNode }> = ({ f, dur, children }) => (
  <AbsoluteFill
    style={{
      transform: `translate3d(${drift(f, dur, 40, -110)}px, ${drift(f, dur, 14, -14)}px, 0) scale(${drift(
        f,
        dur,
        1.004,
        1.05,
      )})`,
      transformOrigin: '18% 40%',
    }}
  >
    {children}
  </AbsoluteFill>
);

const Sweep: React.FC<{ f: number; dur: number; t: FilmTheme }> = ({ f, dur, t }) => (
  <AbsoluteFill style={{ overflow: 'hidden', pointerEvents: 'none' }}>
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: `${drift(f, dur, -26, 112)}%`,
        height: 260,
        background: `linear-gradient(180deg, transparent, ${t.accent}14, transparent)`,
      }}
    />
  </AbsoluteFill>
);

const Chrome: React.FC<{ f: number; label: string; name: string; t: FilmTheme; elapsed: number }> = ({
  f,
  label,
  name,
  t,
  elapsed,
}) => (
  <>
    <div
      style={{
        position: 'absolute',
        left: MX,
        top: 38,
        fontFamily: MONO,
        fontSize: 15,
        letterSpacing: 2.6,
        color: t.sub,
        ...wipeX(snap(f, 2, 6)),
      }}
    >
      {label.toUpperCase()}
    </div>
    <div
      style={{
        position: 'absolute',
        right: MX,
        top: 38,
        fontFamily: MONO,
        fontSize: 15,
        letterSpacing: 2.6,
        color: t.sub,
        display: 'flex',
        gap: 18,
      }}
    >
      <span>{name.toUpperCase()}</span>
      <span style={{ color: t.accent }}>{timecode(elapsed)}</span>
    </div>
  </>
);

const Eyebrow: React.FC<{ children: React.ReactNode; t: FilmTheme; f: number; at: number }> = ({
  children,
  t,
  f,
  at,
}) => (
  <div
    style={{
      fontFamily: MONO,
      fontSize: 14,
      letterSpacing: 3,
      color: t.accent,
      marginBottom: 14,
      ...wipeX(snap(f, at, 5)),
    }}
  >
    {String(children).toUpperCase()}
  </div>
);

const Panel: React.FC<{
  x: number; y: number; w: number; h?: number; t: FilmTheme; f: number; at: number;
  accent?: boolean; children: React.ReactNode;
}> = ({ x, y, w, h, t, f, at, accent, children }) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: w,
      ...(h ? { height: h } : {}),
      background: t.card,
      border: `1.5px solid ${accent ? t.accent : t.rule}`,
      borderRadius: 16,
      padding: '20px 24px',
      boxSizing: 'border-box',
      boxShadow: accent
        ? `0 26px 54px -34px ${t.accent}`
        : `0 18px 42px -34px rgba(0,0,0,0.55)`,
      transform: `translateY(${(1 - snap(f, at, 6)) * 22}px)`,
      opacity: snap(f, at, 6),
    }}
  >
    {children}
  </div>
);

const Chip: React.FC<{ children: React.ReactNode; t: FilmTheme; live?: number }> = ({ children, t, live = 0 }) => (
  <span
    style={{
      fontFamily: MONO,
      fontSize: 13,
      color: t.sub,
      background: t.chip,
      border: `1px solid ${t.rule}`,
      borderRadius: 999,
      padding: '5px 12px',
      whiteSpace: 'nowrap',
      opacity: 0.78 + 0.22 * Math.sin(live / 15),
    }}
  >
    {children}
  </span>
);

const Disc: React.FC<{ n: number; t: FilmTheme; f: number; at: number }> = ({ n, t, f, at }) => (
  <span
    style={{
      display: 'grid',
      placeItems: 'center',
      width: 38,
      height: 38,
      borderRadius: 999,
      border: `2px solid ${t.accent}`,
      color: t.accent,
      fontFamily: MONO,
      fontSize: 15,
      fontWeight: 700,
      transform: `scale(${0.7 + 0.3 * snap(f, at, 7)}) rotate(${(1 - snap(f, at, 10)) * -22}deg)`,
    }}
  >
    {String(n).padStart(2, '0')}
  </span>
);

const Phone: React.FC<{ x: number; y: number; h: number; t: FilmTheme; f: number; dur: number; children: React.ReactNode }> = ({
  x, y, h, t, f, dur, children,
}) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: h * 0.49,
      height: h,
      borderRadius: 44,
      background: t.card,
      border: `2px solid ${t.rule}`,
      boxShadow: `0 40px 90px -50px rgba(0,0,0,0.75)`,
      padding: 16,
      boxSizing: 'border-box',
      transform: `translateY(${drift(f, dur, 10, -14)}px)`,
      opacity: snap(f, 6, 8),
    }}
  >
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: 14,
        width: 86,
        height: 6,
        borderRadius: 99,
        background: t.rule,
        transform: 'translateX(-50%)',
      }}
    />
    <div style={{ marginTop: 30, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
  </div>
);

const Bar: React.FC<{ t: FilmTheme; f: number; dur: number; to: number; delay?: number }> = ({ t, f, dur, to, delay = 0 }) => (
  <div style={{ height: 8, borderRadius: 99, background: t.chip, overflow: 'hidden' }}>
    <div
      style={{
        height: 8,
        borderRadius: 99,
        background: t.accent,
        width: `${drift(Math.max(f - delay, 0), dur, 4, to)}%`,
      }}
    />
  </div>
);

type ShotProps = { f: number; dur: number; t: FilmTheme; c: FilmContent };

const Hook: React.FC<ShotProps> = ({ f, dur, t, c }) => (
  <>
    <div style={{ position: 'absolute', left: gx(0), top: 230, width: gw(7) }}>
      <Eyebrow t={t} f={f} at={BEAT}>
        {c.product_name}
      </Eyebrow>
      <div
        style={{
          fontFamily: SANS,
          fontSize: 74,
          fontWeight: 820,
          lineHeight: 1.04,
          letterSpacing: -2.2,
          color: t.ink,
          ...wipeX(snap(f, BEAT + 3, 6)),
        }}
      >
        {c.one_liner}
      </div>
    </div>
    {}
    <Panel x={gx(7.6)} y={230} w={gw(4.4)} t={t} f={f} at={BEAT + 8} accent>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontFamily: SANS, fontSize: 64, fontWeight: 820, color: t.ink, letterSpacing: -2 }}>
          {c.features.length}
        </span>
        <span style={{ fontFamily: SANS, fontSize: 19, color: t.sub }}>things it does</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 18 }}>
        {c.features.slice(0, 3).map((feat, i) => (
          <Chip key={i} t={t} live={f + i * 13}>
            {feat.title}
          </Chip>
        ))}
      </div>
      <div style={{ marginTop: 20 }}>
        <Bar t={t} f={f} dur={dur} to={100} />
      </div>
    </Panel>
  </>
);

const Problem: React.FC<ShotProps> = ({ f, dur, t, c }) => (
  <div style={{ position: 'absolute', left: gx(0), top: gy(2), width: gw(9) }}>
    <Eyebrow t={t} f={f} at={4}>
      Today
    </Eyebrow>
    <div
      style={{
        fontFamily: SANS,
        fontSize: 60,
        fontWeight: 700,
        lineHeight: 1.12,
        letterSpacing: -1.2,
        color: t.ink,
        ...wipeX(snap(f, 8, 6)),
      }}
    >
      {c.problem}
    </div>
    {}
    <div style={{ height: 2, marginTop: 26, background: t.accent, width: `${drift(f, dur, 2, 96)}%` }} />
  </div>
);

const Surface: React.FC<ShotProps> = ({ f, dur, t, c }) => {
  const items = c.surface?.items ?? [];
  return (
    <>
      <div style={{ position: 'absolute', left: gx(0), top: 210, width: gw(5) }}>
        <Eyebrow t={t} f={f} at={4}>
          What you do with it
        </Eyebrow>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 52,
            fontWeight: 760,
            letterSpacing: -1.2,
            color: t.ink,
            lineHeight: 1.08,
            ...wipeX(snap(f, 8, 6)),
          }}
        >
          {c.surface?.title}
        </div>
      </div>

      {}
      <Phone x={gx(5)} y={120} h={840} t={t} f={f} dur={dur}>
        {items.slice(0, 4).map((item, i) => (
          <div
            key={i}
            style={{
              background: t.chip,
              borderRadius: 14,
              padding: '14px 16px',
              opacity: snap(f, 14 + i * 7, 6),
              transform: `translateX(${(1 - snap(f, 14 + i * 7, 6)) * 18}px)`,
            }}
          >
            <div style={{ fontFamily: SANS, fontSize: 19, fontWeight: 640, color: t.ink }}>{item.title}</div>
            <div style={{ display: 'flex', gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
              {item.chips.slice(0, 2).map((chip, j) => (
                <Chip key={j} t={t} live={f + i * 11 + j * 7}>
                  {chip}
                </Chip>
              ))}
            </div>
          </div>
        ))}
      </Phone>

      {}
      {items.slice(0, 4).map((item, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: gx(8.4),
            top: 210 + i * 150,
            width: gw(3.4),
            display: 'flex',
            gap: 14,
            alignItems: 'flex-start',
            opacity: snap(f, 20 + i * 7, 6),
          }}
        >
          <Disc n={i + 1} t={t} f={f} at={20 + i * 7} />
          <div>
            <div style={{ fontFamily: SANS, fontSize: 21, fontWeight: 640, color: t.ink }}>{item.title}</div>
            <div style={{ marginTop: 10, width: gw(2.4) }}>
              <Bar t={t} f={f} dur={dur} to={100 - i * 9} delay={i * 6} />
            </div>
          </div>
        </div>
      ))}
    </>
  );
};

const Wall: React.FC<ShotProps> = ({ f, dur, t, c }) => (
  <>
    <div style={{ position: 'absolute', left: gx(0), top: 96, width: gw(6) }}>
      <Eyebrow t={t} f={f} at={4}>
        Everything it does
      </Eyebrow>
    </div>
    {c.features.slice(0, 6).map((feat, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      return (
        <Panel
          key={i}
          x={gx(col * 4)}
          y={186 + row * 350}
          w={gw(3.6)}
          h={300}
          t={t}
          f={f}
          at={6 + i * 5}
          accent={i === 1}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Disc n={i + 1} t={t} f={f} at={8 + i * 5} />
            <div style={{ fontFamily: SANS, fontSize: 23, fontWeight: 680, color: t.ink, lineHeight: 1.18 }}>
              {feat.title}
            </div>
          </div>
          <div style={{ fontFamily: SANS, fontSize: 16, color: t.sub, marginTop: 14, lineHeight: 1.45 }}>
            {feat.detail}
          </div>
          {}
          <div style={{ position: 'absolute', left: 24, right: 24, bottom: 20 }}>
            <Bar t={t} f={f} dur={dur} to={100 - i * 6} delay={i * 4} />
          </div>
        </Panel>
      );
    })}
  </>
);

const Feature: React.FC<ShotProps & { index: number }> = ({ f, dur, t, c, index }) => {
  const feat = c.features[index % Math.max(c.features.length, 1)];
  if (!feat) return null;
  return (
    <>
      <div style={{ position: 'absolute', left: gx(0), top: 190, width: gw(6.6), display: 'flex', gap: 18 }}>
        <Disc n={index + 1} t={t} f={f} at={4} />
        <div>
          <div
            style={{
              fontFamily: SANS,
              fontSize: 58,
              fontWeight: 760,
              lineHeight: 1.06,
              letterSpacing: -1.4,
              color: t.ink,
              ...wipeX(snap(f, 6, 6)),
            }}
          >
            {feat.title}
          </div>
          <div
            style={{
              fontFamily: SANS,
              fontSize: 21,
              color: t.sub,
              marginTop: 16,
              lineHeight: 1.45,
              ...wipeX(snap(f, BEAT, 6)),
            }}
          >
            {feat.detail}
          </div>
        </div>
      </div>

      {}
      <Panel x={gx(7.4)} y={150} w={gw(4.6)} h={700} t={t} f={f} at={8}>
        <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: 2.2, color: t.sub }}>
          {c.product_name.toUpperCase()}
        </div>
        <div style={{ height: 640, overflow: 'hidden', marginTop: 14 }}>
          <div style={{ transform: `translateY(${-drift(f, dur, 0, 42)}%)` }}>
            {[...c.features, ...c.features].map((other, i) => {
              const isThis = other.title === feat.title;
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '14px 12px',
                    borderRadius: 10,
                    background: isThis ? t.chip : 'transparent',
                    borderBottom: `1px solid ${t.hair}`,
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 999,
                      background: isThis ? t.accent : t.rule,
                      opacity: isThis ? 0.4 + 0.6 * Math.abs(Math.sin(f / 13)) : 0.5,
                      flex: 'none',
                    }}
                  />
                  <span
                    style={{
                      fontFamily: SANS,
                      fontSize: 17,
                      fontWeight: isThis ? 680 : 500,
                      color: isThis ? t.ink : t.sub,
                    }}
                  >
                    {other.title}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </Panel>
    </>
  );
};

const Numbers: React.FC<ShotProps> = ({ f, dur, t, c }) => (
  <>
    <div style={{ position: 'absolute', left: gx(0), top: 140, width: gw(6) }}>
      <Eyebrow t={t} f={f} at={4}>
        What it has done
      </Eyebrow>
    </div>
    {(c.metrics ?? []).slice(0, 3).map((m, i) => (
      <Panel key={i} x={gx(i * 4)} y={250} w={gw(3.6)} h={330} t={t} f={f} at={6 + i * 6} accent={i === 0}>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 82,
            fontWeight: 820,
            letterSpacing: -3,
            color: t.ink,
            lineHeight: 1,
          }}
        >
          {m.stat}
        </div>
        <div style={{ fontFamily: SANS, fontSize: 18, color: t.sub, marginTop: 14, lineHeight: 1.35 }}>{m.label}</div>
        <div style={{ position: 'absolute', left: 24, right: 24, bottom: 24 }}>
          {}
          <Bar t={t} f={f} dur={dur} to={94} delay={i * 6} />
        </div>
      </Panel>
    ))}
  </>
);

const Coverage: React.FC<ShotProps> = ({ f, dur, t, c }) => {
  const places = (c.regions ?? []).slice(0, 8);
  const cx = 1290;
  const cy = 540;
  const R = 300;
  return (
    <>
      <div style={{ position: 'absolute', left: gx(0), top: 300, width: gw(5) }}>
        <Eyebrow t={t} f={f} at={4}>
          Where it works
        </Eyebrow>
        <div style={{ fontFamily: SANS, fontSize: 92, fontWeight: 820, letterSpacing: -3, color: t.ink }}>
          {places.length}
        </div>
        <div style={{ fontFamily: SANS, fontSize: 20, color: t.sub, marginTop: 8 }}>places it operates</div>
      </div>

      {}
      <svg width={W} height={H} style={{ position: 'absolute', inset: 0 }}>
        <circle cx={cx} cy={cy} r={R} fill="none" stroke={t.rule} strokeWidth={1.5} opacity={0.5} />
        <circle cx={cx} cy={cy} r={R * 0.62} fill="none" stroke={t.hair} strokeWidth={1} />
      </svg>
      {places.map((place, i) => {
        const a = (i / Math.max(places.length, 1)) * Math.PI * 2 + drift(f, dur, 0, 0.5);
        const x = cx + Math.cos(a) * R;
        const y = cy + Math.sin(a) * R;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              transform: 'translate(-50%, -50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              opacity: snap(f, 6 + i * 4, 6),
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 999,
                background: t.accent,
                opacity: 0.35 + 0.65 * Math.abs(Math.sin((f + i * 11) / 14)),
              }}
            />
            <span style={{ fontFamily: SANS, fontSize: 25, fontWeight: 640, color: t.ink, whiteSpace: 'nowrap' }}>
              {place}
            </span>
          </div>
        );
      })}
    </>
  );
};

const Close: React.FC<ShotProps> = ({ f, dur, t, c }) => (
  <>
    <div style={{ position: 'absolute', left: gx(0), top: 300, width: gw(8) }}>
      <div
        style={{
          fontFamily: SANS,
          fontSize: 104,
          fontWeight: 840,
          letterSpacing: -3.4,
          color: t.ink,
          ...wipeX(snap(f, 4, 6)),
        }}
      >
        {c.cta_text}
      </div>
      {}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 14,
          marginTop: 30,
          background: t.accent,
          color: t.paper,
          borderRadius: 14,
          padding: '18px 28px',
          fontFamily: MONO,
          fontSize: 24,
          boxShadow: `0 24px 50px -30px ${t.accent}`,
          transform: `translateY(${(1 - snap(f, BEAT, 7)) * 16}px) scale(${0.96 + 0.04 * snap(f, BEAT, 7)})`,
          opacity: snap(f, BEAT, 7),
        }}
      >
        {c.cta_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: t.paper,
            opacity: 0.35 + 0.65 * Math.abs(Math.sin(f / 12)),
          }}
        />
      </div>
    </div>
    <Panel x={gx(8.4)} y={280} w={gw(3.6)} t={t} f={f} at={10}>
      <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: 2.4, color: t.sub }}>
        {c.product_name.toUpperCase()}
      </div>
      <div style={{ fontFamily: SANS, fontSize: 22, color: t.ink, marginTop: 12, lineHeight: 1.35 }}>
        {c.one_liner}
      </div>
      <div style={{ marginTop: 20 }}>
        <Bar t={t} f={f} dur={dur} to={100} />
      </div>
    </Panel>
  </>
);

type Shot = { label: string; dur: number; render: React.FC<ShotProps> };

export function planShots(c: FilmContent): Shot[] {
  const shots: Shot[] = [{ label: 'Meet it', dur: BEAT * 9, render: Hook }];
  if (c.problem) shots.push({ label: 'The problem', dur: BEAT * 8, render: Problem });
  if (c.surface && c.surface.items.length > 0) shots.push({ label: 'In use', dur: BEAT * 10, render: Surface });
  if (c.features.length >= 3) shots.push({ label: 'What it does', dur: BEAT * 10, render: Wall });
  const solo = Math.min(c.features.length, 6);
  for (let i = 0; i < solo; i++) {
    const Bound: React.FC<ShotProps> = (p) => <Feature {...p} index={i} />;
    shots.push({ label: c.features[i]?.title ?? 'Feature', dur: BEAT * 7, render: Bound });
  }
  if ((c.metrics ?? []).length > 0) shots.push({ label: 'Numbers', dur: BEAT * 8, render: Numbers });
  if ((c.regions ?? []).length >= 2) shots.push({ label: 'Coverage', dur: BEAT * 7, render: Coverage });
  shots.push({ label: 'Start', dur: BEAT * 7, render: Close });

  const floor = 45 * FPS;
  const total = shots.reduce((sum, sh) => sum + sh.dur, 0);
  if (total < floor) {
    const extra = Math.ceil((floor - total) / BEAT / shots.length);
    for (const sh of shots) sh.dur += extra * BEAT;
  }
  return shots;
}

export const filmFrames = (c: FilmContent): number =>
  planShots(c).reduce((sum, s) => sum + s.dur, 0);

export const SwissKineticFilm: React.FC<{ content: FilmContent }> = ({ content }) => {
  const frame = useCurrentFrame();
  const t = THEMES[content.theme ?? 'swiss'] ?? THEMES.swiss;
  const shots = planShots(content);
  let at = 0;
  return (
    <AbsoluteFill style={{ background: t.paper }}>
      {shots.map((shot, i) => {
        const from = at;
        at += shot.dur;
        const local = frame - from;
        const Shot = shot.render;
        return (
          <Sequence key={i} from={from} durationInFrames={shot.dur}>
            <AbsoluteFill style={{ background: t.paper }}>
              <Grid f={local} dur={shot.dur} t={t} />
              <Sweep f={local} dur={shot.dur} t={t} />
              <Chrome f={local} label={shot.label} name={content.product_name} t={t} elapsed={frame} />
              <Push f={local} dur={shot.dur}>
                <Shot f={local} dur={shot.dur} t={t} c={content} />
              </Push>
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
