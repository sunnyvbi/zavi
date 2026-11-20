import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from 'remotion';
import type { ProofBeat } from '../brief';
import type { Theme } from '../theme';
import { Stage } from './Stage';

export const Proof: React.FC<{ beat: ProofBeat; theme: Theme; brandMark?: string }> = ({
  beat,
  theme,
  brandMark,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const L = theme.light;

  const pop = spring({ frame: frame - 6, fps, config: { damping: 18, stiffness: 110 } });
  const scale = interpolate(pop, [0, 1], [0.86, 1]);
  const ruleW = interpolate(frame, [16, 36], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.22, 1, 0.36, 1) });
  const labelIn = interpolate(frame, [22, 48], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.22, 1, 0.36, 1) });

  const stat = beat.stat ?? beat.headline ?? '';
  const label = beat.statLabel ?? beat.sub ?? '';

  return (
    <Stage theme={theme} brandMark={brandMark}>
      <div style={{ maxWidth: 1320 }}>
        <div style={{ ...theme.type.eyebrow, color: L.accentText, marginBottom: 28 }}>By the numbers</div>
        <div
          style={{
            transform: `scale(${scale})`,
            transformOrigin: '0% 50%',
            opacity: pop,
            fontFamily: theme.fonts.display,
            fontWeight: 700,
            fontSize: 96,
            lineHeight: 0.92,
            letterSpacing: '-0.01em',
            color: L.ink,
            fontVariantNumeric: 'tabular-nums',
            fontFeatureSettings: '"tnum" 1, "kern" 0',
            whiteSpace: 'nowrap',
          }}
        >
          {stat}
        </div>
        <div style={{ marginTop: 26, height: 4, width: `${ruleW * 220}px`, borderRadius: 2, background: L.accentText }} />
        {label ? (
          <div
            style={{
              ...theme.type.bodyLg,
              marginTop: 26,
              color: L.sub,
              maxWidth: 820,
              opacity: labelIn,
              transform: `translateY(${(1 - labelIn) * 14}px)`,
            }}
          >
            {label}
          </div>
        ) : null}
      </div>
    </Stage>
  );
};
