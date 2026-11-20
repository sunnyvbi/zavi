import React from 'react';
import { Img, staticFile, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from 'remotion';
import type { HookBeat } from '../brief';
import type { Theme } from '../theme';
import { readableSurface } from '../theme';
import { rgba } from '../theme';
import { Monogram, monogramOf } from '../glyphs';
import { ContentStage, useEntrance, useIdleFloat, useKenBurns } from '../scenes/kit';

const EASE = Easing.bezier(0.22, 1, 0.36, 1);

function splitHeadline(h: string): [string, string | null] {
  const m = /^(.*?[.!?])\s+(.+)$/.exec(h.trim());
  if (m && m[1].length > 4) return [m[1], m[2]];
  return [h, null];
}

const Words: React.FC<{
  text: string;
  startFrame: number;
  color: string;
}> = ({ text, startFrame, color }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(' ');
  return (
    <>
      {words.map((w, i) => {
        const s = spring({ frame: frame - (startFrame + i * 2.2), fps, config: { damping: 200, stiffness: 90, mass: 0.8 } });
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              marginRight: '0.26em',
              opacity: s,
              transform: `translateY(${interpolate(s, [0, 1], [34, 0])}px)`,
              color,
            }}
          >
            {w}
          </span>
        );
      })}
    </>
  );
};

const StatusPill: React.FC<{ theme: Theme; label: string; dot?: boolean }> = ({ theme, label, dot = true }) => {
  const L = theme.light;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 7,
        background: rgba(theme.brand.accent, 0.1),
      }}
    >
      {dot && <div style={{ width: 7, height: 7, borderRadius: 4, background: L.good }} />}
      <span style={{ ...theme.type.meta, fontWeight: 700, color: L.accentText }}>{label}</span>
    </div>
  );
};

const ChromePanel: React.FC<{ theme: Theme; brandMark: string }> = ({ theme, brandMark }) => {
  const L = theme.light;
  const front = useEntrance(12, { rise: 30, scaleFrom: 0.96, motion: theme.motion });
  const mid = useEntrance(20, { rise: 30, scaleFrom: 0.95, motion: theme.motion });
  const back = useEntrance(28, { rise: 30, scaleFrom: 0.94, motion: theme.motion });
  const floatF = useIdleFloat(12, { amp: 6, ampX: 2, period: 168, phase: 0, motion: theme.motion });
  const floatM = useIdleFloat(20, { amp: 5, ampX: 2, period: 184, phase: 1.1, motion: theme.motion });
  const floatB = useIdleFloat(28, { amp: 4, ampX: 1.5, period: 200, phase: 2.0, motion: theme.motion });
  const Bar = ({ w, c }: { w: number | string; c?: string }) => (
    <div style={{ height: 9, width: w, borderRadius: 5, background: c ?? L.hairline }} />
  );

  return (
    <div style={{ position: 'relative', width: 470, height: 470 }}>
      {}
      <div
        style={{
          position: 'absolute',
          top: 196,
          left: 178,
          width: 312,
          opacity: back.opacity * 0.22,
          transform: `translate(${floatB.x}px, ${back.translateY + floatB.y}px) rotate(4.4deg) scale(0.93)`,
          transformOrigin: '50% 0%',
          background: L.card,
          borderRadius: 12,
          boxShadow: theme.shadow.card,
          overflow: 'hidden',
        }}
      >
        <div style={{ height: 3, background: theme.brand.secondary }} />
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <StatusPill theme={theme} label="DAY ONE" />
          <Bar w={'88%'} />
          <Bar w={'62%'} />
        </div>
      </div>
      {}
      <div
        style={{
          position: 'absolute',
          top: 100,
          left: 96,
          width: 348,
          opacity: mid.opacity * 0.5,
          transform: `translate(${floatM.x}px, ${mid.translateY + floatM.y}px) rotate(2.4deg) scale(0.965)`,
          transformOrigin: '50% 0%',
          background: L.card,
          borderRadius: 13,
          boxShadow: theme.shadow.card,
          overflow: 'hidden',
        }}
      >
        <div style={{ height: 3, background: theme.brand.accent }} />
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 13 }}>
          <StatusPill theme={theme} label="LIVE" />
          <Bar w={'92%'} />
          <Bar w={'70%'} />
        </div>
      </div>
      {}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 396,
          opacity: front.opacity,
          transform: `translate(${floatF.x}px, ${front.translateY + floatF.y}px) rotate(-1.8deg)`,
          background: L.card,
          borderRadius: 14,
          boxShadow: theme.shadow.lift,
          overflow: 'hidden',
        }}
      >
        <div style={{ height: 4, background: L.accentText }} />
        <div style={{ padding: '26px 28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Monogram label={monogramOf(brandMark)} size={44} bg={theme.brand.accent} radius={11} fontFamily={theme.fonts.body} />
            <span style={{ fontFamily: theme.fonts.body, fontWeight: 700, fontSize: 24, color: L.ink, lineHeight: 1 }}>{brandMark}</span>
          </div>
          <div style={{ height: 1, background: L.hairline, margin: '20px 0' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
            <Bar w={'100%'} />
            <Bar w={'86%'} />
            <Bar w={'64%'} />
          </div>
          <div style={{ marginTop: 24 }}>
            <StatusPill theme={theme} label="NOW LIVE" />
          </div>
        </div>
      </div>
    </div>
  );
};

const HeroImage: React.FC<{ theme: Theme; src: string }> = ({ theme, src }) => {
  const L = theme.light;
  const e = useEntrance(8, { rise: 32, scaleFrom: 0.94, motion: theme.motion });
  const fl = useIdleFloat(8, { amp: 6, ampX: 2, period: 188, phase: 0.4, motion: theme.motion });
  const kb = useKenBurns({ zoom: 0.1, panXPx: -16, panYPx: -10 });
  return (
    <div
      style={{
        position: 'relative',
        width: 760,
        height: 480,
        opacity: e.opacity,
        transform: `translate(${fl.x}px, ${e.translateY + fl.y}px) scale(${e.scale})`,
        background: L.card,
        borderRadius: 18,
        border: `1px solid ${L.hairline}`,
        boxShadow: theme.shadow.lift,
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', inset: 0, top: 4, overflow: 'hidden' }}>
        <Img
          src={staticFile(src)}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: kb.transform }}
        />
      </div>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: theme.brand.accent, zIndex: 1 }} />
    </div>
  );
};

export const Hook: React.FC<{ beat: HookBeat; theme: Theme; brandMark?: string }> = ({
  beat,
  theme,
  brandMark,
}) => {
  const frame = useCurrentFrame();
  const L = readableSurface(theme);
  const mark = brandMark ?? 'Launch';

  const sub = beat.sub ?? '';
  const subIsKicker = sub.length > 0 && sub.length <= 22;
  const eyebrow = (subIsKicker ? sub : mark).toUpperCase();

  const [lead, tail] = splitHeadline(beat.headline ?? '');
  const eyebrowIn = interpolate(frame, [4, 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE });
  const tailStart = 12 + lead.split(' ').length * 2.2 + 4;
  const ruleW = interpolate(frame, [tailStart + 8, tailStart + 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE });
  const subIn = interpolate(frame, [tailStart + 16, tailStart + 38], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE });

  return (
    <ContentStage theme={theme} brandMark={mark}>
      <div
        style={{
          position: 'absolute',
          left: theme.spacing.margin,
          right: theme.spacing.margin,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 80,
        }}
      >
        {}
        <div style={{ maxWidth: 1040 }}>
          <div
            style={{
              ...theme.type.eyebrow,
              color: L.accentText,
              opacity: eyebrowIn,
              transform: `translateY(${(1 - eyebrowIn) * 10}px)`,
              marginBottom: 26,
            }}
          >
            {eyebrow}
          </div>
          <h1 style={{ ...theme.type.h1, margin: 0, color: L.ink }}>
            <Words text={lead} startFrame={12} color={L.ink} />
            {tail && (
              <>
                {' '}
                <Words text={tail} startFrame={tailStart} color={L.accentText} />
              </>
            )}
          </h1>
          <div style={{ marginTop: 30, height: 4, width: `${ruleW * 200}px`, borderRadius: 2, background: L.accentText }} />
          {!subIsKicker && sub && (
            <p
              style={{
                ...theme.type.bodyLg,
                margin: 0,
                marginTop: 26,
                color: L.sub,
                maxWidth: 760,
                opacity: subIn,
                transform: `translateY(${(1 - subIn) * 10}px)`,
              }}
            >
              {sub}
            </p>
          )}
        </div>

        {}
        {beat.image ? <HeroImage theme={theme} src={beat.image} /> : <ChromePanel theme={theme} brandMark={mark} />}
      </div>
    </ContentStage>
  );
};
