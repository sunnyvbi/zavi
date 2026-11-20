import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from 'remotion';
import type { FeatureBeat } from '../brief';
import type { Theme } from '../theme';
import { Stage } from './Stage';
import { Glyph, glyphFor, type GlyphName } from '../glyphs';

export const Feature: React.FC<{ beat: FeatureBeat; theme: Theme; brandMark?: string }> = ({
  beat,
  theme,
  brandMark,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const L = theme.light;

  const card = spring({ frame: frame - 4, fps, config: { damping: 18 } });
  const x = interpolate(card, [0, 1], [-48 * theme.energy, 0]);
  const iconPop = spring({ frame: frame - 10, fps, config: { damping: 14, stiffness: 140 } });
  const lineIn = interpolate(frame, [20, 46], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.22, 1, 0.36, 1) });

  const glyph = (beat.glyph as GlyphName) ?? glyphFor(beat.headline);

  return (
    <Stage theme={theme} brandMark={brandMark}>
      <div style={{ transform: `translateX(${x}px)`, opacity: card, display: 'flex', alignItems: 'center', gap: 44, maxWidth: 1500 }}>
        <div
          style={{
            transform: `scale(${iconPop})`,
            flex: '0 0 auto',
            width: 132,
            height: 132,
            borderRadius: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: L.accentText,
            background: L.card,
            border: `1px solid ${L.hairline}`,
            boxShadow: theme.shadow.card,
          }}
        >
          <Glyph name={glyph} size={62} color={L.accentText} weight={2.2} />
        </div>
        <div style={{ flex: 1 }}>
          <h2
            style={{
              margin: 0,
              fontFamily: theme.fonts.headline,
              fontWeight: 600,
              fontSize: 66,
              lineHeight: 1.04,
              letterSpacing: '-0.005em',
              color: L.ink,
              maxWidth: '95%',
            }}
          >
            {beat.headline}
          </h2>
          {beat.sub ? (
            <p
              style={{
                ...theme.type.bodyLg,
                marginTop: 20,
                marginBottom: 0,
                color: L.sub,
                maxWidth: '88%',
                opacity: lineIn,
                transform: `translateY(${(1 - lineIn) * 12}px)`,
              }}
            >
              {beat.sub}
            </p>
          ) : null}
        </div>
      </div>
    </Stage>
  );
};
