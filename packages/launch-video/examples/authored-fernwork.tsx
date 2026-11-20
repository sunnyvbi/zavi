import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from 'remotion';

export const AUTHORED_FRAMES = 1800;

const INK = '#0e0f11';
const SUB = '#54585e';
const PAPER = '#fbfbfa';
const NIGHT = '#0e0f11';
const NIGHT_SUB = '#8b9199';
const RULE = 'rgba(14,15,17,0.10)';
const ACCENT = '#8c3a1e';
const OK = '#1d5c3a';

const SANS = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

const wipeX = (frame: number, at: number, len = 5): string => {
  const p = interpolate(frame, [at, at + len], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.2, 0.9, 0.2, 1),
  });
  return `inset(0 ${100 - p}% 0 0)`;
};

const wipeY = (frame: number, at: number, len = 5): string => {
  const p = interpolate(frame, [at, at + len], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.2, 0.9, 0.2, 1),
  });
  return `inset(0 0 ${100 - p}% 0)`;
};

const drift = (frame: number, dur: number, from: number, to: number): number =>
  interpolate(frame, [0, dur], [from, to], { extrapolateRight: 'clamp' });

const countTo = (frame: number, dur: number, target: number): number => {
  const p = interpolate(frame, [4, Math.round(dur * 0.82)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  return target * p + Math.sin(frame / 11) * 0.49 * p;
};

const Scan: React.FC<{ frame: number; dur: number; dark?: boolean }> = ({ frame, dur, dark }) => (
  <AbsoluteFill style={{ overflow: 'hidden', pointerEvents: 'none' }}>
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        height: 2,
        top: `${drift(frame, dur, -4, 104)}%`,
        background: dark
          ? 'linear-gradient(90deg, transparent, rgba(251,251,250,0.16), transparent)'
          : 'linear-gradient(90deg, transparent, rgba(14,15,17,0.10), transparent)',
      }}
    />
  </AbsoluteFill>
);

const Grid: React.FC<{ frame: number; dur: number; dark?: boolean }> = ({ frame, dur, dark }) => {
  const lit = drift(frame, dur, 0, 12);
  return (
    <AbsoluteFill>
      {Array.from({ length: 13 }, (_, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: `${(i / 12) * 100}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: dark ? 'rgba(251,251,250,0.10)' : RULE,
            opacity: (i <= lit ? 1 : 0.25) * (0.86 + 0.14 * Math.sin((frame + i * 9) / 17)),
          }}
        />
      ))}
    </AbsoluteFill>
  );
};

const Chrome: React.FC<{ frame: number; label: string; dark?: boolean }> = ({ frame, label, dark }) => {
  const p = (frame / AUTHORED_FRAMES) * 100;
  return (
    <>
      <div style={{ position: 'absolute', top: 44, left: 64, fontFamily: MONO, fontSize: 13, letterSpacing: '0.14em', color: dark ? NIGHT_SUB : SUB, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ position: 'absolute', top: 44, right: 64, fontFamily: MONO, fontSize: 13, letterSpacing: '0.14em', color: dark ? NIGHT_SUB : SUB }}>
        FERNWORK
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: dark ? 'rgba(251,251,250,0.14)' : RULE }}>
        <div style={{ width: `${p}%`, height: '100%', background: ACCENT }} />
      </div>
    </>
  );
};

type ShotProps = { frame: number; dur: number; dark?: boolean };

const Hook: React.FC<ShotProps> = ({ frame, dur }) => {
  const words = ['Plant care', 'that proves', 'it showed up.'];
  return (
    <>
      <div style={{ position: 'absolute', left: 64, top: 300, right: 300 }}>
        {words.map((w, i) => (
          <div key={w} style={{ overflow: 'hidden', clipPath: wipeX(frame, i * 6, 5) }}>
            <div style={{ fontFamily: SANS, fontSize: 104, fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.05, color: INK }}>{w}</div>
          </div>
        ))}
        <div style={{ marginTop: 34, height: 2, background: ACCENT, width: `${drift(frame, dur, 0, 46)}%` }} />
        <div style={{ marginTop: 26, fontFamily: SANS, fontSize: 27, color: SUB, opacity: interpolate(frame, [34, 48], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
          Fernwork schedules and tracks indoor plant care for office buildings.
        </div>
      </div>
    </>
  );
};

const Problem: React.FC<ShotProps> = ({ frame, dur, dark }) => {
  const rows = ['Spreadsheets', 'Paper route sheets', 'A plant dies between visits'];
  const ink = dark ? PAPER : INK;
  const sub = dark ? NIGHT_SUB : SUB;
  return (
    <div style={{ position: 'absolute', left: 64, top: 280, right: 200 }}>
      <div style={{ fontFamily: MONO, fontSize: 14, letterSpacing: '0.16em', color: ACCENT, textTransform: 'uppercase', clipPath: wipeX(frame, 0, 4) }}>
        Today
      </div>
      {rows.map((r, i) => {
        const at = 4 + i * 20;
        const strike = interpolate(frame, [at + 14, at + 30], [0, 100], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return (
          <div key={r} style={{ position: 'relative', marginTop: 26, clipPath: wipeX(frame, at, 5) }}>
            <div style={{ fontFamily: SANS, fontSize: 62, fontWeight: 500, color: i === rows.length - 1 ? ink : sub, letterSpacing: '-0.02em' }}>{r}</div>
            {i < rows.length - 1 ? (
              <div style={{ position: 'absolute', left: 0, top: '52%', height: 3, width: `${strike}%`, background: ACCENT, opacity: 0.85 }} />
            ) : null}
          </div>
        );
      })}
      <div style={{ marginTop: 40, fontFamily: SANS, fontSize: 26, color: sub, opacity: drift(frame, dur, 0, 1.6) }}>
        Nobody can prove a planter was checked.
      </div>
    </div>
  );
};

const Surface: React.FC<ShotProps> = ({ frame, dur }) => {
  const rows = [
    { t: "Today's stops", m: '14 buildings', c: OK },
    { t: 'Floor plan with planters', m: 'live', c: ACCENT },
    { t: 'Last four visit photos', m: 'attached', c: OK },
    { t: 'Next visit date', m: 'scheduled', c: ACCENT },
  ];
  const lift = drift(frame, dur, 14, -6);
  return (
    <div style={{ position: 'absolute', left: 64, right: 64, top: 200, transform: `translateY(${lift}px)` }}>
      <div style={{ fontFamily: SANS, fontSize: 46, fontWeight: 600, color: INK, letterSpacing: '-0.02em', clipPath: wipeX(frame, 0, 4) }}>
        Inside Fernwork
      </div>
      <div style={{ marginTop: 28, border: `1px solid ${RULE}`, background: '#fff', borderRadius: 10, overflow: 'hidden', clipPath: wipeY(frame, 2, 6) }}>
        <div style={{ display: 'flex', gap: 8, padding: '14px 18px', borderBottom: `1px solid ${RULE}` }}>
          {['#e0604f', '#e0a13c', '#42e08a'].map((c) => (
            <div key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c, opacity: 0.55 }} />
          ))}
          <div style={{ marginLeft: 14, fontFamily: MONO, fontSize: 13, color: SUB }}>route board</div>
        </div>
        {rows.map((r, i) => {
          const at = 26 + i * 20;
          return (
            <div key={r.t} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '26px 24px', borderBottom: i < rows.length - 1 ? `1px solid ${RULE}` : 'none', clipPath: wipeX(frame, at, 5) }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ width: 8, height: 8, borderRadius: 5, background: r.c }} />
                <div style={{ fontFamily: SANS, fontSize: 30, fontWeight: 500, color: INK }}>{r.t}</div>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 17, color: SUB }}>{r.m}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Capability: React.FC<ShotProps & { index: number; total: number; title: string; body: string; rows: string[] }> = ({
  frame,
  dur,
  dark,
  index,
  total,
  title,
  body,
  rows,
}) => {
  const ink = dark ? PAPER : INK;
  const sub = dark ? NIGHT_SUB : SUB;
  const hair = dark ? 'rgba(251,251,250,0.14)' : RULE;
  const rule = drift(frame, dur, 0, 100);
  const slide = drift(frame, dur, 0, -8);
  return (
    <div style={{ position: 'absolute', left: 64, right: 64, top: 250, transform: `translateY(${slide}px)` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 26 }}>
        <div style={{ fontFamily: MONO, fontSize: 19, color: ACCENT, clipPath: wipeX(frame, 0, 3) }}>
          {String(index).padStart(2, '0')} / {String(total).padStart(2, '0')}
        </div>
        <div style={{ flex: 1, height: 1, background: hair }}>
          <div style={{ width: `${rule}%`, height: '100%', background: ACCENT, opacity: 0.5 }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 64, marginTop: 34, alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 46%' }}>
          <div style={{ overflow: 'hidden', clipPath: wipeX(frame, 0, 4) }}>
            <div style={{ fontFamily: SANS, fontSize: 68, fontWeight: 600, letterSpacing: '-0.03em', color: ink, lineHeight: 1.05 }}>{title}</div>
          </div>
          <div style={{ marginTop: 22, fontFamily: SANS, fontSize: 26, lineHeight: 1.45, color: sub, clipPath: wipeX(frame, 12, 7) }}>
            {body}
          </div>
        </div>
        {}
        <div style={{ flex: 1, border: `1px solid ${hair}`, borderRadius: 8, overflow: 'hidden', background: dark ? 'rgba(251,251,250,0.04)' : '#fff', clipPath: wipeY(frame, 2, 5) }}>
          {rows.map((r, i) => {
            const last = i === rows.length - 1;
            return (
              <div
                key={r}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '19px 22px',
                  borderBottom: last ? 'none' : `1px solid ${hair}`,
                  clipPath: wipeX(frame, 12 + i * 13, 5),
                  background: last ? (dark ? 'rgba(140,58,30,0.22)' : 'rgba(140,58,30,0.06)') : 'transparent',
                }}
              >
                <div style={{ width: 7, height: 7, borderRadius: 4, background: last ? ACCENT : hair }} />
                <div style={{ fontFamily: MONO, fontSize: 20, color: last ? ink : sub }}>{r}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const Numbers: React.FC<ShotProps> = ({ frame, dur, dark }) => {
  const ink = dark ? PAPER : INK;
  const sub = dark ? NIGHT_SUB : SUB;
  const hero = countTo(frame, dur, 412);
  const rest = [
    { v: '9 to 4', label: 'Visits per month' },
    { v: '$37,890', label: 'Replacement cost avoided' },
  ];
  return (
    <div style={{ position: 'absolute', left: 64, right: 64, top: 200 }}>
      <div style={{ fontFamily: MONO, fontSize: 14, letterSpacing: '0.16em', color: ACCENT, textTransform: 'uppercase', clipPath: wipeX(frame, 0, 3) }}>
        Traction
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 48, marginTop: 10 }}>
        <div style={{ clipPath: wipeY(frame, 0, 5) }}>
          <div style={{ fontFamily: SANS, fontSize: 420, fontWeight: 600, letterSpacing: '-0.05em', lineHeight: 0.86, color: ink }}>
            {Math.round(hero)}
          </div>
          <div style={{ marginTop: 10, fontFamily: SANS, fontSize: 30, color: sub }}>Buildings under care</div>
        </div>
        <div style={{ flex: 1, paddingBottom: 26 }}>
          {rest.map((r, i) => (
            <div key={r.label} style={{ paddingTop: 20, marginTop: 20, borderTop: `1px solid ${dark ? 'rgba(251,251,250,0.14)' : RULE}`, clipPath: wipeX(frame, 30 + i * 16, 6) }}>
              <div style={{ fontFamily: MONO, fontSize: 44, color: ink, letterSpacing: '-0.01em' }}>{r.v}</div>
              <div style={{ marginTop: 6, fontFamily: SANS, fontSize: 19, color: sub }}>{r.label}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 34, height: 1, background: dark ? 'rgba(251,251,250,0.14)' : RULE }}>
        <div style={{ width: `${drift(frame, dur, 0, 100)}%`, height: '100%', background: ACCENT, opacity: 0.55 }} />
      </div>
    </div>
  );
};

const Coverage: React.FC<ShotProps> = ({ frame, dur, dark }) => {
  const ink = dark ? PAPER : INK;
  const sub = dark ? NIGHT_SUB : SUB;
  const hair = dark ? 'rgba(251,251,250,0.14)' : RULE;
  const places = ['Portland', 'Boise', 'Spokane'];
  const n = Math.min(places.length, Math.floor(interpolate(frame, [2, 44], [0, places.length + 0.99], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })));
  return (
    <div style={{ position: 'absolute', left: 64, right: 64, top: 300 }}>
      <div style={{ fontFamily: SANS, fontSize: 52, fontWeight: 600, color: ink, letterSpacing: '-0.02em', clipPath: wipeX(frame, 0, 4) }}>
        Where Fernwork operates.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 34, marginTop: 46 }}>
        <div style={{ fontFamily: SANS, fontSize: 130, fontWeight: 600, color: ink, letterSpacing: '-0.04em' }}>{n}</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {places.map((p, i) => (
            <div key={p} style={{ padding: '14px 22px', border: `1px solid ${hair}`, borderRadius: 999, background: dark ? 'rgba(251,251,250,0.06)' : '#fff', fontFamily: SANS, fontSize: 25, color: ink, clipPath: wipeX(frame, 6 + i * 12, 5) }}>
              {p}
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 34, height: 1, background: hair }}>
        <div style={{ width: `${drift(frame, dur, 0, 100)}%`, height: '100%', background: ACCENT, opacity: 0.55 }} />
      </div>
      <div style={{ marginTop: 18, fontFamily: MONO, fontSize: 15, color: sub, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        Live markets
      </div>
    </div>
  );
};

const Close: React.FC<ShotProps> = ({ frame, dur }) => {
  const fill = interpolate(frame, [0, Math.round(dur * 0.92)], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.2, 0.9, 0.2, 1),
  });
  const lift = drift(frame, dur, 16, 0);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', transform: `translateY(${lift}px)` }}>
        <div style={{ overflow: 'hidden', clipPath: wipeY(frame, 0, 6) }}>
          <div style={{ fontFamily: SANS, fontSize: 132, fontWeight: 600, letterSpacing: '-0.04em', color: PAPER, lineHeight: 1 }}>
            Start free.
          </div>
        </div>
        <div style={{ marginTop: 38, display: 'inline-block', position: 'relative', borderRadius: 8, border: `1px solid ${PAPER}`, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, width: `${fill}%`, background: PAPER }} />
          <div style={{ position: 'relative', padding: '20px 40px', fontFamily: SANS, fontSize: 28, fontWeight: 500, color: PAPER, whiteSpace: 'nowrap' }}>
            fernwork.example.com
          </div>
          {}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              clipPath: `inset(0 ${100 - fill}% 0 0)`,
              padding: '20px 40px',
              fontFamily: SANS,
              fontSize: 28,
              fontWeight: 500,
              color: NIGHT,
              whiteSpace: 'nowrap',
            }}
          >
            fernwork.example.com
          </div>
        </div>
        <div style={{ marginTop: 44, fontFamily: SANS, fontSize: 27, color: NIGHT_SUB, opacity: drift(frame, dur, 0, 1.5) }}>
          Every planter, every visit, on the record.
        </div>
      </div>
    </AbsoluteFill>
  );
};

type Surface = 'paper' | 'dark';
type Shot = {
  at: number;
  dur: number;
  label: string;
  surface?: Surface;
  render: (p: ShotProps) => React.ReactNode;
};

const CAPS: Array<{ title: string; body: string; rows: string[] }> = [
  { title: 'QR-code planter check-in', body: 'Technicians scan a QR code on each planter to confirm arrival, log work, and keep the route accurate in real time.', rows: ['Lobby, planter 14', 'Floor 3, planter 02', 'Floor 3, planter 07', 'Atrium, planter 21 scanned'] },
  { title: 'Early plant-death alerts', body: 'Fernwork flags a declining plant three weeks before it is likely to die, while there is still time to intervene.', rows: ['Ficus, lobby', 'Dracaena, floor 2', 'Pothos, floor 5', 'Fern, atrium, declining'] },
  { title: 'Per-building billing', body: 'Invoices are generated from the number of planters actually serviced, so the line items reconcile themselves.', rows: ['Harbour Tower', 'Alder Court', 'Vine Street', 'Mill Yard, invoice ready'] },
  { title: 'Account-free shared calendar', body: 'Building contacts and facilities staff see the schedule without creating an account or asking anyone for access.', rows: ['Mon, Harbour Tower', 'Wed, Alder Court', 'Thu, Vine Street', 'Fri, Mill Yard, confirmed'] },
  { title: 'Warranty plant tracking', body: 'Every plant covered under a replacement warranty is tracked separately, so credits are claimed before they lapse.', rows: ['12 under warranty', '3 replaced this quarter', '1 claim open', '2 expire next month'] },
];

const SHOTS: Shot[] = (() => {
  const out: Shot[] = [];
  let at = 0;
  const push = (dur: number, label: string, render: Shot['render'], surface: Surface = 'paper') => {
    if (dur <= 0) throw new Error(`shot "${label}" has non-positive duration ${dur}: the table overran AUTHORED_FRAMES`);
    out.push({ at, dur, label, surface, render });
    at += dur;
  };
  push(180, 'open', (p) => <Hook {...p} />);
  push(200, 'today', (p) => <Problem {...p} />, 'dark');
  push(220, 'product', (p) => <Surface {...p} />);
  push(150, 'what it does', (p) => <Capability {...p} index={1} total={5} {...CAPS[0]!} />);
  push(150, 'what it does', (p) => <Capability {...p} index={2} total={5} {...CAPS[1]!} />);
  push(180, 'traction', (p) => <Numbers {...p} />, 'dark');
  push(150, 'what it does', (p) => <Capability {...p} index={3} total={5} {...CAPS[2]!} />);
  push(150, 'what it does', (p) => <Capability {...p} index={4} total={5} {...CAPS[3]!} />);
  push(160, 'coverage', (p) => <Coverage {...p} />, 'dark');
  push(150, 'what it does', (p) => <Capability {...p} index={5} total={5} {...CAPS[4]!} />);
  push(AUTHORED_FRAMES - at, 'start', (p) => <Close {...p} />, 'dark');
  return out;
})();

export const AuthoredFilm: React.FC = () => {
  const frame = useCurrentFrame();
  const shot = SHOTS.find((s) => frame >= s.at && frame < s.at + s.dur) ?? SHOTS[SHOTS.length - 1]!;
  const local = frame - shot.at;
  const dark = shot.surface === 'dark';
  return (
    <AbsoluteFill style={{ background: dark ? NIGHT : PAPER, color: dark ? PAPER : INK }}>
      <Grid frame={local} dur={shot.dur} dark={dark} />
      {}
      <Scan frame={local} dur={shot.dur} dark={dark} />
      {shot.render({ frame: local, dur: shot.dur, dark })}
      {}
      <div style={{ position: 'absolute', left: 64, right: 64, top: 128, height: 1, background: dark ? 'rgba(251,251,250,0.10)' : RULE }}>
        <div
          style={{
            width: `${(Math.min(local, shot.dur) / shot.dur) * 100}%`,
            height: '100%',
            background: ACCENT,
            opacity: 0.5,
          }}
        />
      </div>
      <Chrome frame={frame} label={shot.label} dark={dark} />
    </AbsoluteFill>
  );
};
