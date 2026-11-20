import React, { createContext, useContext } from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import type { FilmContent } from '../content';
import {
  PalCtx, makePal, usePal, ez, fast, br, drop, typed, caret, lerp,
  Stage, Mono, serif, bullet, AppBar, Pill, Btn, Field, Avatar, Tick, Cursor, Phone, Bubble, Clock,
  SERIF, MONO, W,
} from './kit';
import { type InUse, type InUseCard, type ShotId, resolveInUse, shotIds, planDurations, inUseFrames } from './plan';

export type { FilmContent };

type Ctx = { u: InUse; name: string; ids: ShotId[] };
const UCtx = createContext<Ctx>({ u: { hook: { headline: '' }, steps: [], close: { headline: '', cta: '', url: '' } }, name: '', ids: [] });
const useU = () => useContext(UCtx);

const sl = (name: string, what: string) => `${name} · ${what}`;

const nums = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

const fit = (t: string, sizes: [number, number][]) => {
  for (const [max, size] of sizes) if (t.length <= max) return size;
  return sizes[sizes.length - 1][1];
};

const ResultCard: React.FC<{ card: InUseCard; at: number; w?: number; s?: number; hot?: boolean; action?: string; press?: number }> = ({ card, at, w = 420, s = 1, hot, action, press }) => {
  const f = useCurrentFrame();
  const P = usePal();
  const g = Math.min(1, drop(f, at));
  return (
    <div
      style={{
        width: w, borderRadius: 14, background: P.CARD, border: `${hot ? 2.5 : 1.5}px solid ${hot ? P.A : P.RULE}`,
        padding: `${20 * s}px ${22 * s}px`, opacity: Math.min(1, ez(f, at, at + 5)),
        transform: `translateY(${(1 - g) * 40}px)`, boxShadow: hot ? `0 30px 60px -30px ${P.A}88` : '0 16px 36px -28px rgba(0,0,0,.35)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 * s }}>
        <Avatar t={card.title} s={52 * s} ring={hot} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 22 * s, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.title}</div>
          <div style={{ fontSize: 16 * s, color: P.MUTED, marginTop: 2 }}>{card.sub}</div>
        </div>
        {card.badge ? (
          <span style={{ fontSize: 13 * s, fontWeight: 700, color: P.GOOD, background: '#E7F4EC', borderRadius: 999, padding: `${5 * s}px ${10 * s}px`, whiteSpace: 'nowrap' }}>{card.badge}</span>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 8 * s, marginTop: 14 * s, flexWrap: 'wrap' }}>
        {card.tags.slice(0, 3).map((t) => (
          <span key={t} style={{ fontSize: 14 * s, fontWeight: 600, padding: `${4 * s}px ${10 * s}px`, borderRadius: 999, background: P.AT, color: P.AI }}>{t}</span>
        ))}
      </div>
      <div style={{ marginTop: 12 * s }}>
        {card.rows.slice(0, 3).map(([k, v], i) => (
          <div key={k + i} style={{ display: 'flex', gap: 12, padding: `${6 * s}px 0`, borderTop: `1px solid ${P.RULE}`, fontSize: 15 * s }}>
            <span style={{ fontFamily: MONO, fontSize: 12 * s, letterSpacing: 1, textTransform: 'uppercase', color: P.MUTED, width: 120 * s, flex: 'none', paddingTop: 2 }}>{k}</span>
            <span style={{ color: P.SOFT, fontWeight: 600 }}>{v}</span>
          </div>
        ))}
      </div>
      {action ? (
        <div style={{ display: 'flex', gap: 10, marginTop: 14 * s }}>
          <Btn t={action} at={at} s={0.85 * s} press={press} />
          <Btn t="View profile" at={at} s={0.85 * s} ghost />
        </div>
      ) : null}
    </div>
  );
};

const StepGlyph: React.FC<{ i: number; s?: number; on: number }> = ({ i, s = 64, on }) => {
  const P = usePal();
  const c = on > 0.5 ? P.A : P.MUTED;
  const k = i % 4;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none" stroke={c} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      {k === 0 ? (<><circle cx={21} cy={21} r={11} /><line x1={29} y1={29} x2={39} y2={39} /></>) : null}
      {k === 1 ? (<><path d="M8 12 h32 v20 h-18 l-8 7 v-7 h-6 z" /><line x1={15} y1={20} x2={33} y2={20} /><line x1={15} y1={26} x2={27} y2={26} /></>) : null}
      {k === 2 ? (<><path d="M24 6 l4 12 l12 4 l-12 4 l-4 12 l-4 -12 l-12 -4 l12 -4 z" /></>) : null}
      {k === 3 ? (<><rect x={7} y={10} width={34} height={30} rx={4} /><line x1={7} y1={19} x2={41} y2={19} /><line x1={16} y1={6} x2={16} y2={13} /><line x1={32} y1={6} x2={32} y2={13} /><rect x={14} y={25} width={8} height={7} fill={c} /></>) : null}
    </svg>
  );
};

const SHOT_ORDER: ShotId[] = [
  'hook', 'anchor', 'findList', 'findRuler', 'findAssemble', 'catalog',
  'results', 'pick', 'profile', 'threadType', 'threadPhone', 'book', 'bookStatus',
  'clocks', 'week', 'pay', 'split', 'policy', 'checklist', 'extra', 'extraRecap',
  'reviews', 'supply', 'steps', 'close',
];

const SHOTS: React.FC<{ dur: number }>[] = [
  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const filters = u.find?.filters ?? [];
    const cards = u.results?.cards ?? [];
    const strip = filters[0]?.options ?? u.steps.map((s) => s.title);
    const hs = fit(u.hook.headline, [[20, 96], [32, 74], [60, 56], [999, 44]]);
    return (
      <Stage dur={dur} slate={sl(name, 'the front door')} from={{ x: 960, y: 540, s: 1.0 }} to={{ x: 930, y: 556, s: 1.07 }}>
        <div style={{ position: 'absolute', left: 70, top: 84, width: 1780, height: 930, borderRadius: 16, background: P.CARD, border: `1.5px solid ${P.RULE}`, overflow: 'hidden', boxShadow: '0 40px 90px -50px rgba(0,0,0,.45)' }}>
          <AppBar name={u.app_name ?? name} nav={u.nav ?? u.steps.map((s) => s.title)} w={1780} />
          <div style={{ position: 'absolute', left: 0, top: 70, width: 1780, height: 600, background: `linear-gradient(180deg, ${P.A} 0%, ${P.A} 100%)` }} />
          <div style={{ position: 'absolute', left: 70, top: 112, width: 960 }}>
            {u.hook.kicker ? <div style={{ opacity: fast(f, 0) }}><Mono s={15} c="#1b1b1b">{u.hook.kicker}</Mono></div> : null}
            <div style={{ ...serif(P, hs, undefined), ...{ marginTop: 18, clipPath: `inset(0 ${100 - 100 * ez(f, 1, 12)}% 0 0)` } }}>{u.hook.headline}</div>
            {u.hook.sub ? <div style={{ ...serif(P, Math.round(hs * 0.62), undefined), ...{ marginTop: 6, clipPath: `inset(0 ${100 - 100 * ez(f, 4, 16)}% 0 0)` } }}>{u.hook.sub}</div> : null}
            {u.hook.body ? <div style={{ fontSize: 22, lineHeight: 1.4, marginTop: 14, maxWidth: 900, opacity: fast(f, 3), color: '#1b1b1b' }}>{u.hook.body}</div> : null}
          </div>
          {filters.length > 0 ? (
            <div style={{ position: 'absolute', left: 70, top: 486, width: 860, padding: 18, borderRadius: 14, background: P.CARD, boxShadow: '0 0 0 4px rgba(255,255,255,.55), 0 20px 40px -24px rgba(0,0,0,.4)', opacity: fast(f, 4) }}>
              <div style={{ display: 'flex', gap: 14 }}>
                {filters.slice(0, 3).map((x, i) => <Field key={x.label} label={x.label} at={4 + i} w={262} s={0.9} />)}
              </div>
              <div style={{ marginTop: 16 }}><Btn t={u.find?.button ?? 'Start'} at={6} w="100%" /></div>
            </div>
          ) : null}
          <div style={{ position: 'absolute', left: 1010, top: 130, width: 700, height: 520 }}>
            {cards.slice(0, 3).map((c, i) => (
              <div key={i} style={{ position: 'absolute', left: i * 70, top: i * 150 + br(f, i, 6, 60), transform: `rotate(${[-2.5, 1.5, -1][i]}deg)` }}>
                <ResultCard card={c} at={3 + i * 2} w={520} s={0.92} hot={i === (u.results?.pick ?? 0)} />
              </div>
            ))}
            {cards.length === 0
              ? (u.hook.notes ?? u.steps.map((s) => s.title)).slice(0, 4).map((t, i) => (
                  <div key={t} style={{ position: 'absolute', left: i * 40, top: i * 120, width: 560, padding: '26px 30px', borderRadius: 14, background: P.CARD, fontSize: 28, fontWeight: 700, opacity: fast(f, 3 + i), transform: `rotate(${[-2, 1.5, -1, 2][i]}deg) translateY(${br(f, i, 6, 60)}px)` }}>
                    {t}
                  </div>
                ))
              : null}
          </div>
          <div style={{ position: 'absolute', left: 70, top: 708, display: 'flex', gap: 26, opacity: fast(f, 7) }}>
            {(u.hook.notes ?? []).slice(0, 3).map((t) => (
              <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 19, color: P.SOFT, fontWeight: 600 }}>{bullet(P, 22)}{t}</span>
            ))}
          </div>
          <div style={{ position: 'absolute', left: 0, top: 772, width: 1780, height: 158, borderTop: `1px solid ${P.RULE}`, background: P.G, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: 70, top: 22 }}><Mono s={13}>{u.find?.title ?? u.steps.map((s) => s.title).join(' · ')}</Mono></div>
            <div style={{ position: 'absolute', top: 62, left: 0, display: 'flex', gap: 14, transform: `translateX(${-lerp(f, dur, 0, 700) + 70}px)` }}>
              {[...strip, ...strip].slice(0, 40).map((t, i) => (
                <span key={i} style={{ fontSize: 22, fontWeight: 600, whiteSpace: 'nowrap', padding: '14px 22px', borderRadius: 12, border: `1.5px solid ${P.RULE}`, background: P.CARD, opacity: fast(f, 6 + Math.min(i, 6) * 0.5) }}>{t}</span>
              ))}
            </div>
          </div>
        </div>
        <Cursor path={[[1500, 980, 0], [560, 650, dur - 6]]} />
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const a = u.anchor!;
    const tn = nums(a.them.value);
    const un = nums(a.us.value);
    const hi = tn.length ? Math.max(...tn) : 0;
    const lo = un.length ? un[0] : 0;
    const bars = hi > 0 && lo > 0 && lo < hi;
    const cnt = bars ? Math.round(hi - (hi - lo) * ez(f, 8, 34)) : 0;
    const usShown = bars && f < 34 ? a.us.value.replace(String(lo), String(cnt)) : a.us.value;
    const strike = ez(f, 12, 24);
    const big = fit(a.them.value, [[5, 220], [8, 168], [14, 120], [999, 84]]);
    return (
      <Stage dur={dur} slate={sl(name, 'what it costs')} from={{ x: 920, y: 520, s: 1.03 }} to={{ x: 1000, y: 540, s: 1.06 }}>
        <div style={{ position: 'absolute', left: 140, top: 130, width: 800 }}>
          <Mono s={15}>{a.them.label}</Mono>
          <div style={{ position: 'relative', marginTop: 10, opacity: fast(f, 0) }}>
            <div style={{ ...serif(P, big, P.MUTED), ...{ whiteSpace: 'nowrap' } }}>{a.them.value}</div>
            <div style={{ position: 'absolute', left: -10, top: '52%', height: 10, width: `${strike * 104}%`, background: P.BAD, borderRadius: 4, transform: 'rotate(-4deg)' }} />
          </div>
          {a.source ? <div style={{ marginTop: 10, opacity: fast(f, 2) }}><Mono s={13}>{a.source}</Mono></div> : null}
        </div>
        <div style={{ position: 'absolute', left: 980, top: 210, fontSize: 90, color: P.A, fontWeight: 300, opacity: fast(f, 3), transform: `translateX(${br(f, 1, 10, 30)}px)` }}>→</div>
        <div style={{ position: 'absolute', left: 1100, top: 120, width: 740 }}>
          <Mono s={15} c={P.AI}>{a.us.label}</Mono>
          <div style={{ ...serif(P, fit(a.us.value, [[8, 300], [14, 170], [999, 90]]), P.AI), ...{ marginTop: 6, opacity: fast(f, 1) } }}>{usShown}</div>
        </div>
        {bars ? (
          <div style={{ position: 'absolute', left: 110, top: 600, width: 1700 }}>
            {[[a.them.label, hi, P.MUTED, a.them.value], [a.us.label, lo, P.A, a.us.value]].map(([l, v, c, t], i) => {
              const g = ez(f, 4 + i * 3, 26 + i * 3);
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 22, marginTop: i ? 22 : 0 }}>
                  <div style={{ width: 380, fontSize: 19, fontWeight: 600, color: P.SOFT }}>{String(l)}</div>
                  <div style={{ flex: 1, height: 58, background: P.G2, borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(Number(v) / hi) * 100 * g}%`, minWidth: 14, background: String(c), borderRadius: 10 }} />
                  </div>
                  <div style={{ width: 150, fontFamily: MONO, fontSize: 22, fontWeight: 700 }}>{String(t)}</div>
                </div>
              );
            })}
          </div>
        ) : null}
        <div style={{ position: 'absolute', left: 110, top: bars ? 800 : 640, width: 1700, display: 'flex', gap: 18 }}>
          {(a.points ?? []).slice(0, 4).map((t, i) => (
            <div key={t} style={{ flex: 1, padding: '22px 22px', borderRadius: 12, background: P.CARD, border: `1.5px solid ${P.RULE}`, display: 'flex', alignItems: 'center', gap: 12, fontSize: 21, fontWeight: 650, opacity: fast(f, 5 + i) }}>
              <Tick at={14 + i * 4} s={30} />{t}
            </div>
          ))}
        </div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const fl = u.find!.filters;
    const x0 = fl[0];
    const p = Math.max(0, x0.options.indexOf(x0.pick));
    const ROW = 56;
    const off = lerp(Math.min(f, 30), 30, Math.min(x0.options.length * ROW - 600, p * ROW + 420), Math.max(0, p * ROW - 112));
    const clickAt = Math.round(dur * 0.66);
    const picked = f >= clickAt;
    return (
      <Stage dur={dur} slate={sl(name, `${x0.label.toLowerCase()} first`)} from={{ x: 860, y: 470, s: 1.16 }} to={{ x: 900, y: 500, s: 1.26 }}>
        <div style={{ position: 'absolute', left: 300, top: 150 }}><Mono s={16}>{u.find?.title ?? x0.label}</Mono></div>
        <div style={{ position: 'absolute', left: 300, top: 190 }}><Field label={x0.label} value={picked ? x0.pick : undefined} open={!picked} w={640} /></div>
        <div style={{ position: 'absolute', left: 300, top: 290, width: 640, height: 690, borderRadius: 14, border: `1.5px solid ${P.RULE}`, background: P.CARD, overflow: 'hidden', opacity: picked ? 1 - ez(f, clickAt + 4, clickAt + 12) * 0.6 : fast(f, 1), boxShadow: '0 30px 60px -36px rgba(0,0,0,.4)' }}>
          <div style={{ height: 64, display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px', borderBottom: `1px solid ${P.RULE}`, fontSize: 21, color: P.SOFT }}>
            <span style={{ color: P.MUTED }}>⌕</span>{typed(f, x0.pick, 4, 2)}<span style={{ color: P.A }}>{caret(f)}</span>
          </div>
          <div style={{ transform: `translateY(${-off}px)` }}>
            {x0.options.map((o, i) => {
              const on = i === p && f > 22;
              return (
                <div key={o + i} style={{ height: ROW, display: 'flex', alignItems: 'center', gap: 14, padding: '0 20px', fontSize: 21, fontWeight: on ? 700 : 500, background: on ? P.AT : 'transparent', color: on ? P.AI : P.INK, borderBottom: `1px solid ${P.G2}` }}>
                  <span style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${on ? P.A : P.RULE}`, background: on && picked ? P.A : 'transparent' }} />
                  {o}
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ position: 'absolute', left: 1030, top: 190, width: 560 }}>
          {fl.slice(1, 3).map((x, i) => <div key={x.label} style={{ marginBottom: 26 }}><Field label={x.label} at={2 + i} w={560} /></div>)}
          <div style={{ opacity: fast(f, 4) }}><Btn t={u.find!.button} at={4} w="100%" /></div>
          <div style={{ marginTop: 36, opacity: fast(f, 5) }}>
            <Mono s={13}>{`${x0.options.length} ${x0.label.toLowerCase()} options`}</Mono>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
              {x0.options.slice(0, 9).map((o, i) => <Pill key={o} t={o} at={5 + i * 0.5} on={o === x0.pick && picked} s={0.95} />)}
            </div>
          </div>
          {(u.find?.notes ?? []).slice(0, 2).map((t, i) => (
            <div key={t} style={{ marginTop: i ? 10 : 28, display: 'flex', alignItems: 'center', gap: 10, fontSize: 19, color: P.SOFT, opacity: fast(f, 7) }}>{bullet(P, 22)}{t}</div>
          ))}
        </div>
        <Cursor path={[[880, 860, 0], [560, 520, Math.round(dur * 0.4)], [520, 290 + 64 + (p * ROW - Math.max(0, p * ROW - 112)) + 28, clickAt - 2], [900, 260, dur]]} clicks={[clickAt]} />
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const fl = u.find!.filters;
    const x1 = fl[1];
    const n = x1.options.length;
    const p = Math.max(0, x1.options.indexOf(x1.pick));
    const L = 140, R = 1780, step = (R - L) / Math.max(1, n - 1);
    const pos = ez(f, 2, Math.round(dur * 0.7)) * p;
    const hx = L + pos * step;
    const cur = x1.options[Math.round(pos)];
    return (
      <Stage dur={dur} slate={sl(name, x1.label.toLowerCase())} from={{ x: 900, y: 540, s: 1.04 }} to={{ x: 1020, y: 540, s: 1.08 }}>
        <div style={{ position: 'absolute', left: 200, top: 140 }}><Mono s={16}>{x1.label}</Mono></div>
        <div style={{ position: 'absolute', left: 200, top: 180 }}><div style={{ ...serif(P, 150, P.INK), ...{ whiteSpace: 'nowrap' } }}>{cur}</div></div>
        <div style={{ position: 'absolute', left: 1240, top: 170, width: 540, opacity: fast(f, 2) }}>
          <Mono s={13}>{`${n} ${x1.label.toLowerCase()} options`}</Mono>
          <div style={{ fontFamily: SERIF, fontSize: 86, fontWeight: 600, color: P.AI, lineHeight: 1 }}>{Math.round(ez(f, 0, 20) * n)}</div>
        </div>
        <div style={{ position: 'absolute', left: L, top: 560, width: R - L, height: 10, borderRadius: 9, background: P.G2 }} />
        <div style={{ position: 'absolute', left: L, top: 560, width: hx - L, height: 10, borderRadius: 9, background: P.A }} />
        {x1.options.map((o, i) => {
          const x = L + i * step;
          const on = i <= pos + 0.01;
          return (
            <div key={o + i} style={{ position: 'absolute', left: x - 70, top: 520, width: 140, textAlign: 'center', opacity: fast(f, Math.min(i, 8) * 0.6) }}>
              <div style={{ width: 4, height: 30, margin: '0 auto', background: on ? P.A : P.RULE, borderRadius: 2 }} />
              <div style={{ marginTop: 60, fontSize: n > 10 ? 17 : 21, fontWeight: i === Math.round(pos) ? 800 : 600, color: i === Math.round(pos) ? P.AI : P.SOFT, transform: i % 2 ? 'translateY(34px)' : 'none' }}>{o}</div>
            </div>
          );
        })}
        <div style={{ position: 'absolute', left: hx - 24, top: 541, width: 48, height: 48, borderRadius: 99, background: P.CARD, border: `5px solid ${P.A}`, boxShadow: `0 0 0 ${8 + br(f, 1, 4, 20)}px ${P.AT}` }} />
        <div style={{ position: 'absolute', left: 140, top: 790, width: 1640, display: 'flex', gap: 18 }}>
          {fl.slice(0, 3).map((x, i) => {
            const done = i === 0 || (i === 1 && f > dur * 0.7);
            return (
              <div key={x.label} style={{ flex: 1, padding: '20px 24px', borderRadius: 12, border: `1.5px solid ${done ? P.A : P.RULE}`, background: done ? P.AT : P.CARD, display: 'flex', alignItems: 'center', gap: 14, opacity: fast(f, 3 + i) }}>
                {done ? bullet(P, 44) : <span style={{ width: 30, height: 30, borderRadius: 99, border: `2px dashed ${P.RULE}` }} />}
                <div>
                  <Mono s={12}>{x.label}</Mono>
                  <div style={{ fontSize: 22, fontWeight: 700, marginTop: 3 }}>{i === 0 ? x.pick : i === 1 ? cur : 'Not set yet'}</div>
                </div>
              </div>
            );
          })}
        </div>

      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const fl = u.find!.filters;
    const last = fl.length >= 3 ? fl[2] : null;
    const pressAt = Math.round(dur * 0.45);
    const segP = last ? Math.max(0, last.options.indexOf(last.pick)) : 0;
    const segPos = last ? ez(f, 2, Math.round(dur * 0.3)) * segP : 0;
    return (
      <Stage dur={dur} slate={sl(name, 'set and search')} from={{ x: 960, y: 520, s: 1.2 }} to={{ x: 960, y: 540, s: 0.98 }}>
        <div style={{ position: 'absolute', left: 200, top: 120, width: 1520, padding: '40px 46px', borderRadius: 16, background: P.CARD, border: `1.5px solid ${P.RULE}`, boxShadow: '0 50px 90px -60px rgba(0,0,0,.5)' }}>
          <div style={{ ...serif(P, fit(u.find?.title ?? '', [[40, 58], [999, 44]]), undefined) }}>{u.find?.title ?? name}</div>
          <div style={{ display: 'flex', gap: 20, marginTop: 30 }}>
            {fl.slice(0, 2).map((x, i) => <Field key={x.label} label={x.label} value={x.pick} at={i} w={460} />)}
            {!last && fl.length === 1 ? <Field label="" value={u.find!.button} w={460} /> : null}
          </div>
          {last ? (
            <div style={{ marginTop: 26, opacity: fast(f, 2) }}>
              <Mono s={12}>{last.label}</Mono>
              <div style={{ position: 'relative', display: 'flex', marginTop: 8, borderRadius: 12, background: P.G2, padding: 6 }}>
                <div style={{ position: 'absolute', left: 6 + (segPos * (1428 - 12)) / last.options.length, top: 6, width: (1428 - 12) / last.options.length, height: 56, borderRadius: 9, background: P.INK }} />
                {last.options.slice(0, 5).map((o, i) => (
                  <div key={o} style={{ flex: 1, height: 56, display: 'grid', placeItems: 'center', fontSize: 21, fontWeight: 700, position: 'relative', color: Math.abs(i - segPos) < 0.5 ? '#fff' : P.SOFT }}>{o}</div>
                ))}
              </div>
            </div>
          ) : null}
          <div style={{ marginTop: 30 }}><Btn t={u.find!.button} press={pressAt} w="100%" s={1.15} /></div>
          <div style={{ marginTop: 18, height: 6, borderRadius: 6, background: P.G2, overflow: 'hidden' }}>
            <div style={{ width: `${ez(f, pressAt + 2, dur) * 100}%`, height: '100%', background: P.A }} />
          </div>
          <div style={{ display: 'flex', gap: 28, marginTop: 22 }}>
            {(u.find?.notes ?? u.hook.notes ?? []).slice(0, 3).map((t, i) => (
              <span key={t} style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 19, color: P.SOFT, opacity: fast(f, 4 + i) }}>{bullet(P, 22)}{t}</span>
            ))}
          </div>
        </div>
        <div style={{ position: 'absolute', left: 200, top: 770, width: 1520, display: 'flex', gap: 14, opacity: fast(f, 5) }}>
          {fl.map((x) => <Pill key={x.label} t={`${x.label}: ${x.pick}`} on at={5} />)}
        </div>
        <div style={{ position: 'absolute', left: 200, top: 850, width: 1520, display: 'flex', gap: 24 }}>
          {(u.results?.cards ?? []).slice(0, 3).map((c, i) => (
            <ResultCard key={i} card={c} at={pressAt + 2 + i * 2} w={490} s={0.9} />
          ))}
        </div>
        <Cursor path={[[1500, 980, 0], [980, last ? 640 : 560, pressAt - 3], [1040, 700, dur]]} clicks={[pressAt]} />
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const fl = u.find!.filters;
    const hi = new Set(u.catalog?.highlight.items ?? []);
    const all = fl.flatMap((x, gi) => x.options.map((o) => ({ o, gi })));
    const sweep = lerp(f, dur, -4, all.length + 4);
    return (
      <Stage dur={dur} slate={sl(name, 'everything on offer')} from={{ x: 960, y: 500, s: 1.1 }} to={{ x: 960, y: 540, s: 1.0 }}>
        <div style={{ position: 'absolute', left: 110, top: 96, width: 1700, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div style={{ ...serif(P, 54, undefined) }}>{u.catalog?.title ?? u.find?.title ?? name}</div>
          {u.catalog ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: fast(f, 2) }}>
              <span style={{ width: 16, height: 16, borderRadius: 4, background: P.A }} />
              <Mono s={15} c={P.AI}>{u.catalog.highlight.label}</Mono>
            </span>
          ) : null}
        </div>
        <div style={{ position: 'absolute', left: 110, top: 190, width: 1700, display: 'flex', flexWrap: 'wrap', gap: 14, transform: `translateY(${br(f, 2, 4, 50)}px)` }}>
          {all.map(({ o, gi }, i) => {
            const on = hi.has(o);
            const lit = Math.abs(i - sweep) < 3;
            const g = ez(f, Math.min(10, i * 0.2), Math.min(10, i * 0.2) + 6);
            return (
              <span
                key={o + i}
                style={{
                  fontSize: 25, fontWeight: 650, padding: '14px 22px', borderRadius: 10, whiteSpace: 'nowrap',
                  background: on ? P.A : gi === 0 ? P.CARD : gi === 1 ? P.G2 : P.INK,
                  color: on ? '#fff' : gi === 2 ? '#fff' : P.INK,
                  border: `1.5px solid ${lit ? P.INK : on ? P.A : P.RULE}`,
                  opacity: g, transform: `translateY(${(1 - g) * 16}px) scale(${lit ? 1.06 : 1})`,
                }}
              >
                {o}
              </span>
            );
          })}
        </div>
        <div style={{ position: 'absolute', left: 110, top: 846, width: 1700, display: 'flex', gap: 22 }}>
          {[...fl.map((x, gi) => ({ n: x.options.length, l: x.label, gi })), ...(u.catalog ? [{ n: u.catalog.highlight.items.length, l: u.catalog.highlight.label, gi: 9 }] : [])].map((x, i) => (
            <div key={x.l} style={{ flex: 1, padding: '18px 24px', borderRadius: 12, background: x.gi === 9 ? P.AT : P.CARD, border: `1.5px solid ${x.gi === 9 ? P.A : P.RULE}`, opacity: fast(f, 3 + i) }}>
              <div style={{ fontFamily: SERIF, fontSize: 64, fontWeight: 650, lineHeight: 1, color: x.gi === 9 ? P.AI : P.INK }}>{Math.round(ez(f, 2, 30 + i * 6) * x.n)}</div>
              <Mono s={13}>{x.l}</Mono>
            </div>
          ))}
        </div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const r = u.results!;
    const fl = u.find?.filters ?? [];
    const pickAt = Math.round(dur * 0.55);
    const pos: [number, number][] = [[560, 200], [1200, 200], [560, 600], [1200, 600]];
    return (
      <Stage dur={dur} slate={sl(name, 'the listings')} from={{ x: 960, y: 520, s: 1.0 }} to={{ x: 1000, y: 580, s: 1.06 }}>
        <div style={{ position: 'absolute', left: 90, top: 110, width: 410, height: 900, borderRadius: 14, background: P.CARD, border: `1.5px solid ${P.RULE}`, padding: 26 }}>
          <Mono s={13}>Filters</Mono>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
            {fl.map((x, i) => (
              <div key={x.label} style={{ opacity: fast(f, i) }}>
                <Mono s={11}>{x.label}</Mono>
                <div style={{ marginTop: 6 }}><Pill t={`${x.pick}  ×`} on at={i} /></div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 34 }}><Mono s={13}>Sort</Mono></div>
          {(r.cards[0]?.rows ?? []).slice(0, 3).map(([k], i) => (
            <div key={k} style={{ marginTop: 12, fontSize: 19, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 10, opacity: fast(f, 3 + i) }}>
              <span style={{ width: 18, height: 18, borderRadius: 99, border: `2px solid ${i === 0 ? P.A : P.RULE}`, background: i === 0 ? P.A : 'transparent' }} />{k}
            </div>
          ))}
          <div style={{ position: 'absolute', left: 26, right: 26, bottom: 26, padding: 18, borderRadius: 12, background: P.AT, fontSize: 18, fontWeight: 600, color: P.AI, opacity: fast(f, 6) }}>
            {u.find?.notes?.[0] ?? u.hook.notes?.[0] ?? r.title}
          </div>
        </div>
        <div style={{ position: 'absolute', left: 560, top: 120, fontSize: 34, fontWeight: 750, letterSpacing: -0.8 }}>{typed(f, r.title, 0, 0.7)}<span style={{ color: P.A }}>{caret(f)}</span></div>
        {[0, 1].map((i) => (
          <div key={`g${i}`} style={{ position: 'absolute', left: 560 + i * 590, top: 990, width: 560, height: 60, borderRadius: 12, background: P.G2, opacity: 1 - ez(f, 6 + i * 4, 20 + i * 4), transform: `translateY(${ez(f, 6 + i * 4, 20 + i * 4) * 60}px)` }} />
        ))}
        {r.cards.slice(0, 4).map((c, i) => (
          <div key={i} style={{ position: 'absolute', left: pos[i][0], top: pos[i][1] }}>
            <ResultCard card={c} at={1 + i * 2} w={610} s={1.12} hot={i === r.pick && f > pickAt} />
          </div>
        ))}
        <Cursor path={[[1700, 960, 0], [900, 560, Math.round(dur * 0.3)], [pos[r.pick % 4][0] + 420, pos[r.pick % 4][1] + 190, pickAt], [pos[r.pick % 4][0] + 440, pos[r.pick % 4][1] + 210, dur]]} />
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const r = u.results!;
    const card = r.cards[r.pick] ?? r.cards[0];
    const lift = ez(f, 0, 14);
    const pressAt = Math.round(dur * 0.72);
    return (
      <Stage dur={dur} slate={sl(name, `pick a ${r.noun}`)} from={{ x: 960, y: 540, s: 1.0 }} to={{ x: 960, y: 520, s: 1.05 }}>
        <div style={{ position: 'absolute', inset: 0, filter: `blur(${lift * 4}px)`, opacity: 1 - lift * 0.55 }}>
          {r.cards.slice(0, 4).map((c, i) => (
            <div key={i} style={{ position: 'absolute', left: [90, 1350, 120, 1380][i], top: [120, 140, 620, 640][i], transform: `rotate(${[-3, 2.5, 2, -2][i]}deg)` }}>
              <ResultCard card={c} at={0} w={460} />
            </div>
          ))}
        </div>
        <div style={{ position: 'absolute', left: 960 - 380, top: 170, transform: `scale(${1 + lift * 0.3})`, transformOrigin: '50% 30%' }}>
          <ResultCard card={card} at={-10} w={760} s={1.05} hot action={r.action} press={pressAt} />
        </div>
        <div style={{ position: 'absolute', left: 580, top: 900, width: 760, display: 'flex', justifyContent: 'center', gap: 14, opacity: fast(f, 6) }}>
          {card.tags.map((t) => <Pill key={t} t={t} at={6} />)}
          {card.badge ? <Pill t={card.badge} on c={P.GOOD} at={7} /> : null}
        </div>
        <Cursor path={[[1500, 900, 0], [800, 700, pressAt - 2], [860, 760, dur]]} clicks={[pressAt]} />
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const r = u.results!;
    const card = r.cards[r.pick] ?? r.cards[0];
    return (
      <Stage dur={dur} slate={sl(name, 'before you book')} from={{ x: 940, y: 470, s: 1.08 }} to={{ x: 980, y: 610, s: 1.14 }}>
        <div style={{ position: 'absolute', left: 200, top: 150, display: 'flex', alignItems: 'center', gap: 30 }}>
          <Avatar t={card.title} s={150} ring />
          <div>
            <div style={{ ...serif(P, 92, undefined) }}>{card.title}</div>
            <div style={{ fontSize: 30, color: P.MUTED, marginTop: 8 }}>{card.sub}</div>
          </div>
        </div>
        {card.rows.slice(0, 5).map(([k, v], i) => (
          <div key={k + i} style={{ position: 'absolute', left: 140, top: 360 + i * 150, width: 1640, display: 'flex', alignItems: 'baseline', gap: 40, paddingTop: 26, borderTop: `2px solid ${P.RULE}`, opacity: fast(f, i) }}>
            <span style={{ width: 340, flex: 'none' }}><Mono s={22} c={i % 2 ? P.MUTED : P.AI}>{k}</Mono></span>
            <span style={{ fontFamily: SERIF, fontSize: 60, fontWeight: 560, letterSpacing: -1.2, transform: `translateX(${(1 - ez(f, i * 2, i * 2 + 10)) * 30}px)` }}>{v}</span>
          </div>
        ))}
        <div style={{ position: 'absolute', left: 1240, top: 170, display: 'flex', gap: 12, opacity: fast(f, 3) }}>
          {card.tags.map((t) => <Pill key={t} t={t} s={1.3} at={3} />)}
        </div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const t = u.thread!;
    const first = t.messages[0];
    const sendAt = Math.min(dur - 12, 8 + Math.ceil(first.text.length * 0.55) + 4);
    const sent = f >= sendAt;
    return (
      <Stage dur={dur} slate={sl(name, 'ask first')} from={{ x: 960, y: 560, s: 1.02 }} to={{ x: 1010, y: 640, s: 1.12 }}>
        <div style={{ position: 'absolute', left: 90, top: 100, width: 1740, height: 920, borderRadius: 16, background: P.CARD, border: `1.5px solid ${P.RULE}`, overflow: 'hidden', display: 'flex' }}>
          <div style={{ width: 400, background: P.G, borderRight: `1px solid ${P.RULE}`, padding: 26 }}>
            <Mono s={13}>Messages</Mono>
            <div style={{ marginTop: 18, padding: 16, borderRadius: 12, background: P.CARD, border: `2px solid ${P.A}`, display: 'flex', gap: 12, alignItems: 'center' }}>
              <Avatar t={t.with} s={46} />
              <div>
                <div style={{ fontSize: 19, fontWeight: 700 }}>{t.with}</div>
                <div style={{ fontSize: 15, color: P.MUTED }}>{t.sub}</div>
              </div>
            </div>
            <div style={{ marginTop: 26 }}>
              {(t.notes ?? []).map((n, i) => (
                <div key={n} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 14, fontSize: 18, color: P.SOFT, fontWeight: 600, opacity: fast(f, 2 + i) }}><Tick at={4 + i * 3} s={24} />{n}</div>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, position: 'relative' }}>
            <div style={{ height: 84, borderBottom: `1px solid ${P.RULE}`, display: 'flex', alignItems: 'center', gap: 14, padding: '0 30px' }}>
              <Avatar t={t.with} s={48} />
              <div style={{ fontSize: 22, fontWeight: 700 }}>{t.with}</div>
              <span style={{ marginLeft: 'auto' }}><Mono s={12}>{t.sub}</Mono></span>
            </div>
            <div style={{ position: 'absolute', left: 30, right: 30, top: 116 }}>
              <div style={{ textAlign: 'center', opacity: fast(f, 1) }}><Mono s={12}>{u.steps[1]?.detail ?? ''}</Mono></div>
              {u.results ? (() => {
                const pc = u.results.cards[u.results.pick] ?? u.results.cards[0];
                return (
                  <div style={{ margin: '22px auto 0', width: 760, padding: '24px 28px', borderRadius: 14, border: `1.5px solid ${P.RULE}`, background: P.G, display: 'flex', gap: 22, opacity: fast(f, 2) }}>
                    <Avatar t={pc.title} s={84} ring />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: SERIF, fontSize: 36, fontWeight: 650 }}>{pc.title}</div>
                      <div style={{ fontSize: 19, color: P.MUTED }}>{pc.sub}</div>
                      {pc.rows.slice(0, 3).map(([k, v]) => (
                        <div key={k} style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 19 }}>
                          <span style={{ width: 170 }}><Mono s={12}>{k}</Mono></span><span style={{ fontWeight: 650 }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })() : null}
            </div>
            <div style={{ position: 'absolute', left: 30, right: 30, bottom: 150 }}>
              {sent ? <Bubble me at={sendAt} t={first.text} w={780} s={26} /> : null}
            </div>
            <div style={{ position: 'absolute', left: 30, right: 30, bottom: 30, height: 96, borderRadius: 14, border: `2px solid ${sent ? P.RULE : P.INK}`, display: 'flex', alignItems: 'center', padding: '0 24px', gap: 16 }}>
              <span style={{ fontSize: 26, color: P.SOFT, flex: 1 }}>{sent ? '' : typed(f, first.text, 6, 0.55)}<span style={{ color: P.A }}>{caret(f)}</span></span>
              <span style={{ width: 62, height: 62, borderRadius: 12, background: sent ? P.A : P.INK, display: 'grid', placeItems: 'center', color: '#fff', fontSize: 28, transform: `scale(${f >= sendAt - 2 && f <= sendAt + 3 ? 0.9 : 1})` }}>↑</span>
            </div>
          </div>
        </div>
        <Cursor path={[[1200, 700, 0], [1720, 960, sendAt - 3], [1660, 900, dur]]} clicks={[sendAt]} />
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const t = u.thread!;
    const ms = t.messages.slice(0, 5);
    return (
      <Stage dur={dur} slate={sl(name, 'an answer')} from={{ x: 980, y: 560, s: 1.05 }} to={{ x: 920, y: 520, s: 1.0 }}>
        <Phone x={180} y={70} h={960} title={t.with} sub={t.sub} tilt={-2}>
          {ms.map((m, i) => {
            const at = i === 0 ? 0 : 4 + (i - 1) * 9;
            const typing = m.from === 'them' && f < at + 6;
            return <Bubble key={i} me={m.from === 'me'} at={at} t={m.text} typing={typing} w={360} s={20} />;
          })}
        </Phone>
        <div style={{ position: 'absolute', left: 780, top: 150, width: 1000 }}>
          <Mono s={15}>{u.steps[1]?.title ?? 'Message'}</Mono>
          {ms.filter((m) => m.from === 'them').slice(0, 2).map((m, i) => (
            <div key={i} style={{ ...serif(P, fit(m.text, [[30, 76], [70, 56], [999, 42]]), i ? P.AI : P.INK), ...{ marginTop: 22, opacity: ez(f, 8 + i * 9, 16 + i * 9) } }}>
              “{m.text}”
            </div>
          ))}
        </div>
        <div style={{ position: 'absolute', left: 780, top: 600, width: 1000, display: 'flex', gap: 16 }}>
          {(t.notes ?? []).slice(0, 3).map((n, i) => (
            <div key={n} style={{ flex: 1, padding: '26px 24px', borderRadius: 12, background: P.CARD, border: `1.5px solid ${P.RULE}`, fontSize: 23, fontWeight: 650, opacity: fast(f, 3 + i), transform: `translateY(${br(f, i, 5, 50)}px)` }}>
              {bullet(P, 26)}
              <div style={{ marginTop: 10 }}>{n}</div>
            </div>
          ))}
        </div>
        <div style={{ position: 'absolute', left: 780, top: 860, display: 'flex', gap: 16, alignItems: 'center', opacity: ez(f, dur * 0.55, dur * 0.55 + 8) }}>
          <Btn t={u.booking?.title ?? u.steps[2]?.title ?? u.close.cta} s={1.2} />
          {u.results?.cards[u.results.pick]?.badge ? <Pill t={u.results.cards[u.results.pick].badge!} on c={P.GOOD} s={1.2} /> : null}
        </div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const b = u.booking!;
    const days = u.recurring?.days ?? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const pick = u.recurring?.pick_day ?? 2;
    const ROWS = 5;
    const clickAt = Math.round(dur * 0.45);
    const reqAt = Math.round(dur * 0.75);
    const cw = 150, ch = 138, gx = 140, gy = 270;
    const open = (d: number, r: number) => (d * 3 + r * 5) % 4 === 0 || (d === pick && r === 3);
    return (
      <Stage dur={dur} slate={sl(name, b.title.toLowerCase())} from={{ x: 900, y: 560, s: 1.08 }} to={{ x: 980, y: 560, s: 1.0 }}>
        <div style={{ position: 'absolute', left: gx, top: 100 }}><div style={{ ...serif(P, 58, undefined) }}>{b.title}</div></div>
        {days.slice(0, 7).map((d, i) => (
          <div key={d} style={{ position: 'absolute', left: gx + i * cw, top: gy - 50, width: cw - 10, textAlign: 'center', opacity: fast(f, i * 0.5) }}><Mono s={15} c={i === pick ? P.AI : P.MUTED}>{d}</Mono></div>
        ))}
        {days.slice(0, 7).map((_, d) =>
          Array.from({ length: ROWS }).map((__, r) => {
            const isPick = d === pick && r === 3;
            const o = open(d, r);
            return (
              <div key={`${d}-${r}`} style={{ position: 'absolute', left: gx + d * cw, top: gy + r * ch, width: cw - 10, height: ch - 10, borderRadius: 10, border: `1.5px ${o ? 'solid' : 'dashed'} ${isPick && f > clickAt ? P.A : P.RULE}`, background: isPick && f > clickAt ? P.A : o ? P.CARD : 'transparent', opacity: fast(f, Math.min(9, d + r * 0.5)), display: 'grid', placeItems: 'center', fontSize: 15, fontWeight: 700, color: isPick && f > clickAt ? '#fff' : P.MUTED, transform: `scale(${isPick && f > clickAt ? 1 + 0.06 * (1 - ez(f, clickAt, clickAt + 10)) : 1})` }}>
                {isPick && f > clickAt ? b.slot_label : o ? 'Open' : ''}
              </div>
            );
          }),
        )}
        <div style={{ position: 'absolute', left: 1250, top: 150, width: 560, borderRadius: 16, background: P.CARD, border: `1.5px solid ${P.RULE}`, padding: 30, opacity: fast(f, 3), boxShadow: '0 30px 60px -40px rgba(0,0,0,.4)' }}>
          <Mono s={13}>Request</Mono>
          <div style={{ fontSize: 32, fontWeight: 750, marginTop: 8 }}>{b.slot_label}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <Avatar t={u.thread?.with ?? name} s={44} />
            <div style={{ fontSize: 20, fontWeight: 650 }}>{u.thread?.with ?? name}</div>
          </div>
          <div style={{ marginTop: 18 }}><Mono s={12}>Where it happens</Mono></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            {(b.channels ?? []).map((c, i) => <Pill key={c} t={c} at={4 + i} />)}
          </div>
          {(b.notes ?? []).slice(0, 2).map((n, i) => (
            <div key={n} style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: i ? 10 : 22, fontSize: 19, fontWeight: 600, color: P.GOOD }}><Tick at={6 + i * 3} s={24} c={P.GOOD} />{n}</div>
          ))}
          <div style={{ marginTop: 26 }}><Btn t={b.status[0]?.label === 'Requested' ? 'Request' : b.status[0]?.label ?? 'Request'} w="100%" press={reqAt} /></div>
        </div>
        <div style={{ position: 'absolute', left: 1250, top: 720, width: 560, padding: '22px 24px', borderRadius: 14, background: P.AT, display: 'flex', alignItems: 'center', gap: 14, opacity: ez(f, reqAt + 2, reqAt + 10) }}>
          <span style={{ width: 14, height: 14, borderRadius: 99, background: P.A, boxShadow: `0 0 0 ${6 + br(f, 1, 4, 16)}px ${P.AT}` }} />
          <span style={{ fontSize: 22, fontWeight: 700 }}>{b.status[0]?.detail}</span>
        </div>
        <Cursor path={[[700, 1000, 0], [gx + pick * cw + 80, gy + 3 * ch + 60, clickAt - 2], [1530, 600, reqAt - 2], [1560, 640, dur]]} clicks={[clickAt, reqAt]} />
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const b = u.booking!;
    const st = b.status.slice(0, 4);
    const n = st.length;
    const L = 330, R = 1590, step = (R - L) / Math.max(1, n - 1);
    const prog = ez(f, 2, dur - 10);
    return (
      <Stage dur={dur} slate={sl(name, 'confirmed')} from={{ x: 900, y: 540, s: 1.02 }} to={{ x: 1020, y: 540, s: 1.06 }}>
        <div style={{ position: 'absolute', left: L, top: 400, width: R - L, height: 8, background: P.G2, borderRadius: 8 }} />
        <div style={{ position: 'absolute', left: L, top: 400, width: (R - L) * prog, height: 8, background: P.A, borderRadius: 8 }} />
        {st.map((s, i) => {
          const at = (i / Math.max(1, n - 1)) * (dur - 12) + 2;
          const on = f >= at;
          return (
            <div key={s.label} style={{ position: 'absolute', left: L + i * step - 170, top: 340, width: 340, textAlign: 'center' }}>
              <div style={{ width: 128, height: 128, margin: '0 auto', borderRadius: 99, background: on ? P.A : P.CARD, border: `4px solid ${on ? P.A : P.RULE}`, display: 'grid', placeItems: 'center', transform: `translateY(-28px) scale(${on ? 1 + 0.12 * (1 - ez(f, at, at + 10)) : 0.92})` }}>
                {on ? <Tick at={at} s={70} c={P.A} /> : <span style={{ fontFamily: MONO, fontSize: 30, color: P.MUTED }}>{i + 1}</span>}
              </div>
              <div style={{ fontFamily: SERIF, fontSize: 52, fontWeight: 620, marginTop: 6 }}>{s.label}</div>
              <div style={{ fontSize: 22, color: P.MUTED, marginTop: 6 }}>{s.detail}</div>
            </div>
          );
        })}
        <div style={{ position: 'absolute', left: L, top: 130, opacity: fast(f, 0) }}>
          <Mono s={16}>{b.slot_label}</Mono>
          <div style={{ ...serif(P, 64, undefined), ...{ marginTop: 8 } }}>{b.title}</div>
        </div>
        {(b.channels ?? []).length > 0 ? <div style={{ position: 'absolute', left: R - 640, top: 760, width: 640, padding: '24px 28px', borderRadius: 14, background: P.CARD, border: `2px solid ${P.A}`, opacity: ez(f, dur * 0.6, dur * 0.6 + 8), transform: `translateY(${(1 - ez(f, dur * 0.6, dur * 0.6 + 8)) * 40}px)` }}>
          <Mono s={12} c={P.AI}>{st[n - 1]?.label}</Mono>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>{(b.channels ?? []).map((c) => <Pill key={c} t={c} on={c === b.channels?.[0]} />)}</div>
        </div> : null}
        <div style={{ position: 'absolute', left: L, top: 780, padding: '16px 24px', border: `3px solid ${P.GOOD}`, color: P.GOOD, borderRadius: 8, fontFamily: MONO, fontSize: 22, letterSpacing: 2, textTransform: 'uppercase', transform: `rotate(-3deg) scale(${1 + 0.2 * (1 - ez(f, 10, 18))})`, opacity: ez(f, 10, 14) }}>
          {b.notes?.[1] ?? b.notes?.[0] ?? b.status[0].detail}
        </div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const c = u.clocks!;
    const spin = lerp(f, dur, 0, 70);
    const k = lerp(f, dur, 0, 1);
    const ax = 560, bx = 1360, cy = 470;
    const px = ax + (bx - ax) * k;
    const py = cy - 2 * k * (1 - k) * 480;
    return (
      <Stage dur={dur} slate={sl(name, 'two time zones')} from={{ x: 960, y: 540, s: 1.06 }} to={{ x: 960, y: 520, s: 1.0 }}>
        <svg width={W} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
          <path d={`M ${ax} ${cy} Q ${(ax + bx) / 2} ${cy - 480} ${bx} ${cy}`} fill="none" stroke={P.A} strokeWidth={4} strokeDasharray="14 12" strokeDashoffset={-f * 2} opacity={0.8} />
          <circle cx={px} cy={py} r={16} fill={P.A} />
        </svg>
        {[c.here, c.there].map((x, i) => (
          <div key={x.label} style={{ position: 'absolute', left: (i ? bx : ax) - 230, top: cy - 230, opacity: fast(f, i) }}>
            <Clock r={230} hour={x.phase === 'evening' ? 6 : 7} phase={x.phase} spin={spin + i * 40} />
          </div>
        ))}
        {[c.here, c.there].map((x, i) => (
          <div key={`l${i}`} style={{ position: 'absolute', left: (i ? bx : ax) - 300, top: cy + 250, width: 600, textAlign: 'center', opacity: fast(f, 2 + i) }}>
            <div style={{ ...serif(P, 64, undefined) }}>{x.label}</div>
            <div style={{ fontSize: 24, color: P.MUTED, marginTop: 6 }}>{x.sub}</div>
          </div>
        ))}
        <div style={{ position: 'absolute', left: 140, top: 940, width: 1640, height: 44, borderRadius: 10, overflow: 'hidden', background: 'linear-gradient(90deg, #2E3A6E 0%, #8E7CC3 30%, #FFD38A 55%, #FFF4D6 75%, #BFE2F2 100%)', opacity: fast(f, 4) }}>
          <div style={{ position: 'absolute', left: `${18 + k * 4}%`, top: 0, bottom: 0, width: 4, background: '#fff' }} />
          <div style={{ position: 'absolute', left: `${52 + k * 4}%`, top: 0, bottom: 0, width: 4, background: P.INK }} />
        </div>
        <div style={{ position: 'absolute', left: 140, top: 96, width: 1640, textAlign: 'center', fontSize: 30, fontWeight: 600, color: P.SOFT, opacity: fast(f, 5) }}>{c.note}</div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const w = u.recurring!;
    const days = w.days.slice(0, 7);
    const rows = w.rows.slice(0, 4);
    const cw = 160, rh = 165, gx = 300, gy = 270;
    return (
      <Stage dur={dur} slate={sl(name, w.title.toLowerCase())} from={{ x: 860, y: 480, s: 1.12 }} to={{ x: 1000, y: 620, s: 1.04 }}>
        <div style={{ position: 'absolute', left: 120, top: 110 }}><div style={{ ...serif(P, 68, undefined) }}>{w.title}</div></div>
        {days.map((d, i) => (
          <div key={d} style={{ position: 'absolute', left: gx + i * cw, top: gy - 46, width: cw - 12, textAlign: 'center' }}><Mono s={15} c={i === w.pick_day ? P.AI : P.MUTED}>{d}</Mono></div>
        ))}
        {rows.map((r, ri) => {
          const at = 4 + ri * Math.max(6, (dur - 20) / rows.length);
          return (
            <React.Fragment key={r}>
              <div style={{ position: 'absolute', left: 120, top: gy + ri * rh + 40, width: 200, fontSize: 21, fontWeight: 650, color: P.SOFT, opacity: fast(f, ri) }}>{r}</div>
              {days.map((_, di) => (
                <div key={di} style={{ position: 'absolute', left: gx + di * cw, top: gy + ri * rh, width: cw - 12, height: rh - 14, borderRadius: 10, border: `1.5px solid ${P.RULE}`, background: P.CARD, opacity: fast(f, Math.min(8, di * 0.4 + ri)) }} />
              ))}
              <div style={{ position: 'absolute', left: gx + w.pick_day * cw - 6, top: gy + ri * rh - 6, width: cw + 0, height: rh - 2, borderRadius: 12, background: P.A, color: '#fff', padding: '16px 14px', opacity: Math.min(1, ez(f, at, at + 3)), transform: `translateY(${(1 - Math.min(1, drop(f, at))) * -60}px)`, boxShadow: `0 20px 40px -20px ${P.A}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Avatar t={u.thread?.with ?? name} s={36} /></div>
                <div style={{ fontSize: 16, fontWeight: 750, marginTop: 10, lineHeight: 1.2 }}>{w.label}</div>
              </div>
            </React.Fragment>
          );
        })}
        <div style={{ position: 'absolute', left: gx + days.length * cw + 30, top: gy, width: 380, opacity: fast(f, 4) }}>
          <div style={{ padding: 24, borderRadius: 14, background: P.AT, border: `1.5px solid ${P.A}` }}>
            <Mono s={12} c={P.AI}>{u.steps[3]?.title ?? w.title}</Mono>
            <div style={{ fontSize: 23, fontWeight: 650, marginTop: 10, lineHeight: 1.35 }}>{w.note}</div>
          </div>
          <div style={{ marginTop: 18, fontSize: 21, color: P.SOFT, fontWeight: 600 }}>{u.steps[3]?.detail}</div>
        </div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const p = u.pay!;
    const m = p.methods.slice(0, 4);
    const n = m.length;
    const tw = Math.min(480, (1640 - (n - 1) * 30) / n);
    const sel = Math.min(n - 1, Math.floor(lerp(f, dur * 0.8, 0, n - 0.01)));
    const prog = ez(f, 2, dur * 0.6);
    return (
      <Stage dur={dur} slate={sl(name, 'paying')} from={{ x: 960, y: 600, s: 1.0 }} to={{ x: 960, y: 520, s: 1.08 }}>
        <div style={{ position: 'absolute', left: 140, top: 110, width: 1640 }}><div style={{ ...serif(P, fit(p.title, [[36, 64], [999, 52]]), undefined) }}>{p.title}</div></div>
        <div style={{ position: 'absolute', left: 140, top: 270, width: 1640, height: 6, background: P.G2, borderRadius: 6 }} />
        <div style={{ position: 'absolute', left: 140, top: 270, width: 1640 * prog, height: 6, background: P.A, borderRadius: 6 }} />
        {p.steps.slice(0, 4).map((s, i, arr) => {
          const x = 140 + (i / Math.max(1, arr.length - 1)) * 1640;
          const on = prog >= i / Math.max(1, arr.length - 1) - 0.01;
          return (
            <div key={s.label} style={{ position: 'absolute', left: x - 140, top: 250, width: 280, textAlign: i === 0 ? 'left' : i === arr.length - 1 ? 'right' : 'center', transform: `translateX(${i === 0 ? 140 : i === arr.length - 1 ? -140 : 0}px)` }}>
              <div style={{ display: 'inline-block', width: 46, height: 46, borderRadius: 99, background: on ? P.A : P.CARD, border: `3px solid ${on ? P.A : P.RULE}` }} />
              <div style={{ fontSize: 26, fontWeight: 750, marginTop: 8 }}>{s.label}</div>
              <div style={{ fontSize: 19, color: P.MUTED }}>{s.detail}</div>
            </div>
          );
        })}
        {m.map((t, i) => {
          const on = i === sel;
          return (
            <div key={t} style={{ position: 'absolute', left: 140 + i * (tw + 30), top: 480, width: tw, height: 400, borderRadius: 16, background: on ? P.INK : P.CARD, color: on ? '#fff' : P.INK, border: `2px solid ${on ? P.INK : P.RULE}`, padding: 34, opacity: fast(f, 2 + i), transform: `translateY(${on ? -16 : 0}px)`, boxShadow: on ? '0 40px 70px -40px rgba(0,0,0,.6)' : 'none' }}>
              <div style={{ width: 96, height: 96, borderRadius: 18, background: on ? P.A : P.AT, display: 'grid', placeItems: 'center', fontFamily: SERIF, fontSize: 56, fontWeight: 700, color: on ? '#fff' : P.AI }}>{t.slice(0, 1)}</div>
              <div style={{ fontFamily: SERIF, fontSize: 72, fontWeight: 650, marginTop: 40, letterSpacing: -1.5 }}>{t}</div>
              <div style={{ marginTop: 14, opacity: on ? 1 : 0.5 }}><Mono s={14} c={on ? '#fff' : undefined}>{on ? 'Selected' : 'Available'}</Mono></div>
            </div>
          );
        })}
        <div style={{ position: 'absolute', left: 140, top: 930, display: 'flex', gap: 30, opacity: fast(f, 6) }}>
          {u.split ? <span style={{ fontSize: 22, fontWeight: 700, display: 'flex', gap: 10, alignItems: 'center' }}><Tick at={8} s={26} />{`${u.split.cut_label}: ${u.split.cut}`}</span> : null}
          <span style={{ fontSize: 22, fontWeight: 700, display: 'flex', gap: 10, alignItems: 'center' }}><Tick at={10} s={26} />{p.steps[p.steps.length - 1]?.detail}</span>
        </div>

      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const s = u.split!;
    const draw = ez(f, 0, 22);
    const dots = Array.from({ length: 7 });
    return (
      <Stage dur={dur} slate={sl(name, 'where the money goes')} from={{ x: 980, y: 540, s: 1.0 }} to={{ x: 940, y: 540, s: 1.06 }}>
        <svg width={W} height={1080} style={{ position: 'absolute', left: 0, top: 0 }}>
          <path d="M 470 420 C 900 420, 900 380, 1330 380" fill="none" stroke={P.A} strokeWidth={170} strokeDasharray="1100" strokeDashoffset={1100 * (1 - draw)} opacity={0.9} />
          <path d="M 470 520 C 900 520, 900 760, 1330 760" fill="none" stroke={P.MUTED} strokeWidth={3} strokeDasharray="10 10" opacity={draw} />
          {dots.map((_, i) => {
            const t = ((f * 0.022 + i / dots.length) % 1);
            const x = 470 + 860 * t;
            const y = 420 + (380 - 420) * (3 * t * t - 2 * t * t * t);
            return <circle key={i} cx={x} cy={y} r={10} fill="#fff" opacity={draw * 0.9} />;
          })}
        </svg>
        <div style={{ position: 'absolute', left: 110, top: 330, width: 360, padding: 28, borderRadius: 14, background: P.INK, color: '#fff', opacity: fast(f, 0) }}>
          <Mono s={13} c="#bbb">From</Mono>
          <div style={{ fontFamily: SERIF, fontSize: 64, fontWeight: 650 }}>{s.payer}</div>
        </div>
        <div style={{ position: 'absolute', left: 1330, top: 270, width: 480, padding: 30, borderRadius: 14, background: P.CARD, border: `2.5px solid ${P.A}`, opacity: fast(f, 1) }}>
          <Mono s={13} c={P.AI}>To</Mono>
          <div style={{ fontFamily: SERIF, fontSize: 64, fontWeight: 650 }}>{s.payee}</div>
          <div style={{ fontSize: 24, fontWeight: 650, color: P.GOOD, marginTop: 6 }}>{s.keep}</div>
        </div>
        <div style={{ position: 'absolute', left: 1330, top: 690, width: 480, padding: 26, borderRadius: 14, border: `2px dashed ${P.RULE}`, opacity: fast(f, 2) }}>
          <Mono s={13}>{s.cut_label}</Mono>
          <div style={{ fontFamily: SERIF, fontSize: 120, fontWeight: 650, lineHeight: 1, color: P.AI, transform: `scale(${1 + br(f, 1, 0.03, 30)})`, transformOrigin: '0 50%' }}>{s.cut}</div>
        </div>
        <div style={{ position: 'absolute', left: 110, top: 900, width: 1100, fontSize: 30, fontWeight: 600, color: P.SOFT, opacity: fast(f, 4) }}>{s.note}</div>
        <div style={{ position: 'absolute', left: 110, top: 150 }}><div style={{ ...serif(P, 60, undefined) }}>{`${s.payer} → ${s.payee}`}</div></div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const p = u.policy!;
    const L = 140, R = 1780, cut = L + (R - L) * 0.68;
    const ph = L + (R - L) * lerp(f, dur, 0.08, 0.94);
    const after = ph > cut;
    const zone = after ? p.after : p.before;
    return (
      <Stage dur={dur} slate={sl(name, 'if plans change')} from={{ x: 920, y: 540, s: 1.0 }} to={{ x: 1000, y: 540, s: 1.06 }}>
        <div style={{ position: 'absolute', left: L, top: 110, width: 1640 }}><div style={{ ...serif(P, fit(p.title, [[40, 64], [999, 50]]), undefined) }}>{p.title}</div></div>
        <div style={{ position: 'absolute', left: L, top: 270 }}>
          <Mono s={14} c={after ? P.WARN : P.GOOD}>{after ? 'Now' : 'Now'}</Mono>
          <div style={{ fontFamily: SERIF, fontSize: 110, fontWeight: 650, color: after ? P.WARN : P.GOOD, lineHeight: 1.05 }}>{zone.label}</div>
          <div style={{ fontSize: 26, color: P.SOFT, marginTop: 6 }}>{zone.detail}</div>
        </div>
        <div style={{ position: 'absolute', left: L, top: 640, width: cut - L, height: 70, background: '#E3F2E9', borderRadius: '12px 0 0 12px', border: `2px solid ${P.GOOD}` }} />
        <div style={{ position: 'absolute', left: cut, top: 640, width: R - cut, height: 70, background: '#FBEFD9', borderRadius: '0 12px 12px 0', border: `2px solid ${P.WARN}` }} />
        <div style={{ position: 'absolute', left: L + 20, top: 662, fontSize: 21, fontWeight: 700, color: P.GOOD }}>{p.before.label}</div>
        <div style={{ position: 'absolute', left: cut + 20, top: 662, fontSize: 21, fontWeight: 700, color: P.WARN }}>{p.after.label}</div>
        <div style={{ position: 'absolute', left: cut - 3, top: 600, width: 6, height: 160, background: P.INK }} />
        <div style={{ position: 'absolute', left: cut - 150, top: 780, width: 300, textAlign: 'center' }}>
          <div style={{ fontFamily: SERIF, fontSize: 56, fontWeight: 650 }}>{p.window}</div>
          <Mono s={13}>before the session</Mono>
        </div>
        <div style={{ position: 'absolute', left: R - 10, top: 600, width: 6, height: 160, background: P.A }} />
        <div style={{ position: 'absolute', left: R - 230, top: 780, width: 240, textAlign: 'right' }}><Mono s={14} c={P.AI}>Session</Mono></div>
        <div style={{ position: 'absolute', left: ph - 2, top: 590, width: 4, height: 180, background: P.A }} />
        <div style={{ position: 'absolute', left: ph - 22, top: 568, width: 44, height: 44, borderRadius: 99, background: P.A, boxShadow: `0 0 0 8px ${P.AT}` }} />
        {p.note ? (
          <div style={{ position: 'absolute', left: L, top: 900, display: 'flex', alignItems: 'center', gap: 18, opacity: fast(f, 4) }}>
            <Btn t="Cancel" ghost s={0.95} />
            <span style={{ fontSize: 22, color: P.SOFT, fontWeight: 600 }}>{p.note}</span>
          </div>
        ) : null}
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const c = u.checklist!;
    const items = c.items.slice(0, 6);
    const per = Math.max(3, (dur - 14) / items.length);
    return (
      <Stage dur={dur} slate={sl(name, 'what you get')} from={{ x: 980, y: 520, s: 1.0 }} to={{ x: 940, y: 560, s: 1.06 }}>
        <div style={{ position: 'absolute', left: 120, top: 100, width: 1100 }}><div style={{ ...serif(P, fit(c.title, [[30, 66], [999, 54]]), undefined) }}>{c.title}</div></div>
        {items.map((t, i) => (
          <div key={t} style={{ position: 'absolute', left: 120, top: 270 + i * 120, width: 980, display: 'flex', alignItems: 'center', gap: 22, paddingBottom: 20, borderBottom: `1.5px solid ${P.RULE}`, opacity: fast(f, i * 0.8) }}>
            <Tick at={2 + i * per} s={52} />
            <span style={{ fontSize: 40, fontWeight: 700, letterSpacing: -0.8, color: f >= 2 + i * per ? P.INK : P.MUTED }}>{t}</span>
          </div>
        ))}
        {c.card ? (
          <div style={{ position: 'absolute', left: 1210, top: 260, width: 600, borderRadius: 16, background: P.CARD, border: `1.5px solid ${P.RULE}`, padding: 32, opacity: fast(f, 3), transform: `rotate(${1.5 + br(f, 3, 0.4, 60)}deg)`, boxShadow: '0 40px 70px -40px rgba(0,0,0,.45)' }}>
            <Mono s={13}>{c.card.title}</Mono>
            {c.card.seen.map((s, i) => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: i ? 12 : 22, padding: '16px 18px', borderRadius: 10, background: '#E7F4EC', fontSize: 26, fontWeight: 700 }}>
                <span style={{ width: 12, height: 12, borderRadius: 99, background: P.GOOD }} />{s}
              </div>
            ))}
            {c.card.hidden.map((s, i) => {
              const k = ez(f, 10 + i * 6, 20 + i * 6);
              return (
                <div key={s} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 14, marginTop: 12, padding: '16px 18px', borderRadius: 10, background: P.G2, fontSize: 24, fontWeight: 600, color: P.MUTED }}>
                  <span style={{ fontSize: 20 }}>🔒</span>{s}
                  <div style={{ position: 'absolute', left: 54, top: '50%', height: 3, width: `${k * 70}%`, background: P.BAD }} />
                </div>
              );
            })}
            <div style={{ marginTop: 20, fontSize: 20, color: P.SOFT, fontWeight: 600 }}>{c.card.note}</div>
          </div>
        ) : null}
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const e = u.extra!;
    const tiles = e.tiles.slice(0, 4);
    const cx = 960, cy = 560;
    const spots: [number, number][] = [[-700, -190], [380, -190], [-700, 150], [380, 150]];
    return (
      <Stage dur={dur} slate={sl(name, e.kicker.toLowerCase())} from={{ x: 960, y: 520, s: 1.1 }} to={{ x: 960, y: 560, s: 1.0 }}>
        <div style={{ position: 'absolute', left: 0, top: 96, width: W, textAlign: 'center' }}>
          <Mono s={15} c={P.AI}>{e.kicker}</Mono>
          <div style={{ ...serif(P, fit(e.title, [[34, 64], [999, 52]]), undefined), ...{ marginTop: 10 } }}>{e.title}</div>
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ position: 'absolute', left: cx - 150 - i * 40, top: cy - 150 - i * 40, width: 300 + i * 80, height: 300 + i * 80, borderRadius: 999, border: `2px solid ${P.A}`, opacity: 0.35 - i * 0.1 + 0.1 * Math.sin((f + i * 10) / 8) }} />
        ))}
        <div style={{ position: 'absolute', left: cx - 130, top: cy - 130, width: 260, height: 260, borderRadius: 999, background: `radial-gradient(circle at 35% 30%, #fff, ${P.A})`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          {Array.from({ length: 9 }).map((_, i) => (
            <span key={i} style={{ width: 12, height: 30 + Math.abs(Math.sin((f + i * 4) / 4.5)) * 70, borderRadius: 8, background: '#fff' }} />
          ))}
        </div>
        {tiles.map((t, i) => (
          <div key={t.title} style={{ position: 'absolute', left: cx + spots[i][0], top: cy + spots[i][1] - 70, width: 320, padding: '24px 26px', borderRadius: 14, background: P.CARD, border: `1.5px solid ${P.RULE}`, opacity: fast(f, 1 + i), transform: `translateY(${br(f, i, 7, 46)}px)` }}>
            <div style={{ fontFamily: SERIF, fontSize: 44, fontWeight: 650 }}>{t.title}</div>
            <div style={{ fontSize: 21, color: P.MUTED, marginTop: 6, lineHeight: 1.3 }}>{t.detail}</div>
          </div>
        ))}
        <div style={{ position: 'absolute', left: 260, top: 840, width: 1400, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 20 }}>
          {(e.actions ?? []).slice(0, 3).map((a, i, arr) => (
            <React.Fragment key={a}>
              <span style={{ padding: '16px 24px', borderRadius: 12, fontSize: 22, fontWeight: 700, background: lerp(f, dur, 0, arr.length) > i ? P.INK : P.CARD, color: lerp(f, dur, 0, arr.length) > i ? '#fff' : P.INK, border: `1.5px solid ${P.INK}`, opacity: fast(f, 3 + i) }}>{a}</span>
              {i < arr.length - 1 ? <span style={{ fontSize: 30, color: P.A }}>→</span> : null}
            </React.Fragment>
          ))}
        </div>
        <div style={{ position: 'absolute', left: 0, top: 960, width: W, display: 'flex', justifyContent: 'center', gap: 14 }}>
          {(e.notes ?? []).slice(0, 3).map((n, i) => <Pill key={n} t={n} at={5 + i} />)}
        </div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const e = u.extra!;
    const rc = e.recap!;
    const land = ez(f, 6, 16);
    return (
      <Stage dur={dur} slate={sl(name, 'the recap')} from={{ x: 960, y: 560, s: 1.0 }} to={{ x: 960, y: 520, s: 1.07 }}>
        <div style={{ position: 'absolute', left: 120, top: 170, width: 760 }}>
          <Mono s={15}>{e.kicker}</Mono>
          <div style={{ ...serif(P, fit(e.body, [[60, 62], [999, 52]]), undefined), ...{ marginTop: 12 } }}>{e.body}</div>
          <div style={{ marginTop: 40, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {e.tiles.slice(0, 4).map((t, i) => (
              <div key={t.title} style={{ padding: '16px 18px', borderRadius: 12, background: P.CARD, border: `1.5px solid ${P.RULE}`, display: 'flex', alignItems: 'center', gap: 12, opacity: fast(f, 2 + i) }}>
                {bullet(P, 28)}
                <span style={{ fontSize: 22, fontWeight: 700 }}>{t.title}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ position: 'absolute', left: 1050, top: 60, width: 520, height: 1000, borderRadius: 60, background: 'linear-gradient(180deg, #2B2F45, #6E5A8A 55%, #E7A1B8)', border: `12px solid ${P.INK}`, overflow: 'hidden', opacity: fast(f, 0) }}>
          <div style={{ marginTop: 120, textAlign: 'center', color: '#fff', fontFamily: SERIF, fontSize: 110, fontWeight: 500, opacity: 0.92 }}>{' '}</div>
          <div style={{ position: 'absolute', left: 22, right: 22, top: 300, padding: 22, borderRadius: 20, background: 'rgba(255,255,255,.92)', transform: `translateY(${(1 - land) * -120}px) scale(${0.94 + 0.06 * land})`, opacity: land }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 40, height: 40, borderRadius: 10, background: P.A, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800 }}>{(u.app_name ?? name).slice(0, 1).toUpperCase()}</span>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{u.app_name ?? name}</span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 750, marginTop: 12 }}>{rc.title}</div>
            <div style={{ fontSize: 18, color: P.SOFT, marginTop: 6, lineHeight: 1.35 }}>{rc.body}</div>
          </div>
          {(e.notes ?? []).slice(0, 2).map((n, i) => (
            <div key={n} style={{ position: 'absolute', left: 22, right: 22, top: 560 + i * 110, padding: '18px 22px', borderRadius: 20, background: 'rgba(255,255,255,.55)', fontSize: 20, fontWeight: 650, opacity: ez(f, 14 + i * 5, 22 + i * 5), transform: `translateY(${br(f, i, 3, 40)}px)` }}>{n}</div>
          ))}
        </div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const r = u.reviews!;
    const rules = r.rules ?? [];
    return (
      <Stage dur={dur} slate={sl(name, 'reviews')} from={{ x: 960, y: 560, s: 1.12 }} to={{ x: 940, y: 540, s: 1.04 }}>
        <div style={{ position: 'absolute', left: 140, top: 120, width: 1000 }}>
          <Mono s={15}>{r.title}</Mono>
          <div style={{ ...serif(P, fit(r.body, [[50, 64], [999, 54]]), undefined), ...{ marginTop: 10 } }}>{r.body}</div>
        </div>
        <div style={{ position: 'absolute', left: 1180, top: 140, width: 620, height: 380, padding: 36, borderRadius: 16, background: P.CARD, border: `2px dashed ${P.RULE}`, opacity: fast(f, 1) }}>
          <Mono s={13}>{u.results?.cards[u.results.pick]?.title ?? r.title}</Mono>
          <div style={{ display: 'flex', gap: 8 }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <svg key={i} width={54} height={54} viewBox="0 0 24 24"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z" fill="none" stroke={P.RULE} strokeWidth={1.6} strokeDasharray={Math.abs(Math.sin((f + i * 5) / 10)) > 0.5 ? '3 3' : '0'} /></svg>
            ))}
          </div>
          <div style={{ fontSize: 30, fontWeight: 700, marginTop: 24, lineHeight: 1.3 }}>{r.empty}</div>
        </div>
        <div style={{ position: 'absolute', left: 140, top: 700, width: 1640, display: 'flex', alignItems: 'center', gap: 24 }}>
          {rules.map((t, i) => (
            <React.Fragment key={t}>
              <div style={{ flex: 1, padding: '30px 30px', borderRadius: 14, background: lerp(f, dur, 0, rules.length + 0.5) > i + 0.5 ? P.AT : P.CARD, border: `2px solid ${lerp(f, dur, 0, rules.length + 0.5) > i + 0.5 ? P.A : P.RULE}`, display: 'flex', alignItems: 'center', gap: 18, opacity: fast(f, 2 + i) }}>
                <Tick at={4 + i * ((dur - 10) / Math.max(1, rules.length))} s={44} />
                <span style={{ fontFamily: SERIF, fontSize: 44, fontWeight: 620 }}>{t}</span>
              </div>
              {i < rules.length - 1 ? <span style={{ fontSize: 44, color: P.A }}>→</span> : null}
            </React.Fragment>
          ))}
        </div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const s = u.supply!;
    const days = u.recurring?.days ?? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const pressAt = Math.round(dur * 0.78);
    return (
      <Stage dur={dur} slate={sl(name, (s.kicker ?? 'the other side').toLowerCase())} from={{ x: 1020, y: 520, s: 1.0 }} to={{ x: 960, y: 580, s: 1.07 }}>
        <div style={{ position: 'absolute', left: 90, top: 96, width: 1740, height: 930, borderRadius: 16, background: P.CARD, border: `1.5px solid ${P.RULE}`, overflow: 'hidden' }}>
          <AppBar name={u.app_name ?? name} nav={u.nav ?? []} active={Math.max(0, (u.nav ?? []).length - 1)} w={1740} />
          <div style={{ position: 'absolute', left: 60, top: 120, width: 760 }}>
            {s.kicker ? <Mono s={14} c={P.AI}>{s.kicker}</Mono> : null}
            <div style={{ ...serif(P, fit(s.title, [[34, 68], [999, 54]]), undefined), ...{ marginTop: 10 } }}>{s.title}</div>
            <div style={{ fontSize: 24, color: P.SOFT, lineHeight: 1.4, marginTop: 18 }}>{s.body}</div>
            <div style={{ marginTop: 26 }}>
              {s.items.slice(0, 4).map((t, i) => (
                <div key={t} style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, fontSize: 22, fontWeight: 650, opacity: fast(f, 2 + i) }}>{bullet(P, 28)}{t}</div>
              ))}
            </div>
          </div>
          <div style={{ position: 'absolute', left: 900, top: 120, width: 780, padding: 34, borderRadius: 14, background: P.G, border: `1.5px solid ${P.RULE}` }}>
            <Mono s={13}>{s.items[0] ?? 'Your profile'}</Mono>
            <div style={{ marginTop: 10, height: 74, borderRadius: 12, background: P.CARD, border: `2px solid ${P.A}`, display: 'flex', alignItems: 'center', padding: '0 22px', fontSize: 30, fontWeight: 700, color: P.MUTED }}>
              {s.items[0] ?? ''}<span style={{ color: P.A, marginLeft: 6 }}>{caret(f)}</span>
            </div>
            <div style={{ marginTop: 26 }}><Mono s={13}>{s.items[1] ?? ''}</Mono></div>
            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              {days.slice(0, 7).map((d, i) => {
                const on = lerp(f, dur * 0.7, 0, days.length) > i && i % 3 !== 2;
                return <span key={d} style={{ flex: 1, height: 64, borderRadius: 10, display: 'grid', placeItems: 'center', fontSize: 18, fontWeight: 700, background: on ? P.A : P.CARD, color: on ? '#fff' : P.MUTED, border: `1.5px solid ${on ? P.A : P.RULE}` }}>{d}</span>;
              })}
            </div>
            <div style={{ marginTop: 34 }}><Btn t={s.cta} w="100%" press={pressAt} /></div>
          </div>
        </div>
        <Cursor path={[[1100, 520, 0], [1240, 400, dur * 0.4], [1290, 860, pressAt - 2], [1330, 900, dur]]} clicks={[pressAt]} />
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const st = u.steps.slice(0, 5);
    const n = st.length;
    const cw = (1680 - (n - 1) * 24) / n;
    const tr = lerp(f, dur - 6, -0.3, n - 0.4);
    return (
      <Stage dur={dur} slate={sl(name, 'how it works')} from={{ x: 960, y: 560, s: 1.0 }} to={{ x: 960, y: 540, s: 1.05 }}>
        <div style={{ position: 'absolute', left: 120, top: 110 }}><div style={{ ...serif(P, 64, undefined) }}>{u.close.headline}</div></div>
        <div style={{ position: 'absolute', left: 120, top: 395, width: 1680, height: 6, background: P.G2, borderRadius: 6 }} />
        <div style={{ position: 'absolute', left: 120, top: 395, width: Math.max(0, Math.min(1, (tr + 0.5) / n)) * 1680, height: 6, background: P.A, borderRadius: 6 }} />
        {st.map((s, i) => {
          const on = tr >= i ? 1 : 0;
          return (
            <div key={s.title} style={{ position: 'absolute', left: 120 + i * (cw + 24), top: 330, width: cw, opacity: fast(f, i) }}>
              <div style={{ width: 130, height: 130, borderRadius: 99, background: on ? P.AT : P.CARD, border: `3px solid ${on ? P.A : P.RULE}`, display: 'grid', placeItems: 'center', transform: `scale(${on ? 1 + 0.08 * Math.max(0, 1 - Math.abs(tr - i) * 2) : 1})` }}>
                <StepGlyph i={i} on={on} />
              </div>
              <div style={{ marginTop: 26 }}><Mono s={14} c={on ? P.AI : P.MUTED}>{`Step ${i + 1}`}</Mono></div>
              <div style={{ fontFamily: SERIF, fontSize: 52, fontWeight: 640, marginTop: 6 }}>{s.title}</div>
              <div style={{ fontSize: 22, color: P.SOFT, marginTop: 8, lineHeight: 1.35, maxWidth: cw - 20 }}>{s.detail}</div>
            </div>
          );
        })}
        <div style={{ position: 'absolute', left: 120, top: 880, width: 1680, display: 'flex', gap: 14, opacity: fast(f, 5) }}>
          {(u.find?.filters ?? []).map((x) => <Pill key={x.label} t={`${x.label}: ${x.pick}`} at={5} />)}
          {u.booking ? <Pill t={u.booking.slot_label} on at={6} /> : null}
          {u.recurring ? <Pill t={u.recurring.label} on at={7} /> : null}
        </div>
      </Stage>
    );
  },

  ({ dur }) => {
    const f = useCurrentFrame();
    const P = usePal();
    const { u, name } = useU();
    const c = u.close;
    const pressAt = Math.round(dur * 0.55);
    const fl = u.find?.filters ?? [];
    return (
      <Stage dur={dur} slate={sl(name, 'start here')} from={{ x: 960, y: 560, s: 1.12 }} to={{ x: 960, y: 540, s: 1.0 }}>
        <div style={{ position: 'absolute', left: 70, top: 76, width: 1780, height: 700, borderRadius: 18, background: P.A }} />
        <div style={{ position: 'absolute', left: 140, top: 120, width: 1640 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, opacity: fast(f, 0) }}>
            <span style={{ width: 70, height: 70, borderRadius: 16, background: '#fff', display: 'grid', placeItems: 'center', color: P.AI, fontWeight: 800, fontSize: 40 }}>{(u.app_name ?? name).slice(0, 1).toUpperCase()}</span>
            <span style={{ fontSize: 56, fontWeight: 800, letterSpacing: -1.5 }}>{u.app_name ?? name}</span>
          </div>
          <div style={{ ...serif(P, fit(c.headline, [[40, 92], [70, 76], [999, 60]]), undefined), ...{ marginTop: 34, clipPath: `inset(0 ${100 - 100 * ez(f, 2, 14)}% 0 0)` } }}>{c.headline}</div>
          {c.sub ? <div style={{ fontSize: 28, marginTop: 18, maxWidth: 1300, opacity: fast(f, 3), color: '#1b1b1b' }}>{c.sub}</div> : null}
        </div>
        <div style={{ position: 'absolute', left: 140, top: 560, width: 1640, padding: 24, borderRadius: 16, background: '#fff', display: 'flex', gap: 18, alignItems: 'flex-end', opacity: fast(f, 4), boxShadow: '0 40px 80px -40px rgba(0,0,0,.45)' }}>
          {fl.slice(0, 3).map((x, i) => <Field key={x.label} label={x.label} value={x.pick} at={4 + i} w={360} />)}
          <div style={{ flex: 1 }}><Btn t={c.cta} press={pressAt} w="100%" s={1.1} /></div>
        </div>
        <div style={{ position: 'absolute', left: 140, top: 790, display: 'flex', gap: 26, opacity: fast(f, 6) }}>
          {(c.notes ?? []).slice(0, 3).map((t, i) => (
            <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 24, fontWeight: 650, color: '#1b1b1b' }}><Tick at={8 + i * 3} s={28} c={P.INK} />{t}</span>
          ))}
        </div>
        <div style={{ position: 'absolute', left: 140, top: 900, padding: '14px 26px', borderRadius: 12, background: P.INK, color: '#fff', fontFamily: MONO, fontSize: 40, letterSpacing: 1, opacity: fast(f, 7), transform: `scale(${1 + 0.04 * Math.sin(f / 9)})`, transformOrigin: '0 50%' }}>{c.url}</div>
        <Cursor path={[[1700, 1000, 0], [1500, 650, pressAt - 2], [1540, 690, dur]]} clicks={[pressAt]} />
      </Stage>
    );
  },
];

export const filmFrames = (c: FilmContent): number => inUseFrames(c);

export const InUseFilm: React.FC<{ content: FilmContent }> = ({ content }) => {
  const u = resolveInUse(content);
  const ids = shotIds(u);
  const durs = planDurations(ids);
  const pal = makePal(u.brand);
  let from = 0;
  return (
    <PalCtx.Provider value={pal}>
      <UCtx.Provider value={{ u, name: content.product_name, ids }}>
        <AbsoluteFill style={{ background: pal.G }}>
          {ids.map((id, i) => {
            const S = SHOTS[SHOT_ORDER.indexOf(id)];
            const at = from;
            from += durs[i];
            return (
              <Sequence key={id} from={at} durationInFrames={durs[i]}>
                <S dur={durs[i]} />
              </Sequence>
            );
          })}
        </AbsoluteFill>
      </UCtx.Provider>
    </PalCtx.Provider>
  );
};

