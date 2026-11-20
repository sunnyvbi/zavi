import React from 'react';
import { AbsoluteFill, Img, Sequence, useCurrentFrame } from 'remotion';
import {
  W,
  CREAM,
  INK,
  RULE,
  MARIGOLD,
  MINT_DEEP,
  ez,
  Stage,
  Mono,
  Mascot,
  Phone,
  Bubble,
  Tile,
  FactRow,
  Rank,
  GridTile,
  Spark,
} from './ui';
import type { FilmContent } from '../content';

const FPS = 30;
const BEAT = 15;

const across = (f: number, dur: number, a: number, b: number): number =>
  a + (b - a) * Math.min(Math.max(f / Math.max(dur, 1), 0), 1);

const Mark: React.FC<{ src: string; s?: number; o?: number }> = ({ src, s = 26, o = 1 }) => (
  <Img src={src} style={{ width: s, height: s, objectFit: 'contain', display: 'block', flex: 'none', opacity: o }} />
);

type ShotProps = { c: FilmContent; dur: number };

const Open: React.FC<ShotProps> = ({ c, dur }) => {
  const f = useCurrentFrame();
  return (
    <Stage dur={dur}>
      <div style={{ position: 'absolute', left: 120, top: 250, width: 900 }}>
        <Mono s={15} ls={3}>
          {c.product_name}
        </Mono>
        <div
          style={{
            fontSize: 72,
            fontWeight: 760,
            lineHeight: 1.06,
            letterSpacing: -2,
            color: INK,
            marginTop: 20,
            clipPath: `inset(0 ${100 - 100 * ez(f, 6, 22)}% 0 0)`,
          }}
        >
          {c.one_liner}
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 34, alignItems: 'center' }}>
          {(c.marks ?? []).slice(0, 5).map((m, i) => (
            <Mark key={i} src={m.src} s={30} o={ez(f, 24 + i * 4, 34 + i * 4)} />
          ))}
        </div>
      </div>
      {}
      <Phone x={1230} y={90} h={880} title={c.product_name} sub="live">
        {(c.surface?.items ?? c.features.slice(0, 3).map((ft) => ({ title: ft.title, chips: [] })))
          .slice(0, 4)
          .map((item, i) => (
            <Bubble key={i} side={i % 2 === 0 ? 'zavi' : 'me'} at={14 + i * 9} t={item.title} w={430} />
          ))}
      </Phone>
    </Stage>
  );
};

const Problem: React.FC<ShotProps> = ({ c, dur }) => {
  const f = useCurrentFrame();
  return (
    <Stage dur={dur} bg="#101114">
      <div style={{ position: 'absolute', left: 140, top: 300, width: 1180 }}>
        <Mono s={14} ls={3} c="#8b9199">
          Today
        </Mono>
        <div
          style={{
            fontSize: 62,
            fontWeight: 700,
            lineHeight: 1.14,
            letterSpacing: -1.4,
            color: CREAM,
            marginTop: 18,
            clipPath: `inset(0 ${100 - 100 * ez(f, 4, 20)}% 0 0)`,
          }}
        >
          {c.problem}
        </div>
        <div
          style={{
            height: 2,
            marginTop: 40,
            background: MARIGOLD,
            width: `${across(f, dur, 3, 92)}%`,
          }}
        />
      </div>
    </Stage>
  );
};

const Surface: React.FC<ShotProps> = ({ c, dur }) => {
  const f = useCurrentFrame();
  const items = c.surface?.items ?? [];
  return (
    <Stage dur={dur}>
      <div style={{ position: 'absolute', left: 120, top: 170, width: 640 }}>
        <Mono s={14} ls={3}>
          What you do with it
        </Mono>
        <div style={{ fontSize: 46, fontWeight: 740, letterSpacing: -1.2, color: INK, marginTop: 16, lineHeight: 1.1 }}>
          {c.surface?.title ?? c.product_name}
        </div>
        <div style={{ marginTop: 40 }}>
          {items.slice(0, 4).map((item, i) => (
            <div key={i} style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 24, opacity: ez(f, 10 + i * 6, 22 + i * 6) }}>
              <Rank n={i + 1} c={i === 0 ? MARIGOLD : RULE} at={10 + i * 6} />
              <div>
                <div style={{ fontSize: 22, fontWeight: 650, color: INK }}>{item.title}</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  {item.chips.slice(0, 3).map((chip, j) => (
                    <Mono key={j} s={12} ls={1.6}>
                      {chip}
                    </Mono>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Phone x={1120} y={70} h={940} title={c.product_name} sub="in use">
        {items.slice(0, 5).map((item, i) => (
          <Bubble key={i} side={i % 2 === 0 ? 'me' : 'zavi'} at={8 + i * 8} t={item.chips[0] ?? item.title} w={430} />
        ))}
      </Phone>
    </Stage>
  );
};

const Wall: React.FC<ShotProps> = ({ c, dur }) => {
  const f = useCurrentFrame();
  return (
    <Stage dur={dur}>
      <div style={{ position: 'absolute', left: 120, top: 110 }}>
        <Mono s={14} ls={3}>
          Everything it does
        </Mono>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 120,
          top: 190,
          width: W - 240,
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 24,
        }}
      >
        {c.features.slice(0, 6).map((ft, i) => (
          <GridTile
            key={i}
            at={6 + i * 5}
            c={i === 1 ? MARIGOLD : i === 4 ? MINT_DEEP : RULE}
            name={ft.title}
            hot={i === 1}
            s={1}
          />
        ))}
      </div>
      <div style={{ position: 'absolute', left: 120, bottom: 120, width: 520 }}>
        <Spark w={520} h={60} c={MARIGOLD} seed={Math.round(across(f, dur, 0, 40))} />
      </div>
    </Stage>
  );
};

const Feature: React.FC<ShotProps & { index: number }> = ({ c, dur, index }) => {
  const f = useCurrentFrame();
  const ft = c.features[index];
  if (!ft) return null;
  return (
    <Stage dur={dur}>
      <div style={{ position: 'absolute', left: 120, top: 250, width: 900, display: 'flex', gap: 22 }}>
        <Rank n={index + 1} c={MARIGOLD} at={3} />
        <div>
          <div
            style={{
              fontSize: 58,
              fontWeight: 760,
              letterSpacing: -1.6,
              lineHeight: 1.06,
              color: INK,
              clipPath: `inset(0 ${100 - 100 * ez(f, 4, 18)}% 0 0)`,
            }}
          >
            {ft.title}
          </div>
          <div style={{ fontSize: 21, color: '#5b5f66', marginTop: 18, lineHeight: 1.45, opacity: ez(f, 12, 26) }}>
            {ft.detail}
          </div>
        </div>
      </div>
      {}
      <div style={{ position: 'absolute', left: 1240, top: 120, width: 560, height: 840, overflow: 'hidden' }}>
        <div style={{ transform: `translateY(${-across(f, dur, 0, 44)}%)` }}>
          {[...c.features, ...c.features].map((other, i) => (
            <FactRow key={i} at={2 + i} fact={other.title} src={other.title === ft.title ? 'now' : ''} s={20} />
          ))}
        </div>
      </div>
    </Stage>
  );
};

const Numbers: React.FC<ShotProps> = ({ c, dur }) => (
  <Stage dur={dur}>
    <div style={{ position: 'absolute', left: 120, top: 150 }}>
      <Mono s={14} ls={3}>
        What it has done
      </Mono>
    </div>
    <div style={{ position: 'absolute', left: 120, top: 250, display: 'flex', gap: 28 }}>
      {(c.metrics ?? []).slice(0, 3).map((m, i) => (
        <Tile key={i} at={6 + i * 7} label={m.label} value={m.stat} s={40} caption="" sel={i === 0} />
      ))}
    </div>
  </Stage>
);

const Coverage: React.FC<ShotProps> = ({ c, dur }) => (
  <Stage dur={dur}>
    <div style={{ position: 'absolute', left: 120, top: 150 }}>
      <Mono s={14} ls={3}>
        Where it works
      </Mono>
    </div>
    <div
      style={{
        position: 'absolute',
        left: 120,
        top: 240,
        width: W - 240,
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 22,
      }}
    >
      {(c.regions ?? []).slice(0, 8).map((place, i) => (
        <GridTile key={i} at={5 + i * 4} c={i % 3 === 0 ? MINT_DEEP : RULE} name={place} s={0.92} />
      ))}
    </div>
  </Stage>
);

const Close: React.FC<ShotProps> = ({ c, dur }) => {
  const f = useCurrentFrame();
  return (
    <Stage dur={dur}>
      <div style={{ position: 'absolute', left: 120, top: 330, width: 1100 }}>
        <div style={{ fontSize: 96, fontWeight: 820, letterSpacing: -3, color: INK, clipPath: `inset(0 ${100 - 100 * ez(f, 3, 18)}% 0 0)` }}>
          {c.cta_text}
        </div>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 14,
            marginTop: 34,
            background: INK,
            color: CREAM,
            borderRadius: 14,
            padding: '18px 30px',
            fontSize: 24,
            opacity: ez(f, 12, 24),
            transform: `translateY(${(1 - ez(f, 12, 24)) * 14}px)`,
          }}
        >
          {c.cta_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
        </div>
      </div>
      <Mascot pose="zavi-front-512" s={190} x={1480} y={520} rot={across(f, dur, -4, 4)} />
    </Stage>
  );
};

type Shot = { dur: number; render: React.FC<ShotProps> };

export function planShots(c: FilmContent): Shot[] {
  const shots: Shot[] = [{ dur: BEAT * 9, render: Open }];
  if (c.problem) shots.push({ dur: BEAT * 7, render: Problem });
  if ((c.surface?.items.length ?? 0) > 0) shots.push({ dur: BEAT * 10, render: Surface });
  if (c.features.length >= 3) shots.push({ dur: BEAT * 9, render: Wall });
  for (let i = 0; i < Math.min(c.features.length, 6); i++) {
    const Bound: React.FC<ShotProps> = (p) => <Feature {...p} index={i} />;
    shots.push({ dur: BEAT * 7, render: Bound });
  }
  if ((c.metrics ?? []).length > 0) shots.push({ dur: BEAT * 8, render: Numbers });
  if ((c.regions ?? []).length >= 2) shots.push({ dur: BEAT * 7, render: Coverage });
  shots.push({ dur: BEAT * 7, render: Close });

  const floor = 45 * FPS;
  const total = shots.reduce((sum, s) => sum + s.dur, 0);
  if (total < floor) {
    const extra = Math.ceil((floor - total) / BEAT / shots.length);
    for (const s of shots) s.dur += extra * BEAT;
  }
  return shots;
}

export const filmFrames = (c: FilmContent): number => planShots(c).reduce((sum, s) => sum + s.dur, 0);

export const ProductTrueFilm: React.FC<{ content: FilmContent }> = ({ content }) => {
  const shots = planShots(content);
  let at = 0;
  return (
    <AbsoluteFill style={{ background: CREAM }}>
      {shots.map((shot, i) => {
        const from = at;
        at += shot.dur;
        const Shot = shot.render;
        return (
          <Sequence key={i} from={from} durationInFrames={shot.dur}>
            <Shot c={content} dur={shot.dur} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
