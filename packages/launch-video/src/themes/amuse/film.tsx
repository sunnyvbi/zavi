import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import { C, SANS, MONO, Ground, Zavi, Pill, Card, CardHead, Big, Label, Illustrative, ez, win, br } from './kit';
import type { FilmContent } from '../content';

const FPS = 30;
const BEAT = 15;
const W = 1920;

type ShotProps = { c: FilmContent; dur: number };

const Open: React.FC<ShotProps> = ({ c }) => {
  const f = useCurrentFrame();
  return (
    <>
      {}
      <div style={{ position: 'absolute', left: 150, top: 240, width: 1020 }}>
        <Label>{c.product_name}</Label>
        <div style={{ marginTop: 24 }}>
          <Big
            size={c.one_liner.length > 110 ? 58 : c.one_liner.length > 70 ? 70 : 92}
            o={ez(f, 4, 26)}
            dy={(1 - ez(f, 4, 26)) * 16}
          >
            {c.one_liner}
          </Big>
        </div>
      </div>
      <div style={{ position: 'absolute', right: 150, top: 330, opacity: ez(f, 16, 40) }}>
        <Zavi size={280} rot={br(f, 2, 3, 220)} />
      </div>
      {}
      <div style={{ position: 'absolute', left: 150, bottom: 120, display: 'flex', gap: 16, opacity: ez(f, 34, 56) }}>
        {c.features.slice(0, 2).map((ft, i) => (
          <Pill key={i} label={ft.title} f={f} seed={i} />
        ))}
      </div>
    </>
  );
};

const Problem: React.FC<ShotProps> = ({ c }) => {
  const f = useCurrentFrame();
  return (
    <>
      <div style={{ position: 'absolute', left: 150, top: 330, width: 1180 }}>
        <Label c={C.warn}>Today</Label>
        <div style={{ marginTop: 24 }}>
          <Big size={74} o={ez(f, 4, 24)} dy={(1 - ez(f, 4, 24)) * 14}>
            {c.problem}
          </Big>
        </div>
      </div>
      <div style={{ position: 'absolute', right: 170, top: 300, opacity: ez(f, 22, 44) }}>
        <Zavi pose="down" size={220} rot={br(f, 5, 2.5, 240)} />
      </div>
    </>
  );
};

const Surface: React.FC<ShotProps> = ({ c }) => {
  const f = useCurrentFrame();
  const items = c.surface?.items ?? [];
  return (
    <>
      <div style={{ position: 'absolute', left: 150, top: 220, width: 620 }}>
        <Label>What you do with it</Label>
        <div style={{ marginTop: 22 }}>
          <Big size={64} o={ez(f, 3, 22)}>
            {c.surface?.title ?? c.product_name}
          </Big>
        </div>
        <div style={{ marginTop: 40, opacity: ez(f, 30, 52) }}>
          <Zavi size={190} rot={br(f, 8, 3, 210)} />
        </div>
      </div>
      <div style={{ position: 'absolute', right: 170, top: 190, display: 'flex', flexDirection: 'column', gap: 22 }}>
        {items.slice(0, 4).map((item, i) => (
          <Card key={i} w={720} o={ez(f, 10 + i * 8, 26 + i * 8)} dy={(1 - ez(f, 10 + i * 8, 26 + i * 8)) * 22}>
            <CardHead word={`Step ${i + 1}`} right={item.chips[0] ?? ''} />
            <div style={{ padding: '22px 26px', fontFamily: SANS, fontSize: 30, fontWeight: 620, color: C.ink }}>
              {item.title}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
};

const Wall: React.FC<ShotProps> = ({ c }) => {
  const f = useCurrentFrame();
  const items = c.features.slice(0, 8);
  return (
    <>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 150, textAlign: 'center' }}>
        <Big size={82} color={C.muted} o={ez(f, 2, 20)}>
          Everything it does.
        </Big>
      </div>
      <div style={{ position: 'absolute', left: '50%', top: 560, transform: 'translate(-50%, -50%)', opacity: ez(f, 14, 34) }}>
        <Zavi size={210} rot={br(f, 1, 3, 200)} />
      </div>
      {items.map((ft, i) => {
        const a = (i / items.length) * Math.PI * 2 - Math.PI / 2;
        const rx = 660;
        const ry = 300;
        const x = W / 2 + Math.cos(a) * rx;
        const y = 560 + Math.sin(a) * ry;
        const mark = (c.marks ?? []).find((m) => ft.title.toLowerCase().includes(m.title.toLowerCase()));
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <Pill label={ft.title} f={f} seed={i} o={ez(f, 18 + i * 5, 34 + i * 5)} {...(mark ? { mark } : {})} />
          </div>
        );
      })}
    </>
  );
};

const Feature: React.FC<ShotProps & { index: number }> = ({ c, dur, index }) => {
  const f = useCurrentFrame();
  const ft = c.features[index];
  if (!ft) return null;
  const mark = (c.marks ?? []).find((m) => `${ft.title} ${ft.detail}`.toLowerCase().includes(m.title.toLowerCase()));
  return (
    <>
      <div style={{ position: 'absolute', left: 150, top: 330, width: 1000 }}>
        <Label>
          {String(index + 1).padStart(2, '0')} / {String(c.features.length).padStart(2, '0')}
        </Label>
        <div style={{ marginTop: 22 }}>
          <Big size={78} o={ez(f, 3, 22)} dy={(1 - ez(f, 3, 22)) * 14}>
            {ft.title}
          </Big>
        </div>
      </div>
      <div style={{ position: 'absolute', right: 170, top: 330, opacity: ez(f, 16, 36) }}>
        <Card w={620} dy={(1 - ez(f, 16, 36)) * 26}>
          <CardHead word={c.product_name} />
          <div style={{ padding: '26px 28px', fontFamily: SANS, fontSize: 27, lineHeight: 1.45, color: C.soft }}>
            {ft.detail}
          </div>
        </Card>
        {mark ? (
          <div style={{ marginTop: 22, display: 'flex', justifyContent: 'flex-end' }}>
            <Pill label={mark.title} f={f} seed={4} mark={mark} />
          </div>
        ) : null}
      </div>
      <div style={{ position: 'absolute', left: 150, bottom: 170, opacity: win(f, 26, 46, dur - 10, dur) }}>
        <Zavi pose={index % 2 === 0 ? 'front-512' : 'blink'} size={150} rot={br(f, index + 2, 3, 190)} />
      </div>
    </>
  );
};

const Numbers: React.FC<ShotProps> = ({ c }) => {
  const f = useCurrentFrame();
  const metrics = (c.metrics ?? []).slice(0, 3);
  return (
    <>
      <div style={{ position: 'absolute', left: 150, top: 200 }}>
        <Label>What it has done</Label>
      </div>
      <div style={{ position: 'absolute', left: 150, top: 300, display: 'flex', gap: 30 }}>
        {metrics.map((m, i) => (
          <Card key={i} w={480} o={ez(f, 6 + i * 8, 24 + i * 8)} dy={(1 - ez(f, 6 + i * 8, 24 + i * 8)) * 24}>
            <CardHead word={c.product_name} />
            <div style={{ padding: '30px 30px 34px' }}>
              <div style={{ fontFamily: SANS, fontSize: 78, fontWeight: 760, letterSpacing: -2.4, color: C.ink, lineHeight: 1 }}>
                {m.stat}
              </div>
              <div style={{ fontFamily: SANS, fontSize: 23, color: C.soft, marginTop: 14, lineHeight: 1.35 }}>{m.label}</div>
            </div>
          </Card>
        ))}
      </div>
      <div style={{ position: 'absolute', right: 210, bottom: 230, opacity: ez(f, 26, 48) }}>
        <Zavi pose="delighted" size={200} rot={br(f, 3, 3, 210)} />
      </div>
    </>
  );
};

const Coverage: React.FC<ShotProps> = ({ c }) => {
  const f = useCurrentFrame();
  const places = (c.regions ?? []).slice(0, 8);
  return (
    <>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 200, textAlign: 'center' }}>
        <Big size={78} o={ez(f, 2, 20)}>
          Where it works.
        </Big>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 430,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 20,
          justifyContent: 'center',
          padding: '0 220px',
        }}
      >
        {places.map((place, i) => (
          <Pill key={i} label={place} f={f} seed={i} o={ez(f, 10 + i * 5, 26 + i * 5)} />
        ))}
      </div>
      <div style={{ position: 'absolute', left: '50%', bottom: 150, transform: 'translateX(-50%)', opacity: ez(f, 34, 56) }}>
        <Zavi size={170} rot={br(f, 6, 3, 200)} />
      </div>
    </>
  );
};

const Close: React.FC<ShotProps> = ({ c }) => {
  const f = useCurrentFrame();
  return (
    <>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 330, textAlign: 'center' }}>
        <Big size={110} o={ez(f, 3, 22)} dy={(1 - ez(f, 3, 22)) * 18}>
          {c.cta_text}
        </Big>
        <div style={{ marginTop: 40, display: 'flex', justifyContent: 'center', opacity: ez(f, 18, 38) }}>
          <div
            style={{
              background: C.ink,
              color: C.paper,
              borderRadius: 999,
              padding: '20px 40px',
              fontFamily: MONO,
              fontSize: 27,
              boxShadow: '0 22px 50px rgba(32,28,18,0.22)',
            }}
          >
            {c.cta_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
          </div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: '50%', bottom: 140, transform: 'translateX(-50%)', opacity: ez(f, 30, 52) }}>
        <Zavi pose="delighted" size={210} rot={br(f, 9, 3, 200)} />
      </div>
    </>
  );
};

type Shot = { dur: number; render: React.FC<ShotProps>; illustrative?: boolean };

export function planShots(c: FilmContent): Shot[] {
  const shots: Shot[] = [{ dur: BEAT * 9, render: Open }];
  if (c.problem) shots.push({ dur: BEAT * 8, render: Problem });
  if ((c.surface?.items.length ?? 0) > 0) shots.push({ dur: BEAT * 10, render: Surface, illustrative: true });
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

export const AmuseFilm: React.FC<{ content: FilmContent }> = ({ content }) => {
  const frame = useCurrentFrame();
  const shots = planShots(content);
  let at = 0;
  return (
    <AbsoluteFill>
      {}
      <Ground f={frame} />
      {shots.map((shot, i) => {
        const from = at;
        at += shot.dur;
        const Shot = shot.render;
        return (
          <Sequence key={i} from={from} durationInFrames={shot.dur}>
            <AbsoluteFill>
              <Shot c={content} dur={shot.dur} />
              {}
              {shot.illustrative ? <Illustrative /> : null}
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
