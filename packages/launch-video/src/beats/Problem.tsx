import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from 'remotion';
import type { ProblemBeat } from '../brief';
import type { Theme } from '../theme';
import { readableSurface } from '../theme';
import { ContentStage } from '../scenes/kit';

const EASE = Easing.bezier(0.22, 1, 0.36, 1);

function splitStatement(h: string): [string, string | null] {
  const m = /^(.*?[.!?])\s+(.+)$/.exec(h.trim());
  if (m && m[1].length > 4) return [m[1], m[2]];
  return [h, null];
}

const Words: React.FC<{ text: string; startFrame: number; color: string }> = ({
  text,
  startFrame,
  color,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(' ');
  return (
    <>
      {words.map((w, i) => {
        const s = spring({
          frame: frame - (startFrame + i * 2.2),
          fps,
          config: { damping: 200, stiffness: 90, mass: 0.8 },
        });
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              marginRight: '0.26em',
              opacity: s,
              transform: `translateY(${interpolate(s, [0, 1], [30, 0])}px)`,
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

export const Problem: React.FC<{ beat: ProblemBeat; theme: Theme; brandMark?: string }> = ({
  beat,
  theme,
  brandMark,
}) => {
  const frame = useCurrentFrame();
  const L = readableSurface(theme);

  const [lead, tail] = splitStatement(beat.headline ?? '');
  const eyebrowIn = interpolate(frame, [4, 18], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE,
  });
  const tailStart = 12 + lead.split(' ').length * 2.2 + 4;
  const ruleW = interpolate(frame, [tailStart + 8, tailStart + 30], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE,
  });
  const subIn = interpolate(frame, [tailStart + 16, tailStart + 40], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE,
  });

  return (
    <ContentStage theme={theme} brandMark={brandMark}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: `0 ${theme.spacing.margin + 40}px`,
        }}
      >
        <div
          style={{
            ...theme.type.eyebrow,
            color: L.accentText,
            opacity: eyebrowIn,
            transform: `translateY(${(1 - eyebrowIn) * 10}px)`,
            marginBottom: 30,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: 4, background: L.accentText }} />
          WHY NOW
        </div>
        <h2
          style={{
            fontFamily: theme.fonts.headline,
            fontWeight: 600,
            fontSize: 92,
            lineHeight: 1.04,
            letterSpacing: '-0.005em',
            color: L.ink,
            margin: 0,
            maxWidth: 1500,
          }}
        >
          <Words text={lead} startFrame={12} color={L.ink} />
          {tail && (
            <>
              {' '}
              <Words text={tail} startFrame={tailStart} color={L.accentText} />
            </>
          )}
        </h2>
        <div
          style={{
            marginTop: 34,
            height: 4,
            width: `${ruleW * 180}px`,
            borderRadius: 2,
            background: L.accentText,
          }}
        />
        {beat.sub ? (
          <p
            style={{
              ...theme.type.bodyLg,
              margin: 0,
              marginTop: 28,
              color: L.sub,
              maxWidth: 900,
              opacity: subIn,
              transform: `translateY(${(1 - subIn) * 10}px)`,
            }}
          >
            {beat.sub}
          </p>
        ) : null}
      </div>
    </ContentStage>
  );
};
