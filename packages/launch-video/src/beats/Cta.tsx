import React from 'react';
import { Img, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from 'remotion';
import type { CtaBeat } from '../brief';
import type { Theme } from '../theme';
import { Monogram, monogramOf } from '../glyphs';
import { DarkStage } from '../scenes/kit';

const EASE = Easing.bezier(0.22, 1, 0.36, 1);

export const Cta: React.FC<{
  beat: CtaBeat;
  theme: Theme;
  productName: string;
  ctaText: string;
  ctaUrl: string;
  logoUrl?: string;
}> = ({ beat, theme, productName, ctaText, ctaUrl, logoUrl }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const D = theme.dark;

  const rise = spring({ frame: frame - 4, fps, config: { damping: 18 } });
  const y = interpolate(rise, [0, 1], [40 * theme.energy, 0]);
  const ruleW = interpolate(frame, [16, 38], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE });
  const headIn = interpolate(frame, [20, 44], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE });
  const btnIn = spring({ frame: frame - 28, fps, config: { damping: 15 } });
  const urlIn = interpolate(frame, [40, 60], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE });
  const markIn = spring({ frame: frame - 8, fps, config: { damping: 18 } });

  return (
    <DarkStage theme={theme} brandMark={productName}>
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
        <div style={{ transform: `translateY(${y}px)`, opacity: rise, maxWidth: 1060 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 26 }}>
            {logoUrl ? (
              <Img src={logoUrl} style={{ height: 56, width: 'auto' }} />
            ) : (
              <Monogram label={monogramOf(productName)} size={56} bg={theme.accentGradient} radius={14} fontFamily={theme.fonts.display} />
            )}
            <span style={{ fontFamily: theme.fonts.display, fontWeight: 700, fontSize: 44, letterSpacing: '-0.02em', color: D.ink }}>
              {productName}
            </span>
          </div>

          <div style={{ height: 4, width: `${ruleW * 160}px`, borderRadius: 2, background: theme.brand.accent, marginBottom: 26 }} />

          <h2
            style={{
              ...theme.type.section,
              margin: 0,
              color: D.ink,
              maxWidth: 1000,
              opacity: headIn,
              transform: `translateY(${(1 - headIn) * 12}px)`,
            }}
          >
            {beat.headline ?? beat.sub ?? ''}
          </h2>

          {}
          {beat.chips && beat.chips.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 26 }}>
              {beat.chips.slice(0, 3).map((chip, i) => {
                const chipIn = interpolate(frame, [34 + i * 6, 52 + i * 6], [0, 1], {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                  easing: EASE,
                });
                return (
                  <span
                    key={i}
                    style={{
                      opacity: chipIn,
                      transform: `translateY(${(1 - chipIn) * 8}px)`,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 14px',
                      borderRadius: 8,
                      border: `1px solid ${D.hairline}`,
                      background: 'rgba(255,255,255,0.03)',
                      ...theme.type.meta,
                      fontWeight: 700,
                      color: D.sub,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 3, background: theme.brand.accent }} />
                    {chip}
                  </span>
                );
              })}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 22, marginTop: 36 }}>
            <div
              style={{
                transform: `scale(${interpolate(btnIn, [0, 1], [0.86, 1])})`,
                opacity: btnIn,
                padding: '20px 42px',
                borderRadius: 12,
                background: theme.accentGradient,
                fontFamily: theme.fonts.sans,
                fontWeight: 600,
                fontSize: 28,
                color: '#FFFFFF',
                boxShadow: theme.shadow.lift,
              }}
            >
              {ctaText}
            </div>

            <div
              style={{
                opacity: urlIn,
                transform: `translateX(${(1 - urlIn) * 14}px)`,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '16px 24px',
                borderRadius: 12,
                border: `1px solid ${D.hairline}`,
                ...theme.type.meta,
                fontSize: 18,
                textTransform: 'none',
                color: D.sub,
              }}
            >
              {ctaUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')}
              <span style={{ color: theme.brand.accent }}>↗</span>
            </div>
          </div>
        </div>

        {}
        <div
          style={{
            alignSelf: 'flex-end',
            opacity: markIn * 0.9,
            transform: `translateY(40px) scale(${interpolate(markIn, [0, 1], [0.9, 1])})`,
          }}
        >
          <Monogram label={monogramOf(productName)} size={216} bg={D.card} fg={theme.brand.accent} radius={32} fontFamily={theme.fonts.display} />
        </div>
      </div>
    </DarkStage>
  );
};
