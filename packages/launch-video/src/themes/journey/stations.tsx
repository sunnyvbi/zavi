import React from 'react';
import type { Station } from './types';
import {
  Tokens,
  Mono,
  Serif,
  Sans,
  card,
  alpha,
  mix,
  ez,
  land,
  pop,
  br,
  across,
  clamp,
  countStr,
  numbersIn,
  safeCount,
  SERIF,
  SANS,
  MONO,
} from './kit';

type P<K extends Station['kind']> = { s: Extract<Station, { kind: K }>; f: number; dur: number; T: Tokens; name: string; route: string[] };

const Box: React.FC<{ x: number; y: number; w?: number; h?: number; style?: React.CSSProperties; children?: React.ReactNode }> = ({
  x,
  y,
  w,
  h,
  style,
  children,
}) => <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, ...style }}>{children}</div>;

const fit = (text: string, base: number, chars: number, min = base * 0.45) =>
  Math.max(min, Math.min(base, base * Math.sqrt(chars / Math.max(1, text.length))));

const rise = (t: number, px = 26): React.CSSProperties => ({ opacity: clamp(t * 1.4), transform: `translateY(${(1 - t) * px}px)` });

const Check: React.FC<{ c: string; t: number; size?: number }> = ({ c, t, size = 30 }) => (
  <svg width={size} height={size} viewBox="0 0 30 30" style={{ flex: 'none' }}>
    <circle cx={15} cy={15} r={14} fill={alpha(c, 0.12)} />
    <path d="M8 15.5 L13 20.5 L22 10" fill="none" stroke={c} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - clamp(t)} />
  </svg>
);

export const TitleStation: React.FC<P<'title'>> = ({ s, f, dur, T, name }) => {
  const chips = (s.chips ?? []).slice(0, 14);
  const cx = 1440;
  const cy = 520;
  const hs = fit(s.headline, 148, 18, 84);
  return (
    <>
      <Box x={120} y={190} w={1000}>
        <div style={rise(land(f, 0))}>
          <Mono c={T.accentInk} s={20} ls={3.2}>
            {s.kicker}
          </Mono>
        </div>
        <div style={{ marginTop: 28, clipPath: `inset(-20px ${100 - 100 * ez(f, -6, 12)}% -30px -10px)` }}>
          <Serif c={T.ink} s={hs} style={{ transform: `translateX(${across(f, dur, 0, -14)}px)` }}>
            {s.headline}
          </Serif>
        </div>
        {s.sub ? (
          <div style={{ marginTop: 36, ...rise(land(f, 3)) }}>
            <Sans c={T.ink2} s={34} w={400} style={{ maxWidth: 860 }}>
              {s.sub}
            </Sans>
          </div>
        ) : null}
      </Box>
      <Box x={120} y={880} w={1700} style={{ display: 'flex', gap: 22 }}>
        {(s.notes ?? []).slice(0, 3).map((n, i) => (
          <div key={i} style={{ ...card(T, { padding: '16px 22px', display: 'flex', alignItems: 'center', gap: 12 }), ...rise(land(f, 5 + i)) }}>
            <Check c={T.green} t={ez(f, 6 + i * 5, 18 + i * 5)} size={26} />
            <Sans c={T.ink} s={24}>
              {n}
            </Sans>
          </div>
        ))}
      </Box>
      {}
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        {[330, 215].map((r, k) => (
          <ellipse key={k} cx={cx} cy={cy} rx={r * 1.12} ry={r * 0.92} fill="none" stroke={T.rule} strokeWidth={2} strokeDasharray="4 10" opacity={ez(f, -6, 8)} />
        ))}
      </svg>
      {chips.map((c, i) => {
        const ring = i % 2;
        const r = ring ? 215 : 330;
        const n = ring ? Math.ceil(chips.length / 2) : Math.floor(chips.length / 2) || 1;
        const a = ((Math.floor(i / 2) / n) * Math.PI * 2 + (ring ? 0.4 : 0) + f * (ring ? -0.012 : 0.008)) % (Math.PI * 2);
        const x = cx + Math.cos(a) * r * 1.12;
        const y = cy + Math.sin(a) * r * 0.92;
        const t = pop(f, i * 0.6);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              transform: `translate(-50%,-50%) scale(${t})`,
              ...card(T, { padding: '9px 16px', borderRadius: 999 }),
              whiteSpace: 'nowrap',
              zIndex: Math.sin(a) > 0 ? 3 : 1,
            }}
          >
            <Sans c={T.ink} s={21}>
              {c}
            </Sans>
          </div>
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: cx,
          top: cy,
          width: 210,
          height: 210,
          borderRadius: 999,
          background: T.accent,
          transform: `translate(-50%,-50%) scale(${pop(f, 1) * (1 + br(f, 1, 0.025, 46))})`,
          boxShadow: `0 0 0 ${18 + br(f, 2, 10, 50)}px ${alpha(T.accent, 0.12)}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2,
        }}
      >
        <div style={{ fontFamily: SERIF, fontWeight: 700, fontSize: fit(name, 40, 10, 24), color: '#fff', textAlign: 'center', padding: 14, lineHeight: 1.05 }}>{name}</div>
      </div>
    </>
  );
};

export const NumeralStation: React.FC<P<'numeral'>> = ({ s, f, dur, T }) => {
  const nums = numbersIn(s.value);
  const hi = nums.length ? Math.max(...nums) : 100;
  const lo = nums.length ? Math.min(...nums) : 0;
  const span = safeCount(Math.ceil((hi * 1.3) / 10) * 10, 10, 400, 100);
  const RX = 220;
  const RW = 1480;
  const xOf = (v: number) => RX + (v / span) * RW;
  const ct = ez(f, -4, 26);
  const vs = fit(s.value, 330, 7, 170);
  const scan = across(f, dur, RX, RX + RW);
  return (
    <>
      <Box x={0} y={150} w={1920} style={{ textAlign: 'center', ...rise(land(f, 0)) }}>
        <Mono c={T.ink2} s={22} ls={4}>
          {s.label}
        </Mono>
      </Box>
      <Box x={0} y={210} w={1920} style={{ display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: 26 }}>
        <div
          style={{
            fontFamily: SERIF,
            fontWeight: 700,
            fontSize: vs,
            letterSpacing: -vs * 0.04,
            color: T.ink,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
            transform: `scale(${0.9 + 0.1 * pop(f, 0) + across(f, dur, 0, 0.03)})`,
          }}
        >
          {countStr(s.value, ct)}
        </div>
        {s.unit ? (
          <Sans c={T.accentInk} s={54} w={600} style={rise(land(f, 2))}>
            {s.unit}
          </Sans>
        ) : null}
      </Box>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        <line x1={RX} x2={RX + RW * ez(f, -6, 10)} y1={760} y2={760} stroke={T.ink} strokeWidth={3} />
        {Array.from({ length: span + 1 }).map((_, i) => {
          const major = i % (span > 120 ? Math.ceil(span / 12) : 10) === 0;
          return (
            <line key={i} x1={xOf(i)} x2={xOf(i)} y1={760} y2={760 + (major ? 26 : 12) * ez(f, -4 + i * 0.05, 8 + i * 0.05)} stroke={major ? T.ink2 : T.faint} strokeWidth={major ? 2 : 1} />
          );
        })}
        <rect x={xOf(lo)} y={700} width={Math.max(8, (xOf(hi) - xOf(lo)) * ez(f, 4, 24))} height={52} fill={T.accent} rx={4} />
        <rect x={scan - 2} y={690} width={4} height={110} fill={alpha(T.accent, 0.5)} />
        <rect x={RX} y={712} width={Math.max(0, scan - RX)} height={28} fill={alpha(T.accent, 0.08)} />
      </svg>
      <Box x={xOf(0) - 20} y={804} style={{ ...rise(land(f, 3)) }}>
        <Mono c={T.ink2} s={20}>
          0
        </Mono>
      </Box>
      {nums.slice(0, 2).map((n, i) => (
        <Box key={i} x={xOf(n) - 60} y={640} w={120} style={{ textAlign: 'center', ...rise(land(f, 4 + i)) }}>
          <Mono c={T.accentInk} s={24} w={700}>
            {String(n)}
          </Mono>
        </Box>
      ))}
      <Box x={RX} y={860} w={RW} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', ...rise(land(f, 6)) }}>
        <Mono c={T.faint} s={18} ls={2}>
          {s.source ?? ''}
        </Mono>
        <div style={{ display: 'flex', gap: 14 }}>
          {(s.notes ?? []).slice(0, 2).map((n, i) => (
            <div key={i} style={card(T, { padding: '12px 18px' })}>
              <Sans c={T.ink} s={22}>
                {n}
              </Sans>
            </div>
          ))}
        </div>
      </Box>
    </>
  );
};

export const VersusStation: React.FC<P<'versus'>> = ({ s, f, dur, T }) => {
  const L = numbersIn(s.left.value);
  const R = numbersIn(s.right.value);
  const top = Math.max(...L, ...R, 1);
  const BW = 1180;
  const col = (side: 'left' | 'right', x: number, hero: boolean) => {
    const d = s[side];
    return (
      <Box x={x} y={250} w={760} style={{ ...rise(land(f, hero ? 2 : 0)) }}>
        <div style={hero ? card(T, { padding: '30px 36px', border: `2px solid ${T.accent}` }) : { padding: '30px 36px' }}>
          <Mono c={hero ? T.accentInk : T.ink2} s={20} ls={3}>
            {d.label}
          </Mono>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
            <div style={{ fontFamily: SERIF, fontWeight: 700, fontSize: fit(d.value, 128, 8, 80), color: T.ink, letterSpacing: -3, lineHeight: 1.05, whiteSpace: 'nowrap' }}>
              {countStr(d.value, ez(f, -2, 24))}
            </div>
            {d.unit ? (
              <Sans c={T.ink2} s={28}>
                {d.unit}
              </Sans>
            ) : null}
          </div>
          {(d.notes ?? []).slice(0, 2).map((n, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, ...rise(land(f, 4 + i)) }}>
              <div style={{ width: 8, height: 8, borderRadius: 9, background: hero ? T.accent : T.faint }} />
              <Sans c={T.ink2} s={24} w={400}>
                {n}
              </Sans>
            </div>
          ))}
        </div>
      </Box>
    );
  };
  const bar = (vals: number[], y: number, label: string, hero: boolean, i: number) => {
    const lo = Math.min(...vals, top);
    const hi = vals.length ? Math.max(...vals) : 0;
    const g = ez(f, 2 + i * 4, 26 + i * 4);
    return (
      <>
        <Box x={120} y={y + 6} w={420} style={rise(land(f, 6 + i))}>
          <Sans c={T.ink} s={26} w={600}>
            {label}
          </Sans>
        </Box>
        <div style={{ position: 'absolute', left: 560, top: y, height: 46, width: BW, background: alpha(T.ink, 0.04), borderRadius: 6 }} />
        <div style={{ position: 'absolute', left: 560, top: y, height: 46, width: Math.max(10, (BW * Math.min(lo, hi)) / top) * g, background: hero ? T.accent : T.ink, borderRadius: 6 }} />
        {hi > lo ? (
          <div
            style={{
              position: 'absolute',
              left: 560 + (BW * lo) / top * g,
              top: y,
              height: 46,
              width: ((BW * (hi - lo)) / top) * g,
              background: hero ? alpha(T.accent, 0.5) : alpha(T.ink, 0.45),
              borderRadius: '0 6px 6px 0',
            }}
          />
        ) : null}
        <div
          style={{
            position: 'absolute',
            left: 560 + Math.max(10, (BW * hi) / top) * g + 16,
            top: y + 8,
            fontFamily: MONO,
            fontSize: 24,
            fontWeight: 700,
            color: hero ? T.accentInk : T.ink,
          }}
        >
          {countStr(s[hero ? 'right' : 'left'].value, g)}
        </div>
      </>
    );
  };
  return (
    <>
      <Box x={120} y={130} w={1700} style={rise(land(f, 0))}>
        <Serif c={T.ink} s={fit(s.title, 64, 40, 44)}>
          {s.title}
        </Serif>
      </Box>
      {col('left', 120, false)}
      {col('right', 1000, true)}
      <div style={{ position: 'absolute', left: 940, top: 300, width: 2, height: 330 * ez(f, -4, 10), background: T.rule }} />
      <Box x={918} y={420} style={{ fontFamily: MONO, fontSize: 22, color: T.faint, transform: `translateY(${br(f, 3, 6, 50)}px)` }}>
        VS
      </Box>
      {bar(L, 780, s.left.label, false, 0)}
      {bar(R, 860, s.right.label, true, 1)}
      <div style={{ position: 'absolute', left: 560, top: 930, width: BW, height: 1, background: T.rule }} />
      <div style={{ position: 'absolute', left: across(f, dur, 560, 560 + BW), top: 760, width: 2, height: 180, background: alpha(T.accent, 0.35) }} />
    </>
  );
};

export const RingStation: React.FC<P<'ring'>> = ({ s, f, dur, T }) => {
  const cx = 600;
  const cy = 560;
  const r = 290;
  const C = 2 * Math.PI * r;
  const g = ez(f, -4, 26);
  const orbit = (f / 60) * Math.PI * 2 - Math.PI / 2;
  return (
    <>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={T.rule} strokeWidth={58} />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={T.accent}
          strokeWidth={58}
          strokeDasharray={`${C * g} ${C}`}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <circle cx={cx + Math.cos(orbit) * (r + 62)} cy={cy + Math.sin(orbit) * (r + 62)} r={9} fill={T.accentInk} opacity={g} />
        <circle cx={cx} cy={cy} r={r + 62} fill="none" stroke={T.rule} strokeWidth={1.5} strokeDasharray="3 9" />
        {Array.from({ length: 60 }).map((_, i) => {
          const a = (i / 60) * Math.PI * 2;
          return <line key={i} x1={cx + Math.cos(a) * (r - 48)} y1={cy + Math.sin(a) * (r - 48)} x2={cx + Math.cos(a) * (r - 40)} y2={cy + Math.sin(a) * (r - 40)} stroke={T.faint} strokeWidth={1.5} opacity={ez(f, i * 0.15 - 4, i * 0.15 + 4)} />;
        })}
        <line x1={cx} y1={cy - r - 40} x2={cx} y2={cy - r + 40} stroke={T.ink} strokeWidth={4} opacity={ez(f, 8, 16)} />
      </svg>
      <Box x={cx - 260} y={cy - 150} w={520} style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 210, color: T.ink, lineHeight: 1, letterSpacing: -6, transform: `scale(${0.85 + 0.15 * pop(f, 1)})` }}>{s.big}</div>
        <Mono c={T.accentInk} s={22} ls={3} style={{ marginTop: 14 }}>
          {s.ringLabel}
        </Mono>
      </Box>
      {s.gapLabel ? (
        <Box x={cx + 26} y={cy - r - 118} style={{ ...card(T, { padding: '10px 16px' }), ...rise(land(f, 6)) }}>
          <Mono c={T.ink} s={20} w={700}>
            {s.gapLabel}
          </Mono>
        </Box>
      ) : null}
      <Box x={1060} y={190} w={760}>
        <div style={rise(land(f, 1))}>
          <Serif c={T.ink} s={fit(s.title, 66, 30, 46)}>
            {s.title}
          </Serif>
        </div>
        <div style={{ marginTop: 44, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {s.rows.slice(0, 4).map((row, i) => (
            <div
              key={i}
              style={{
                ...card(T, { padding: '22px 26px', display: 'flex', alignItems: 'center', gap: 18 }),
                ...rise(land(f, 3 + i)),
                transform: `translateX(${br(f, i, 4, 70)}px) translateY(${(1 - land(f, 3 + i)) * 26}px)`,
              }}
            >
              <Check c={T.green} t={ez(f, 8 + i * 8, 20 + i * 8)} />
              <Sans c={T.ink} s={28}>
                {row}
              </Sans>
            </div>
          ))}
        </div>
      </Box>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: across(f, dur, 0, 0) }} />
    </>
  );
};

export const WallStation: React.FC<P<'wall'>> = ({ s, f, dur, T }) => {
  const items = s.items.slice(0, 48);
  const n = items.length;
  const cols = Math.max(4, Math.min(8, Math.ceil(Math.sqrt(n * 1.8))));
  const rows = Math.ceil(n / cols);
  const GX = 120;
  const GY = 330;
  const GW = 1680;
  const GH = 640;
  const gap = 12;
  const tw = (GW - gap * (cols - 1)) / cols;
  const th = Math.min(150, (GH - gap * (rows - 1)) / rows);
  const sweep = across(f, dur, -2, cols + rows + 2);
  const pick = Math.floor(f / 7) % Math.max(1, n);
  return (
    <>
      <Box x={120} y={150} w={1100} style={rise(land(f, 0))}>
        <Serif c={T.ink} s={fit(s.title, 72, 28, 48)}>
          {s.title}
        </Serif>
      </Box>
      <Box x={1300} y={120} w={500} style={{ textAlign: 'right', ...rise(land(f, 1)) }}>
        <div style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 140, color: T.accentInk, lineHeight: 1, letterSpacing: -4 }}>{Math.round(n * ez(f, -4, 30))}</div>
        <Mono c={T.ink2} s={20}>
          {s.countLabel}
        </Mono>
      </Box>
      {items.map((it, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const d = Math.abs(c + r - sweep);
        const lit = clamp(1 - d / 1.6);
        const on = i === pick;
        const t = pop(f, i * 0.22);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: GX + c * (tw + gap),
              top: GY + r * (th + gap),
              width: tw,
              height: th,
              ...card(T, {
                background: on ? T.accent : mix(T.card, T.wash, lit),
                border: `1px solid ${on ? T.accent : T.rule}`,
                padding: '0 16px',
                display: 'flex',
                alignItems: 'center',
              }),
              transform: `scale(${t}) translateY(${-lit * 4}px)`,
            }}
          >
            <Sans c={on ? '#fff' : T.ink} s={Math.min(23, fit(it, 23, 16, 15))} w={on ? 600 : 500}>
              {it}
            </Sans>
          </div>
        );
      })}
    </>
  );
};

export const BurstStation: React.FC<P<'burst'>> = ({ s, f, dur, T }) => {
  const items = s.items.slice(0, 14);
  const n = items.length;
  const cx = 1100;
  const cy = 560;
  const rot = across(f, dur, -0.06, 0.06);
  const pts = items.map((_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2 + rot;
    return { a, x: cx + Math.cos(a) * 560, y: cy + Math.sin(a) * 360 };
  });
  return (
    <>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        {pts.map((p, i) => {
          const g = ez(f, -6 + i * 0.6, 6 + i * 0.6);
          const ph = ((f * 1.6 + i * 17) % 60) / 60;
          return (
            <g key={i}>
              <line x1={cx} y1={cy} x2={cx + (p.x - cx) * g} y2={cy + (p.y - cy) * g} stroke={T.rule} strokeWidth={2} />
              <circle cx={cx + (p.x - cx) * ph} cy={cy + (p.y - cy) * ph} r={6} fill={T.accent} opacity={g * (1 - ph * 0.6)} />
            </g>
          );
        })}
        {[150, 240].map((rr, k) => (
          <circle key={k} cx={cx} cy={cy} r={rr + ((f * 1.2 + k * 40) % 80)} fill="none" stroke={alpha(T.accent, 0.25 - (((f * 1.2 + k * 40) % 80) / 80) * 0.25)} strokeWidth={2} />
        ))}
      </svg>
      <div
        style={{
          position: 'absolute',
          left: cx,
          top: cy,
          transform: `translate(-50%,-50%) scale(${pop(f, 0)})`,
          width: 250,
          height: 250,
          borderRadius: 999,
          background: T.accent,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: 28,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ fontFamily: SERIF, fontWeight: 700, color: '#fff', fontSize: fit(s.center, 40, 14, 26), lineHeight: 1.05 }}>{s.center}</div>
      </div>
      {pts.map((p, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: p.x,
            top: p.y,
            transform: `translate(-50%,-50%) scale(${pop(f, 2 + i * 0.6)})`,
            ...card(T, { padding: '12px 20px', borderRadius: 999 }),
            whiteSpace: 'nowrap',
          }}
        >
          <Sans c={T.ink} s={26} w={600}>
            {items[i]}
          </Sans>
        </div>
      ))}
      <Box x={110} y={140} w={520} style={rise(land(f, 1))}>
        <Mono c={T.accentInk} s={22} ls={3}>
          {String(n)} · {s.title}
        </Mono>
      </Box>
    </>
  );
};

export const LadderStation: React.FC<P<'ladder'>> = ({ s, f, dur, T }) => {
  const rungs = s.rungs.slice(0, 16);
  const n = rungs.length;
  const X0 = 140;
  const W = 1640;
  const sw = W / n;
  const base = 960;
  const step = Math.min(44, 560 / n);
  const climb = across(f, dur * 0.95, 0, n - 1);
  const ci = Math.floor(climb);
  const cf = climb - ci;
  const hop = Math.sin(cf * Math.PI) * 50;
  const cxp = X0 + (ci + cf) * sw + sw / 2;
  const cyp = base - (ci + 1 + cf) * step - 190 - hop;
  return (
    <>
      <Box x={140} y={150} w={1000} style={rise(land(f, 0))}>
        <Serif c={T.ink} s={fit(s.title, 96, 18, 56)}>
          {s.title}
        </Serif>
      </Box>
      <Box x={1380} y={140} w={400} style={{ textAlign: 'right', ...rise(land(f, 1)) }}>
        <div style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 150, color: T.accentInk, lineHeight: 1 }}>{Math.round(n * ez(f, -4, 24))}</div>
        <Mono c={T.ink2} s={20}>
          {s.countLabel ?? ''}
        </Mono>
      </Box>
      {rungs.map((r, i) => {
        const h = (i + 1) * step + 160;
        const t = ez(f, -6 + i * 0.7, 6 + i * 0.7);
        const passed = i <= ci;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: X0 + i * sw + 4,
              top: base - h * t,
              width: sw - 8,
              height: h * t,
              background: passed ? (i === ci ? T.accent : T.wash) : T.card,
              border: `1px solid ${passed ? T.accent : T.rule}`,
              borderRadius: '10px 10px 0 0',
              boxShadow: `0 10px 30px ${alpha(T.ink, 0.05)}`,
              display: 'flex',
              justifyContent: 'center',
              paddingTop: 18,
              boxSizing: 'border-box',
            }}
          >
            <Sans c={i === ci ? '#fff' : T.ink} s={Math.min(30, fit(r, 30, 4, 17))} w={600}>
              {r}
            </Sans>
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: X0, top: base, width: W, height: 3, background: T.ink }} />
      <div style={{ position: 'absolute', left: cxp - 22, top: cyp, width: 44, height: 44, borderRadius: 99, background: T.ink, border: `6px solid ${T.ground}`, opacity: ez(f, 0, 8) }} />
    </>
  );
};

export const FilterStation: React.FC<P<'filter'>> = ({ s, f, dur, T }) => {
  const fields = s.fields.slice(0, 3);
  const CX = 210;
  const CW = 1500;
  const fw = (CW - 80 - 300 - 24 * fields.length) / Math.max(1, fields.length);
  const click = dur - 16;
  const curX = interpolateLin(f, [0, click - 4], [1500, CX + CW - 200]);
  const curY = interpolateLin(f, [0, click - 4], [700, 420]);
  const pressed = f > click - 3 && f < click + 4;
  return (
    <>
      <Box x={CX} y={150} w={CW} style={rise(land(f, 0))}>
        <Serif c={T.ink} s={fit(s.title, 76, 26, 50)}>
          {s.title}
        </Serif>
      </Box>
      <Box x={CX} y={320} w={CW} h={180} style={{ ...card(T, { padding: 40, boxSizing: 'border-box', display: 'flex', gap: 24, alignItems: 'center', border: `2px solid ${T.ink}` }), ...rise(land(f, 1)) }}>
        {fields.map((fd, i) => {
          const per = 12 + i * 4;
          const k = Math.floor(Math.max(0, f + 6) / per);
          const v = fd.values[(k + i * 2) % fd.values.length] ?? '';
          const ph = (Math.max(0, f + 6) % per) / per;
          return (
            <div key={i} style={{ width: fw, height: 96, border: `1px solid ${T.rule}`, borderRadius: 10, padding: '12px 18px', boxSizing: 'border-box', overflow: 'hidden', position: 'relative' }}>
              <Mono c={T.faint} s={15}>
                {fd.label}
              </Mono>
              <div style={{ transform: `translateY(${ph < 0.15 ? (1 - ph / 0.15) * 18 : 0}px)`, opacity: ph < 0.15 ? 0.4 + 0.6 * (ph / 0.15) : 1 }}>
                <Sans c={T.ink} s={30} w={600}>
                  {v}
                </Sans>
              </div>
              <div style={{ position: 'absolute', right: 16, top: 36, width: 14, height: 14, borderRight: `3px solid ${T.ink2}`, borderBottom: `3px solid ${T.ink2}`, transform: 'rotate(45deg)' }} />
            </div>
          );
        })}
        <div
          style={{
            width: 300,
            height: 96,
            borderRadius: 10,
            background: T.ink,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: `scale(${pressed ? 0.95 : 1})`,
            boxShadow: pressed ? `0 0 0 14px ${alpha(T.accent, 0.3)}` : 'none',
          }}
        >
          <Sans c="#fff" s={30} w={600}>
            {s.button}
          </Sans>
        </div>
      </Box>
      {}
      <Box x={CX} y={560} w={CW} style={{ display: 'flex', gap: 24 }}>
        {fields.map((fd, i) => {
          const per = 12 + i * 4;
          const k = Math.floor(Math.max(0, f + 6) / per);
          const cur = (k + i * 2) % fd.values.length;
          const vis = fd.values.slice(0, 9);
          return (
            <div key={i} style={{ width: fw, ...rise(land(f, 3 + i)) }}>
              {vis.map((v, j) => (
                <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 10, height: 40, borderBottom: `1px solid ${T.rule}` }}>
                  <div style={{ width: 8, height: 8, borderRadius: 9, background: j === cur ? T.accent : 'transparent' }} />
                  <Sans c={j === cur ? T.accentInk : T.ink2} s={21} w={j === cur ? 700 : 400}>
                    {v}
                  </Sans>
                </div>
              ))}
            </div>
          );
        })}
        <div style={{ width: 300, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {(s.notes ?? []).slice(0, 3).map((n, i) => (
            <div key={i} style={{ ...card(T, { padding: '14px 16px', display: 'flex', gap: 10, alignItems: 'center' }), ...rise(land(f, 6 + i)) }}>
              <Check c={T.green} t={ez(f, 4 + i * 6, 14 + i * 6)} size={24} />
              <Sans c={T.ink} s={20}>
                {n}
              </Sans>
            </div>
          ))}
        </div>
      </Box>
      <svg width={40} height={52} viewBox="0 0 40 52" style={{ position: 'absolute', left: curX, top: curY, opacity: ez(f, 2, 8) }}>
        <path d="M4 3 L4 42 L14 32 L21 48 L28 45 L21 29 L35 29 Z" fill={T.ink} stroke="#fff" strokeWidth={3} strokeLinejoin="round" />
      </svg>
    </>
  );
};

const interpolateLin = (f: number, [a, b]: [number, number], [x, y]: [number, number]) => {
  const t = clamp((f - a) / Math.max(1, b - a));
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return x + (y - x) * e;
};

export const StepsStation: React.FC<P<'steps'>> = ({ s, f, dur, T }) => {
  const steps = s.steps.slice(0, 5);
  const n = steps.length;
  const X0 = 240;
  const X1 = 1680;
  const xs = steps.map((_, i) => X0 + ((X1 - X0) * i) / Math.max(1, n - 1));
  const bead = across(f + 4, dur * 0.92, 0, n - 1);
  const bx = X0 + ((X1 - X0) * bead) / Math.max(1, n - 1);
  const cw = Math.min(380, (1700 - 30 * (n - 1)) / n);
  return (
    <>
      <Box x={120} y={140} w={1700} style={rise(land(f, 0))}>
        <Serif c={T.ink} s={fit(s.title, 66, 40, 44)}>
          {s.title}
        </Serif>
      </Box>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        <line x1={X0} x2={X0 + (X1 - X0) * ez(f, -6, 10)} y1={400} y2={400} stroke={T.rule} strokeWidth={6} strokeLinecap="round" />
        <line x1={X0} x2={bx} y1={400} y2={400} stroke={T.accent} strokeWidth={6} strokeLinecap="round" />
        {xs.map((x, i) => (
          <g key={i}>
            <circle cx={x} cy={400} r={34 * pop(f, i)} fill={bead >= i - 0.05 ? T.accent : T.card} stroke={bead >= i - 0.05 ? T.accent : T.ink} strokeWidth={3} />
            <text x={x} y={411} textAnchor="middle" fontFamily={MONO} fontSize={28} fontWeight={700} fill={bead >= i - 0.05 ? '#fff' : T.ink} opacity={ez(f, -2 + i, 6 + i)}>
              {i + 1}
            </text>
          </g>
        ))}
        <circle cx={bx} cy={400} r={14 + br(f, 1, 3, 20)} fill={T.ink} opacity={ez(f, 0, 6)} />
      </svg>
      {steps.map((st, i) => {
        const active = Math.round(bead) === i;
        const x = xs[i] - cw / 2;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: Math.max(100, Math.min(1820 - cw, x)),
              top: 480,
              width: cw,
              height: 440,
              boxSizing: 'border-box',
              overflow: 'hidden',
              ...card(T, { padding: '26px 26px', borderTop: `5px solid ${active ? T.accent : T.rule}` }),
              transform: `translateY(${(1 - land(f, 2 + i)) * 30 - (active ? 18 : 0)}px)`,
              opacity: clamp(land(f, 2 + i) * 1.4),
            }}
          >
            <Mono c={active ? T.accentInk : T.faint} s={17}>
              Step {i + 1}
            </Mono>
            <Serif c={T.ink} s={fit(st.title, 46, 12, 32)} style={{ marginTop: 12 }}>
              {st.title}
            </Serif>
            <Sans c={T.ink2} s={29} w={400} style={{ marginTop: 16 }}>
              {st.detail}
            </Sans>
            <div style={{ position: 'absolute', right: 18, bottom: -34, fontFamily: SERIF, fontWeight: 700, fontSize: 190, lineHeight: 1, color: active ? T.wash : alpha(T.ink, 0.045) }}>{i + 1}</div>
          </div>
        );
      })}
    </>
  );
};

export const ChatStation: React.FC<P<'chat'>> = ({ s, f, dur, T }) => {
  const typed = Math.round(s.message.length * clamp((f + 4) / Math.min(44, dur * 0.6)));
  const done = typed >= s.message.length;
  const sent = ez(f, Math.min(48, dur * 0.66), Math.min(56, dur * 0.66) + 8);
  return (
    <>
      <Box x={140} y={170} w={940} h={780} style={{ ...card(T, { padding: 0, overflow: 'hidden' }), ...rise(land(f, 0)) }}>
        <div style={{ height: 96, borderBottom: `1px solid ${T.rule}`, display: 'flex', alignItems: 'center', gap: 18, padding: '0 30px' }}>
          <div style={{ width: 52, height: 52, borderRadius: 99, background: T.wash, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Sans c={T.accentInk} s={24} w={700}>
              {s.from.slice(0, 1)}
            </Sans>
          </div>
          <div>
            <Sans c={T.ink} s={26} w={600}>
              {s.from}
            </Sans>
            <Mono c={T.faint} s={14}>
              {s.title}
            </Mono>
          </div>
        </div>
        <div style={{ padding: 34, height: 520, position: 'relative', background: alpha(T.ink, 0.015) }}>
          <div
            style={{
              position: 'absolute',
              right: 34,
              bottom: 150 + sent * 90,
              maxWidth: 720,
              background: sent > 0.02 ? T.accent : T.card,
              border: `1px solid ${sent > 0.02 ? T.accent : T.rule}`,
              borderRadius: '18px 18px 4px 18px',
              padding: '22px 26px',
              opacity: typed > 0 ? 1 : 0,
            }}
          >
            <Sans c={sent > 0.02 ? '#fff' : T.ink} s={40} w={500}>
              {s.message.slice(0, typed)}
              {!done && Math.floor(f / 4) % 2 === 0 ? '|' : ''}
            </Sans>
          </div>
          {sent > 0 ? (
            <div style={{ position: 'absolute', right: 40, bottom: 18, opacity: sent }}>
              <Mono c={T.faint} s={14}>
                sent
              </Mono>
            </div>
          ) : null}
        </div>
        <div style={{ height: 164, borderTop: `1px solid ${T.rule}`, display: 'flex', alignItems: 'center', padding: '0 30px', gap: 18 }}>
          <div style={{ flex: 1, height: 70, borderRadius: 12, border: `1px solid ${T.rule}`, display: 'flex', alignItems: 'center', padding: '0 20px' }}>
            <Sans c={T.faint} s={24} w={400}>
              {done ? '' : s.message.slice(Math.max(0, typed - 26), typed)}
            </Sans>
          </div>
          <div style={{ width: 70, height: 70, borderRadius: 12, background: done ? T.accent : T.rule, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${done && sent < 0.5 ? 1.08 : 1})` }}>
            <svg width={30} height={30} viewBox="0 0 30 30">
              <path d="M4 15 L26 4 L19 26 L15 17 Z" fill="#fff" />
            </svg>
          </div>
        </div>
      </Box>
      <Box x={1180} y={200} w={640}>
        <div style={rise(land(f, 1))}>
          <Serif c={T.ink} s={fit(s.title, 70, 18, 46)}>
            {s.title}
          </Serif>
        </div>
        <div style={{ marginTop: 50, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {s.checks.slice(0, 4).map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 18, alignItems: 'center', paddingBottom: 20, borderBottom: `1px solid ${T.rule}`, ...rise(land(f, 3 + i)) }}>
              <Check c={T.green} t={ez(f, 4 + i * 9, 14 + i * 9)} size={38} />
              <Sans c={T.ink} s={30}>
                {c}
              </Sans>
            </div>
          ))}
        </div>
      </Box>
    </>
  );
};

export const RangeStation: React.FC<P<'range'>> = ({ s, f, dur, T }) => {
  const cx = 960;
  const cy = 820;
  const r = 470;
  const g = ez(f, -6, 8);
  const sweep = 0.5 - 0.5 * Math.cos(clamp((f + 6) / (dur * 0.8)) * Math.PI * 2 * 0.75);
  const a = Math.PI + sweep * Math.PI;
  const arcPt = (t: number, rr: number) => [cx + Math.cos(Math.PI + t * Math.PI) * rr, cy + Math.sin(Math.PI + t * Math.PI) * rr];
  const [nx, ny] = [cx + Math.cos(a) * (r - 40), cy + Math.sin(a) * (r - 40)];
  const [ex, ey] = arcPt(sweep, r);
  return (
    <>
      <Box x={120} y={130} w={900} style={rise(land(f, 0))}>
        <Serif c={T.ink} s={fit(s.title, 66, 24, 44)}>
          {s.title}
        </Serif>
      </Box>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={T.rule} strokeWidth={40} pathLength={1} strokeDasharray={`${g} 1`} />
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${ex} ${ey}`} fill="none" stroke={T.accent} strokeWidth={40} />
        {Array.from({ length: 46 }).map((_, i) => {
          const t = i / 45;
          const [x1, y1] = arcPt(t, r - 42);
          const [x2, y2] = arcPt(t, r - (i % 5 === 0 ? 70 : 54));
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={t <= sweep ? T.accentInk : T.faint} strokeWidth={i % 5 === 0 ? 3 : 1.5} opacity={ez(f, -6 + i * 0.2, 2 + i * 0.2)} />;
        })}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={T.ink} strokeWidth={8} strokeLinecap="round" opacity={g} />
        <circle cx={cx} cy={cy} r={26} fill={T.ink} opacity={g} />
      </svg>
      <Box x={cx - r - 120} y={cy + 30} w={240} style={{ textAlign: 'center', ...rise(land(f, 2)) }}>
        <Serif c={T.ink} s={60}>
          {s.min}
        </Serif>
        <Mono c={T.ink2} s={18}>
          {s.unit}
        </Mono>
      </Box>
      <Box x={cx + r - 120} y={cy + 30} w={240} style={{ textAlign: 'center', ...rise(land(f, 3)) }}>
        <Serif c={T.ink} s={60}>
          {s.max}
        </Serif>
        <Mono c={T.ink2} s={18}>
          {s.unit}
        </Mono>
      </Box>
      <Box x={cx - 330} y={cy + 50} w={660} style={{ textAlign: 'center', ...rise(land(f, 1)) }}>
        <Mono c={T.accentInk} s={22} ls={3}>
          {s.min}–{s.max} {s.unit}
        </Mono>
        <Sans c={T.ink} s={30} style={{ marginTop: 14 }}>
          {s.caption}
        </Sans>
      </Box>
      <Box x={1260} y={150} w={560} style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-end' }}>
        {(s.notes ?? []).slice(0, 3).map((n, i) => (
          <div key={i} style={{ ...card(T, { padding: '14px 20px' }), ...rise(land(f, 4 + i)) }}>
            <Sans c={T.ink} s={24}>
              {n}
            </Sans>
          </div>
        ))}
      </Box>
    </>
  );
};

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
export const RepeatStation: React.FC<P<'repeat'>> = ({ s, f, dur, T }) => {
  const GX = 700;
  const GY = 170;
  const cw = 134;
  const ch = 104;
  const rows = 7;
  const col = 2;
  const lit = across(f + 6, dur * 0.85, 0, rows);
  return (
    <>
      <Box x={120} y={200} w={560}>
        <div style={rise(land(f, 0))}>
          <Serif c={T.ink} s={fit(s.title, 72, 16, 48)}>
            {s.title}
          </Serif>
        </div>
        <div style={{ marginTop: 30, ...rise(land(f, 2)) }}>
          <Sans c={T.ink2} s={30} w={400}>
            {s.caption}
          </Sans>
        </div>
      </Box>
      {s.contrast ? (
        <Box x={120} y={720} w={560} style={rise(land(f, 4))}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 18, position: 'relative', width: 'fit-content' }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ width: 54, height: 54, borderRadius: 99, background: mix(T.rule, T.ground, (i % 3) * 0.3), border: `2px solid ${T.card}`, transform: `translateY(${br(f, i, 5, 26)}px)` }} />
            ))}
            <div style={{ position: 'absolute', left: -8, right: -8, top: 26, height: 4, background: T.red, transformOrigin: 'left', transform: `scaleX(${ez(f, 10, 22)}) rotate(-4deg)` }} />
          </div>
          <Sans c={T.ink} s={28} w={600} style={{ textDecoration: 'line-through', textDecorationColor: alpha(T.red, ez(f, 14, 22)), textDecorationThickness: 3 }}>
            {s.contrast}
          </Sans>
        </Box>
      ) : null}
      {DAYS.map((d, c) => (
        <Box key={c} x={GX + c * cw} y={GY - 6} w={cw} style={{ textAlign: 'center', ...rise(land(f, c * 0.3)) }}>
          <Mono c={c === col ? T.accentInk : T.faint} s={20} w={700}>
            {d}
          </Mono>
        </Box>
      ))}
      {Array.from({ length: rows * 7 }).map((_, k) => {
        const c = k % 7;
        const r = Math.floor(k / 7);
        const on = c === col && r < lit;
        const fresh = c === col && r < lit && r >= lit - 1;
        return (
          <div
            key={k}
            style={{
              position: 'absolute',
              left: GX + c * cw + 5,
              top: GY + 40 + r * ch + 5,
              width: cw - 10,
              height: ch - 10,
              borderRadius: 10,
              background: on ? T.accent : T.card,
              border: `1px solid ${on ? T.accent : T.rule}`,
              transform: `scale(${pop(f, k * 0.12) * (fresh ? 1.06 : 1)})`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: on ? `0 12px 26px ${alpha(T.accent, 0.3)}` : 'none',
            }}
          >
            {on ? (
              <div style={{ width: 52, height: 52, borderRadius: 99, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width={30} height={30} viewBox="0 0 40 40">
                  <circle cx={20} cy={14} r={8} fill={T.accentInk} />
                  <path d="M5 38 C 7 26, 33 26, 35 38 Z" fill={T.accentInk} />
                </svg>
              </div>
            ) : (
              <div style={{ width: 40, height: 6, borderRadius: 4, background: alpha(T.ink, 0.06 + 0.04 * ((k * 7) % 3)) }} />
            )}
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: GX + col * cw + cw / 2 - 2, top: GY + 40, width: 4, height: Math.max(0, lit * ch - ch / 2), background: alpha(T.accentInk, 0.6), zIndex: -1 }} />
      <Box x={GX + 7 * cw + 30} y={GY + 40 + Math.max(0, Math.min(rows, lit) - 1) * ch + 28} style={{ opacity: ez(f, 0, 8) }}>
        <div style={{ ...card(T, { padding: '10px 14px' }) }}>
          <Mono c={T.ink} s={16} w={700}>
            {s.slot}
          </Mono>
        </div>
      </Box>
    </>
  );
};

const Dial: React.FC<{ cx: number; cy: number; r: number; f: number; T: Tokens; warm: boolean; seed: number }> = ({ cx, cy, r, f, T, warm, seed }) => {
  const g = ez(f, -6, 8);
  const minA = (f * 6 + seed * 90) * (Math.PI / 180);
  const hrA = (f * 0.5 + seed * 40) * (Math.PI / 180);
  return (
    <g opacity={g}>
      <circle cx={cx} cy={cy} r={r} fill={warm ? T.wash : T.card} stroke={T.ink} strokeWidth={4} />
      {Array.from({ length: 60 }).map((_, i) => {
        const a = (i / 60) * Math.PI * 2;
        const L = i % 5 === 0 ? 26 : 10;
        return <line key={i} x1={cx + Math.cos(a) * (r - 14)} y1={cy + Math.sin(a) * (r - 14)} x2={cx + Math.cos(a) * (r - 14 - L)} y2={cy + Math.sin(a) * (r - 14 - L)} stroke={i % 5 === 0 ? T.ink : T.faint} strokeWidth={i % 5 === 0 ? 4 : 1.5} />;
      })}
      <line x1={cx} y1={cy} x2={cx + Math.sin(hrA) * r * 0.5} y2={cy - Math.cos(hrA) * r * 0.5} stroke={T.ink} strokeWidth={12} strokeLinecap="round" />
      <line x1={cx} y1={cy} x2={cx + Math.sin(minA) * r * 0.78} y2={cy - Math.cos(minA) * r * 0.78} stroke={T.accent} strokeWidth={6} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={14} fill={T.ink} />
    </g>
  );
};
export const ClockStation: React.FC<P<'clock'>> = ({ s, f, dur, T }) => {
  const L = { x: 560, y: 540 };
  const R = { x: 1360, y: 540 };
  const r = 230;
  const ph = ((f + 10) % 40) / 40;
  const arc = `M ${L.x + 120} ${L.y - r - 10} Q 960 ${L.y - r - 190} ${R.x - 120} ${R.y - r - 10}`;
  return (
    <>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        <Dial cx={L.x} cy={L.y} r={r} f={f} T={T} warm seed={1} />
        <Dial cx={R.x} cy={R.y} r={r} f={f} T={T} warm={false} seed={3} />
        <path d={arc} fill="none" stroke={T.ink2} strokeWidth={3} strokeDasharray="8 10" pathLength={1} opacity={ez(f, 0, 10)} />
        {[0, 0.33, 0.66].map((o, i) => {
          const t = (ph + o) % 1;
          const x = (1 - t) * (1 - t) * (L.x + 120) + 2 * (1 - t) * t * 960 + t * t * (R.x - 120);
          const y = (1 - t) * (1 - t) * (L.y - r - 10) + 2 * (1 - t) * t * (L.y - r - 190) + t * t * (R.y - r - 10);
          return <circle key={i} cx={x} cy={y} r={10} fill={T.accent} opacity={ez(f, 2, 10)} />;
        })}
        {}
        {Array.from({ length: 10 }).map((_, i) => {
          const a = (i / 10) * Math.PI * 2 + f * 0.02;
          return <line key={i} x1={L.x - r + 30 + Math.cos(a) * 46} y1={L.y - r + 30 + Math.sin(a) * 46} x2={L.x - r + 30 + Math.cos(a) * 62} y2={L.y - r + 30 + Math.sin(a) * 62} stroke={T.amber} strokeWidth={5} strokeLinecap="round" opacity={ez(f, 2, 10)} />;
        })}
        <circle cx={L.x - r + 30} cy={L.y - r + 30} r={34} fill={T.amber} opacity={ez(f, 2, 10)} />
        <circle cx={R.x + r - 30} cy={R.y - r + 30} r={36} fill={T.ink} opacity={ez(f, 2, 10)} />
        <circle cx={R.x + r - 14} cy={R.y - r + 18} r={32} fill={T.ground} opacity={ez(f, 2, 10)} />
      </svg>
      {[
        { p: L, d: s.left },
        { p: R, d: s.right },
      ].map(({ p, d }, i) => (
        <Box key={i} x={p.x - 300} y={p.y + r + 26} w={600} style={{ textAlign: 'center', ...rise(land(f, 2 + i)) }}>
          <Mono c={T.ink2} s={20} ls={4}>
            {d.place}
          </Mono>
          <Serif c={T.ink} s={fit(d.when, 52, 16, 36)} style={{ marginTop: 8 }}>
            {d.when}
          </Serif>
        </Box>
      ))}
      <Box x={660} y={140} w={600} style={{ textAlign: 'center', ...rise(land(f, 0)) }}>
        <Serif c={T.accentInk} s={fit(s.title, 50, 22, 34)}>
          {s.title}
        </Serif>
      </Box>
      <Box x={360} y={960} w={1200} style={{ textAlign: 'center', ...rise(land(f, 5)) }}>
        <Sans c={T.ink2} s={26} w={400}>
          {s.caption}
        </Sans>
      </Box>
      <div style={{ position: 'absolute', opacity: across(f, dur, 1, 1) }} />
    </>
  );
};

export const StrikeStation: React.FC<P<'strike'>> = ({ s, f, dur, T }) => {
  const items = s.items.slice(0, 6);
  const rowH = Math.min(160, 700 / Math.max(1, items.length));
  const stampT = pop(f, 24);
  return (
    <>
      <Box x={140} y={130} w={1200} style={rise(land(f, 0))}>
        <Mono c={T.ink2} s={22} ls={4}>
          {s.title}
        </Mono>
      </Box>
      {items.map((it, i) => {
        const st = ez(f, 2 + i * 6, 12 + i * 6);
        const fs = Math.min(rowH * 0.62, fit(it, 104, 18, 56));
        return (
          <Box key={i} x={140} y={210 + i * rowH} w={1300} h={rowH} style={{ display: 'flex', alignItems: 'center', gap: 28, borderBottom: `1px solid ${T.rule}`, ...rise(land(f, 1 + i * 0.6)) }}>
            <Mono c={T.faint} s={20} style={{ width: 50 }}>
              {String(i + 1).padStart(2, '0')}
            </Mono>
            <div style={{ position: 'relative' }}>
              <div style={{ fontFamily: SERIF, fontWeight: 600, fontSize: fs, color: mix(T.ink, T.faint, st), letterSpacing: -1.5, whiteSpace: 'nowrap' }}>{it}</div>
              <div style={{ position: 'absolute', left: -10, top: '54%', height: 6, width: `calc(${st * 100}% + 20px)`, background: T.red, borderRadius: 3, transform: `rotate(${-1 + (i % 2) * 2}deg)` }} />
            </div>
          </Box>
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: 1270,
          top: 800,
          transform: `rotate(${-9 + br(f, 2, 0.6, 60)}deg) scale(${stampT ? 2.2 - 1.2 * Math.min(1, stampT) : 0})`,
          opacity: clamp(stampT * 2),
          border: `6px solid ${T.accentInk}`,
          borderRadius: 14,
          padding: '22px 30px',
          maxWidth: 400,
          background: alpha(T.card, 0.85),
        }}
      >
        <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: fit(s.stamp, 36, 16, 26), color: T.accentInk, letterSpacing: 2, textTransform: 'uppercase', lineHeight: 1.2 }}>{s.stamp}</div>
      </div>
      <div style={{ position: 'absolute', opacity: across(f, dur, 1, 1) }} />
    </>
  );
};

export const RedactStation: React.FC<P<'redact'>> = ({ s, f, dur, T }) => {
  const hidden = safeCount(s.hiddenCount ?? 4, 2, 6, 4);
  const rows = s.shown.length + hidden;
  const rowH = Math.min(96, 560 / rows);
  return (
    <>
      <Box x={180} y={160} w={900} h={800} style={{ ...card(T, { padding: 40, boxSizing: 'border-box' }), ...rise(land(f, 0)) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, paddingBottom: 26, borderBottom: `1px solid ${T.rule}` }}>
          <div style={{ width: 84, height: 84, borderRadius: 99, background: T.wash, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width={40} height={40} viewBox="0 0 40 40">
              <circle cx={20} cy={14} r={8} fill={T.accentInk} />
              <path d="M5 38 C 7 26, 33 26, 35 38 Z" fill={T.accentInk} />
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ height: 22, width: 280, background: T.ink, borderRadius: 4, transform: `scaleX(${ez(f, 0, 12)})`, transformOrigin: 'left' }} />
            <div style={{ height: 14, width: 180, background: alpha(T.ink, 0.25), borderRadius: 4, marginTop: 14, transform: `scaleX(${ez(f, 2, 14)})`, transformOrigin: 'left' }} />
          </div>
          <div style={{ ...card(T, { padding: '8px 12px', boxShadow: 'none' }) }}>
            <Mono c={T.green} s={15} w={700}>
              ● {s.shown.length} shown
            </Mono>
          </div>
        </div>
        {s.shown.map((r, i) => (
          <div key={i} style={{ height: rowH, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${T.rule}`, ...rise(land(f, 2 + i)) }}>
            <Mono c={T.ink2} s={18}>
              {r.label}
            </Mono>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Sans c={T.green} s={28} w={600}>
                {r.value}
              </Sans>
              <Check c={T.green} t={ez(f, 6 + i * 4, 16 + i * 4)} size={30} />
            </div>
          </div>
        ))}
        {Array.from({ length: hidden }).map((_, i) => {
          const w = 0.55 + ((i * 37) % 30) / 100;
          const t = ez(f, 4 + i * 4, 14 + i * 4);
          return (
            <div key={i} style={{ height: rowH, display: 'flex', alignItems: 'center', gap: 20, borderBottom: `1px solid ${T.rule}` }}>
              <div style={{ width: 140, height: 14, borderRadius: 4, background: alpha(T.ink, 0.12) }} />
              <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ height: 34, width: `${w * 100 * t}%`, background: T.ink, borderRadius: 4 }} />
              </div>
              <svg width={26} height={30} viewBox="0 0 26 30" style={{ opacity: t }}>
                <rect x={3} y={13} width={20} height={15} rx={3} fill={T.ink} />
                <path d="M7 13 V9 a6 6 0 0 1 12 0 V13" fill="none" stroke={T.ink} strokeWidth={3} />
              </svg>
            </div>
          );
        })}
      </Box>
      <div style={{ position: 'absolute', left: 180, top: across(f, dur, 260, 900), width: 900, height: 3, background: alpha(T.accent, 0.5) }} />
      <Box x={1180} y={380} w={640}>
        <div style={rise(land(f, 1))}>
          <Serif c={T.ink} s={fit(s.title, 84, 16, 54)}>
            {s.title}
          </Serif>
        </div>
        <div style={{ marginTop: 34, ...rise(land(f, 3)) }}>
          <Sans c={T.ink2} s={32} w={400}>
            {s.caption}
          </Sans>
        </div>
      </Box>
    </>
  );
};

export const OptionsStation: React.FC<P<'options'>> = ({ s, f, dur, T }) => {
  const items = s.items.slice(0, 4);
  const n = items.length;
  const pos = [
    { x: 140, y: 170, r: -3 },
    { x: 700, y: 120, r: 2 },
    { x: 1250, y: 220, r: -1.5 },
    { x: 960, y: 420, r: 3 },
  ];
  return (
    <>
      <Box x={120} y={800} w={1300} style={{ zIndex: 9, ...rise(land(f, 0)) }}>
        <Serif c={T.ink} s={fit(s.title, 72, 26, 48)}>
          {s.title}
        </Serif>
      </Box>
      {items.map((it, i) => {
        const p = pos[i % pos.length];
        const t = pop(f, 1 + i * 1.5);
        const tone = i % 2 === 0;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: p.x + across(f, dur, 0, (i % 2 ? -1 : 1) * 18),
              top: p.y + br(f, i, 8, 64),
              width: 560,
              height: 400,
              ...card(T, { overflow: 'hidden', padding: 0 }),
              transform: `rotate(${p.r}deg) scale(${t})`,
              zIndex: i,
            }}
          >
            <div style={{ height: 52, background: alpha(T.ink, 0.04), borderBottom: `1px solid ${T.rule}`, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px' }}>
              {[T.red, T.amber, T.green].map((c, k) => (
                <div key={k} style={{ width: 12, height: 12, borderRadius: 9, background: c }} />
              ))}
              <Sans c={T.ink} s={22} w={700} style={{ marginLeft: 12 }}>
                {it}
              </Sans>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 10, height: 10, borderRadius: 9, background: T.red, opacity: 0.5 + 0.5 * Math.abs(Math.sin(f / 8 + i)) }} />
                <Mono c={T.red} s={14} w={700}>
                  live
                </Mono>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, padding: 14, height: 260 }}>
              {[0, 1].map((k) => (
                <div key={k} style={{ flex: 1, borderRadius: 10, background: k === 0 ? (tone ? T.wash : alpha(T.ink, 0.07)) : tone ? alpha(T.ink, 0.07) : T.wash, position: 'relative', overflow: 'hidden' }}>
                  <svg width="100%" height="100%" viewBox="0 0 200 200" preserveAspectRatio="xMidYMax meet" style={{ position: 'absolute', bottom: 0 }}>
                    <circle cx={100} cy={92 + br(f, k + i, 2, 30)} r={32} fill={alpha(T.ink, 0.25)} />
                    <path d="M40 200 C 44 140, 156 140, 160 200 Z" fill={alpha(T.ink, 0.25)} />
                  </svg>
                  {k === 0 ? (
                    <div style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', gap: 3, alignItems: 'flex-end' }}>
                      {Array.from({ length: 5 }).map((_, b) => (
                        <div key={b} style={{ width: 4, height: 6 + Math.abs(Math.sin(f / 3 + b + i)) * 14, background: T.green, borderRadius: 2 }} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 14 }}>
              {[T.ink2, T.ink2, T.red].map((c, k) => (
                <div key={k} style={{ width: 40, height: 40, borderRadius: 99, background: alpha(c, 0.15), border: `2px solid ${c}` }} />
              ))}
            </div>
          </div>
        );
      })}
      <Box x={120} y={950} w={1680} style={{ display: 'flex', alignItems: 'center', gap: 16, zIndex: 9, ...rise(land(f, 3 + n)) }}>
        <div style={{ width: 14, height: 14, borderRadius: 9, background: T.accent }} />
        <Sans c={T.ink} s={30} w={500}>
          {s.caption}
        </Sans>
      </Box>
    </>
  );
};

export const GateStation: React.FC<P<'gate'>> = ({ s, f, dur, T }) => {
  const pass = s.pass.slice(0, 4);
  const n = pass.length;
  const X0 = 140;
  const nw = 270;
  const gap = (1000 - nw * n) / Math.max(1, n - 1) + nw;
  const tok = across(f + 4, dur * 0.9, 0, n - 1);
  const bounce = (f % 30) / 30;
  return (
    <>
      <Box x={140} y={130} w={1700} style={rise(land(f, 0))}>
        <Serif c={T.ink} s={fit(s.title, 64, 34, 44)}>
          {s.title}
        </Serif>
      </Box>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        <line x1={X0 + nw / 2} x2={X0 + nw / 2 + gap * (n - 1) * ez(f, -4, 10)} y1={420} y2={420} stroke={T.green} strokeWidth={5} />
        <circle cx={X0 + nw / 2 + gap * tok} cy={420} r={16} fill={T.green} opacity={ez(f, 0, 6)} />
        <line x1={X0 + nw / 2} x2={X0 + 600} y1={700} y2={700} stroke={T.red} strokeWidth={5} strokeDasharray="12 10" opacity={ez(f, 2, 10)} />
        <circle cx={X0 + nw / 2 + (X0 + 520 - X0 - nw / 2) * Math.sin(bounce * Math.PI) } cy={700} r={14} fill={T.red} opacity={ez(f, 4, 10)} />
        <g transform={`translate(${X0 + 620} 700)`} opacity={ez(f, 4, 12)}>
          <rect x={-8} y={-70} width={16} height={140} rx={4} fill={T.red} />
          <path d="M-40 -40 L40 40 M40 -40 L-40 40" stroke={T.red} strokeWidth={10} strokeLinecap="round" transform="translate(80 0) scale(0.5)" />
        </g>
      </svg>
      {pass.map((p, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: X0 + i * gap,
            top: 356,
            width: nw,
            height: 128,
            ...card(T, { padding: '0 20px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 14, border: `2px solid ${tok >= i - 0.1 ? T.green : T.rule}` }),
            transform: `scale(${pop(f, 1 + i)})`,
          }}
        >
          <Check c={T.green} t={tok >= i - 0.1 ? 1 : 0} size={32} />
          <Sans c={T.ink} s={Math.min(28, fit(p, 28, 14, 20))} w={600}>
            {p}
          </Sans>
        </div>
      ))}
      <Box x={140} y={640} w={300} h={120} style={{ ...card(T, { padding: '0 20px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', border: `2px dashed ${T.red}` }), ...rise(land(f, 3)) }}>
        <Sans c={T.red} s={26} w={600}>
          {s.block}
        </Sans>
      </Box>
      <Box x={1200} y={300} w={600} h={520} style={{ ...card(T, { padding: 40, boxSizing: 'border-box' }), ...rise(land(f, 2)) }}>
        <Mono c={T.ink2} s={18} ls={3}>
          {pass[n - 1] ?? ''}
        </Mono>
        <div style={{ display: 'flex', gap: 14, marginTop: 30 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <svg key={i} width={70} height={70} viewBox="0 0 24 24" style={{ transform: `scale(${pop(f, 4 + i)})` }}>
              <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.5 1.3 6.6L12 17.3 6.1 20.5l1.3-6.6L2.5 9.4l6.6-.8z" fill="none" stroke={T.faint} strokeWidth={1.4} strokeDasharray="2 2" />
            </svg>
          ))}
        </div>
        <div style={{ marginTop: 40, height: 1, background: T.rule }} />
        <Sans c={T.ink} s={32} w={600} style={{ marginTop: 30 }}>
          {s.empty}
        </Sans>
        <div style={{ marginTop: 26, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[0.8, 0.6, 0.7].map((w, i) => (
            <div key={i} style={{ height: 12, width: `${w * 100}%`, borderRadius: 6, border: `1.5px dashed ${T.faint}`, opacity: 0.5 + 0.5 * Math.abs(Math.sin(f / 14 + i)) }} />
          ))}
        </div>
      </Box>
      <Box x={140} y={900} w={1660} style={rise(land(f, 5))}>
        <Sans c={T.ink2} s={30} w={400}>
          {s.caption}
        </Sans>
      </Box>
    </>
  );
};

export const FlowStation: React.FC<P<'flow'>> = ({ s, f, dur, T }) => {
  const via = s.via.slice(0, 4);
  const n = via.length;
  const LX = 330;
  const RX = 1590;
  const top = 280;
  const bandH = 96;
  const gapY = 50;
  const total = n * bandH + (n - 1) * gapY;
  const sy = 560 - total / 2;
  const colors = [T.accent, mix(T.accent, T.ink, 0.25), mix(T.accent, T.ground, 0.35), mix(T.accent, T.amber, 0.4)];
  const g = ez(f, -6, 14);
  return (
    <>
      <Box x={120} y={130} w={1680} style={{ textAlign: 'center', ...rise(land(f, 0)) }}>
        <Serif c={T.ink} s={fit(s.title, 72, 30, 48)}>
          {s.title}
        </Serif>
      </Box>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        <defs>
          <clipPath id="flowclip">
            <rect x={0} y={0} width={LX + (RX - LX) * g} height={1080} />
          </clipPath>
        </defs>
        <g clipPath="url(#flowclip)">
          {via.map((_, i) => {
            const y0 = 560 - (n * 46) / 2 + i * 46;
            const y1 = sy + i * (bandH + gapY);
            const yR = 560 - (n * 46) / 2 + i * 46;
            const d = `M ${LX} ${y0} C ${LX + 300} ${y0}, ${760 - 260} ${y1}, 760 ${y1} L 1160 ${y1} C ${1160 + 260} ${y1}, ${RX - 300} ${yR}, ${RX} ${yR} L ${RX} ${yR + 46} C ${RX - 300} ${yR + 46}, ${1160 + 260} ${y1 + bandH}, 1160 ${y1 + bandH} L 760 ${y1 + bandH} C ${760 - 260} ${y1 + bandH}, ${LX + 300} ${y0 + 46}, ${LX} ${y0 + 46} Z`;
            return <path key={i} d={d} fill={alpha(colors[i % colors.length], 0.55)} />;
          })}
          {via.map((_, i) =>
            Array.from({ length: 6 }).map((__, k) => {
              const t = ((f * 0.012 + k / 6 + i * 0.07) % 1 + 1) % 1;
              const y1 = sy + i * (bandH + gapY) + bandH / 2;
              const yE = 560 - (n * 46) / 2 + i * 46 + 23;
              const x = LX + (RX - LX) * t;
              const y = t < 0.34 ? yE + (y1 - yE) * (t / 0.34) : t > 0.66 ? y1 + (yE - y1) * ((t - 0.66) / 0.34) : y1;
              return <circle key={`${i}-${k}`} cx={x} cy={y} r={6} fill="#fff" opacity={0.9} />;
            }),
          )}
        </g>
        {s.zero ? (
          <path d={`M 960 ${sy + total + 6} L 960 ${sy + total + 66}`} stroke={T.ink2} strokeWidth={3} strokeDasharray="6 8" opacity={ez(f, 6, 14)} />
        ) : null}
      </svg>
      {[
        { x: LX - 230, label: s.from },
        { x: RX + 10, label: s.to },
      ].map((nd, i) => (
        <div key={i} style={{ position: 'absolute', left: nd.x, top: 560 - (n * 46) / 2 - 30, width: 220, height: n * 46 + 60, ...card(T, { background: T.ink, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }), transform: `scale(${pop(f, i * 2)})` }}>
          <Sans c="#fff" s={30} w={700}>
            {nd.label}
          </Sans>
        </div>
      ))}
      {via.map((v, i) => (
        <div key={i} style={{ position: 'absolute', left: 960, top: sy + i * (bandH + gapY) + bandH / 2, transform: `translate(-50%,-50%) scale(${pop(f, 2 + i)})`, ...card(T, { padding: '10px 26px', borderRadius: 999 }) }}>
          <Sans c={T.ink} s={30} w={700}>
            {v}
          </Sans>
        </div>
      ))}
      {s.zero ? (
        <div style={{ position: 'absolute', left: 960, top: sy + total + 70, transform: 'translateX(-50%)', ...card(T, { padding: '14px 26px', display: 'flex', gap: 18, alignItems: 'center', border: `2px dashed ${T.faint}`, background: T.ground }), ...rise(land(f, 6)) }}>
          <Sans c={T.ink2} s={26}>
            {s.zero.label}
          </Sans>
          <div style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 52, color: T.accentInk }}>{s.zero.value}</div>
        </div>
      ) : null}
      <Box x={120} y={968} w={1680} style={{ textAlign: 'center', ...rise(land(f, 7)) }}>
        <Sans c={T.ink2} s={28} w={400}>
          {s.caption}
        </Sans>
      </Box>
      <div style={{ position: 'absolute', top, opacity: across(f, dur, 1, 1) }} />
    </>
  );
};

export const CountdownStation: React.FC<P<'countdown'>> = ({ s, f, dur, T }) => {
  const H = safeCount(numbersIn(s.hours)[0] ?? 24, 1, 72, 24);
  const cx = 520;
  const cy = 580;
  const r = 330;
  const t = clamp((f + 4) / (dur * 0.8));
  const left = H * (1 - t);
  const C = 2 * Math.PI * r;
  const inside = left > 0.5;
  return (
    <>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={T.rule} strokeWidth={40} />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={inside ? T.green : T.amber} strokeWidth={40} strokeDasharray={`${C * (left / H) * ez(f, -6, 6)} ${C}`} transform={`rotate(-90 ${cx} ${cy})`} />
        {Array.from({ length: H }).map((_, i) => {
          const a = (i / H) * Math.PI * 2 - Math.PI / 2;
          return <line key={i} x1={cx + Math.cos(a) * (r - 46)} y1={cy + Math.sin(a) * (r - 46)} x2={cx + Math.cos(a) * (r - 66)} y2={cy + Math.sin(a) * (r - 66)} stroke={i / H < left / H ? T.ink : T.faint} strokeWidth={3} />;
        })}
      </svg>
      <Box x={cx - 220} y={cy - 130} w={440} style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 200, lineHeight: 1, color: T.ink, letterSpacing: -6, fontVariantNumeric: 'tabular-nums' }}>{Math.ceil(left)}</div>
        <Mono c={T.ink2} s={22} ls={3}>
          {s.hours}
        </Mono>
      </Box>
      <Box x={1000} y={170} w={820}>
        <div style={rise(land(f, 0))}>
          <Serif c={T.ink} s={fit(s.title, 66, 24, 44)}>
            {s.title}
          </Serif>
        </div>
        {[
          { on: inside, c: T.green, text: s.inside },
          { on: !inside, c: T.amber, text: s.outside },
        ].map((row, i) => (
          <div
            key={i}
            style={{
              marginTop: i === 0 ? 60 : 26,
              ...card(T, { padding: '40px 36px', borderLeft: `8px solid ${row.c}`, background: row.on ? mix(T.card, row.c, 0.08) : T.card }),
              transform: `translateX(${row.on ? -14 : 0}px) translateY(${(1 - land(f, 2 + i)) * 26}px)`,
              opacity: clamp(land(f, 2 + i) * 1.4) * (row.on ? 1 : 0.6),
            }}
          >
            <Sans c={T.ink} s={36} w={row.on ? 600 : 400}>
              {row.text}
            </Sans>
          </div>
        ))}
      </Box>
    </>
  );
};

export const QuadStation: React.FC<P<'quad'>> = ({ s, f, dur, T }) => {
  const items = s.items.slice(0, 4);
  return (
    <>
      <Box x={120} y={170} w={600}>
        <div style={rise(land(f, 0))}>
          <Serif c={T.ink} s={fit(s.title, 72, 18, 46)}>
            {s.title}
          </Serif>
        </div>
        {s.tag ? (
          <div style={{ marginTop: 26, display: 'inline-block', background: T.accent, borderRadius: 8, padding: '8px 16px', ...rise(land(f, 2)) }}>
            <Mono c="#fff" s={20} w={700}>
              {s.tag}
            </Mono>
          </div>
        ) : null}
        {s.caption ? (
          <div style={{ marginTop: 26, ...rise(land(f, 3)) }}>
            <Sans c={T.ink2} s={27} w={400}>
              {s.caption}
            </Sans>
          </div>
        ) : null}
      </Box>
      <Box x={120} y={770} w={600} h={180} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {Array.from({ length: 34 }).map((_, i) => {
          const h = 16 + Math.abs(Math.sin(f / 4.5 + i * 0.7) * Math.sin(f / 11 + i * 0.23)) * 150 * ez(f, -4 + i * 0.2, 6 + i * 0.2);
          return <div key={i} style={{ width: 10, height: h, borderRadius: 5, background: i % 3 === 0 ? T.accent : alpha(T.ink, 0.75) }} />;
        })}
      </Box>
      {items.map((it, i) => {
        const x = 800 + (i % 2) * 520;
        const y = 160 + Math.floor(i / 2) * 400;
        const prog = ez(f, 4 + i * 5, 50 + i * 5);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width: 490,
              height: 370,
              boxSizing: 'border-box',
              ...card(T, { padding: 34 }),
              transform: `scale(${pop(f, 1 + i)}) translateY(${br(f, i, 5, 60)}px)`,
            }}
          >
            <div style={{ width: 64, height: 64, borderRadius: 12, background: i % 2 ? T.ink : T.wash, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 32, color: i % 2 ? '#fff' : T.accentInk }}>{it.title.slice(0, 1)}</div>
            </div>
            <Serif c={T.ink} s={fit(it.title, 50, 10, 34)} style={{ marginTop: 26 }}>
              {it.title}
            </Serif>
            <Sans c={T.ink2} s={25} w={400} style={{ marginTop: 12, minHeight: 64 }}>
              {it.detail}
            </Sans>
            <div style={{ marginTop: 22, height: 8, borderRadius: 4, background: T.rule, overflow: 'hidden' }}>
              <div style={{ height: 8, width: `${prog * 100}%`, background: i % 2 ? T.ink : T.accent }} />
            </div>
          </div>
        );
      })}
      <div style={{ position: 'absolute', opacity: across(f, dur, 1, 1) }} />
    </>
  );
};

export const CycleStation: React.FC<P<'cycle'>> = ({ s, f, dur, T }) => {
  const nodes = s.nodes.slice(0, 5);
  const n = nodes.length;
  const cx = 1240;
  const cy = 560;
  const R = 320;
  const bead = (f / 75) * Math.PI * 2 - Math.PI / 2;
  const active = Math.floor(((((bead + Math.PI / 2) / (Math.PI * 2)) * n) % n + n) % n);
  return (
    <>
      <Box x={120} y={220} w={620}>
        <div style={rise(land(f, 0))}>
          <Serif c={T.ink} s={fit(s.title, 80, 16, 50)}>
            {s.title}
          </Serif>
        </div>
        {s.caption ? (
          <div style={{ marginTop: 34, ...rise(land(f, 2)) }}>
            <Sans c={T.ink2} s={30} w={400}>
              {s.caption}
            </Sans>
          </div>
        ) : null}
      </Box>
      <svg width={1920} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
        <circle cx={cx} cy={cy} r={R} fill="none" stroke={T.rule} strokeWidth={6} pathLength={1} strokeDasharray={`${ez(f, -6, 12)} 1`} transform={`rotate(-90 ${cx} ${cy})`} />
        <path
          d={`M ${cx + Math.cos(bead - 0.9) * R} ${cy + Math.sin(bead - 0.9) * R} A ${R} ${R} 0 0 1 ${cx + Math.cos(bead) * R} ${cy + Math.sin(bead) * R}`}
          fill="none"
          stroke={T.accent}
          strokeWidth={8}
          strokeLinecap="round"
          opacity={ez(f, 0, 8)}
        />
        <circle cx={cx + Math.cos(bead) * R} cy={cy + Math.sin(bead) * R} r={16} fill={T.accent} opacity={ez(f, 0, 8)} />
      </svg>
      <div style={{ position: 'absolute', left: cx, top: cy, transform: `translate(-50%,-50%) scale(${pop(f, 0)})`, width: 260, height: 260, borderRadius: 999, background: T.wash, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 30, boxSizing: 'border-box' }}>
        <Serif c={T.accentInk} s={fit(s.center, 40, 12, 26)}>
          {s.center}
        </Serif>
      </div>
      {nodes.map((nd, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const on = i === active;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: cx + Math.cos(a) * R,
              top: cy + Math.sin(a) * R,
              transform: `translate(-50%,-50%) scale(${pop(f, 1 + i) * (on ? 1.08 : 1)})`,
              width: 340,
              ...card(T, { padding: '20px 24px', border: `2px solid ${on ? T.accent : T.rule}`, background: on ? T.accent : T.card }),
            }}
          >
            <Mono c={on ? '#fff' : T.faint} s={15}>
              {String(i + 1).padStart(2, '0')}
            </Mono>
            <Sans c={on ? '#fff' : T.ink} s={28} w={600} style={{ marginTop: 6 }}>
              {nd}
            </Sans>
          </div>
        );
      })}
      <div style={{ position: 'absolute', opacity: across(f, dur, 1, 1) }} />
    </>
  );
};

export const TermsStation: React.FC<P<'terms'>> = ({ s, f, dur, T }) => {
  const rows = s.rows.slice(0, 5);
  const rowH = Math.min(160, 640 / Math.max(1, rows.length));
  return (
    <>
      <Box x={120} y={830} w={1680} style={rise(land(f, 0))}>
        <Serif c={T.ink} s={fit(s.title, 96, 30, 56)}>
          {s.title}
        </Serif>
      </Box>
      {rows.map((r, i) => {
        const fill = ez(f, 2 + i * 5, 30 + i * 5);
        return (
          <Box key={i} x={120} y={150 + i * rowH} w={1680} h={rowH - 18} style={{ ...card(T, { padding: '0 34px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 30, overflow: 'hidden' }), ...rise(land(f, 1 + i)) }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${fill * 100}%`, background: alpha(T.accent, 0.1) }} />
            <div style={{ position: 'absolute', left: 0, bottom: 0, height: 5, width: `${fill * 100}%`, background: T.accent }} />
            <Mono c={T.ink2} s={18} style={{ width: 300, position: 'relative' }}>
              {r.label}
            </Mono>
            <Sans c={T.ink} s={44} w={600} style={{ position: 'relative', flex: 1 }}>
              {r.value}
            </Sans>
            <div style={{ position: 'relative' }}>
              <Check c={T.green} t={fill > 0.95 ? 1 : fill} size={40} />
            </div>
          </Box>
        );
      })}
      {s.caption ? (
        <Box x={120} y={950} w={1680} style={rise(land(f, 2 + rows.length))}>
          <Sans c={T.ink2} s={26} w={400}>
            {s.caption}
          </Sans>
        </Box>
      ) : null}
      <div style={{ position: 'absolute', opacity: across(f, dur, 1, 1) }} />
    </>
  );
};

export const CtaStation: React.FC<P<'cta'>> = ({ s, f, dur, T, name, route }) => {
  const click = Math.min(dur - 20, 44);
  const pressed = f > click - 2 && f < click + 6;
  const ripple = clamp((f - click) / 26);
  return (
    <>
      <Box x={0} y={150} w={1920} style={{ textAlign: 'center', ...rise(land(f, 0)) }}>
        <Mono c={T.accentInk} s={22} ls={5}>
          {name}
        </Mono>
      </Box>
      <Box x={160} y={210} w={1600} style={{ textAlign: 'center', clipPath: `inset(-20px ${50 - 50 * ez(f, -4, 12)}% -30px ${50 - 50 * ez(f, -4, 12)}%)` }}>
        <Serif c={T.ink} s={fit(s.headline, 150, 16, 90)}>
          {s.headline}
        </Serif>
      </Box>
      <div style={{ position: 'absolute', left: 960, top: 560, transform: `translate(-50%,-50%) scale(${pop(f, 2) * (pressed ? 0.95 : 1 + br(f, 0, 0.015, 30))})` }}>
        <div style={{ background: T.accent, borderRadius: 14, padding: '34px 70px', boxShadow: `0 0 0 ${ripple > 0 && ripple < 1 ? ripple * 60 : 0}px ${alpha(T.accent, 0.25 * (1 - ripple))}, 0 24px 60px ${alpha(T.accent, 0.35)}` }}>
          <Sans c="#fff" s={48} w={700}>
            {s.button} →
          </Sans>
        </div>
      </div>
      <Box x={0} y={680} w={1920} style={{ textAlign: 'center', ...rise(land(f, 3)) }}>
        <div style={{ fontFamily: MONO, fontSize: 38, fontWeight: 500, color: T.ink, letterSpacing: 1 }}>{s.url}</div>
      </Box>
      <Box x={0} y={790} w={1920} style={{ display: 'flex', justifyContent: 'center', gap: 22 }}>
        {(s.notes ?? []).slice(0, 3).map((n, i) => (
          <div key={i} style={{ ...card(T, { padding: '16px 24px', display: 'flex', gap: 12, alignItems: 'center' }), ...rise(land(f, 4 + i)) }}>
            <Check c={T.green} t={ez(f, 8 + i * 6, 18 + i * 6)} size={28} />
            <Sans c={T.ink} s={26}>
              {n}
            </Sans>
          </div>
        ))}
      </Box>
      <div style={{ position: 'absolute', left: 0, top: 930, width: 1920, height: 70, overflow: 'hidden', WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)', opacity: ez(f, 2, 12) }}>
        <div style={{ display: 'flex', gap: 14, transform: `translateX(${-f * 6}px)`, whiteSpace: 'nowrap' }}>
          {[...route, ...route].map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>
              <div style={{ padding: '12px 18px', borderRadius: 999, border: `1.5px solid ${i % route.length === route.length - 1 ? T.accent : T.rule}`, background: T.card }}>
                <Mono c={T.ink2} s={16} ls={2}>
                  {String((i % route.length) + 1).padStart(2, '0')} {r}
                </Mono>
              </div>
              <div style={{ width: 26, height: 3, background: T.accent, borderRadius: 2 }} />
            </div>
          ))}
        </div>
      </div>
      <svg width={40} height={52} viewBox="0 0 40 52" style={{ position: 'absolute', left: interpolateLin(f, [0, click - 2], [1500, 1020]), top: interpolateLin(f, [0, click - 2], [900, 575]), opacity: ez(f, 4, 10) }}>
        <path d="M4 3 L4 42 L14 32 L21 48 L28 45 L21 29 L35 29 Z" fill={T.ink} stroke="#fff" strokeWidth={3} strokeLinejoin="round" />
      </svg>
    </>
  );
};

export const STATION_COMPONENTS: { [K in Station['kind']]: React.FC<P<K>> } = {
  title: TitleStation,
  numeral: NumeralStation,
  versus: VersusStation,
  ring: RingStation,
  wall: WallStation,
  burst: BurstStation,
  ladder: LadderStation,
  filter: FilterStation,
  steps: StepsStation,
  chat: ChatStation,
  range: RangeStation,
  repeat: RepeatStation,
  clock: ClockStation,
  strike: StrikeStation,
  redact: RedactStation,
  options: OptionsStation,
  gate: GateStation,
  flow: FlowStation,
  countdown: CountdownStation,
  quad: QuadStation,
  cycle: CycleStation,
  terms: TermsStation,
  cta: CtaStation,
};

export { SANS };
