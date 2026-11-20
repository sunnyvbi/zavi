import React from 'react';
import { useVideoConfig } from 'remotion';
import type { CoverageBeat } from '../brief';
import type { Theme } from '../theme';
import { rgba, mix } from '../theme';
import { Glyph } from '../glyphs';
import { ContentStage, useEntrance, useIdleFloat, useOrientation } from './kit';

const RegionTile: React.FC<{ label: string; theme: Theme; appear: number; accent: string }> = ({
  label,
  theme,
  appear,
  accent,
}) => {
  const L = theme.light;
  const e = useEntrance(appear, { rise: 22, scaleFrom: 0.92, motion: theme.motion });
  if (e.s < 0.001) return null;
  return (
    <div
      style={{
        opacity: e.opacity,
        transform: `translateY(${e.translateY}px) scale(${e.scale})`,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '20px 30px',
        background: L.card,
        borderRadius: 14,
        border: `1px solid ${L.hairline}`,
        boxShadow: theme.shadow.card,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: rgba(accent, 0.14),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: mix(accent, -0.12),
        }}
      >
        <Glyph name="pin" size={23} color={mix(accent, -0.12)} weight={2.2} />
      </div>
      <span style={{ ...theme.type.cardTitle, fontSize: 30, color: L.ink }}>{label}</span>
    </div>
  );
};

export const Coverage: React.FC<{ beat: CoverageBeat; theme: Theme; brandMark?: string }> = ({
  beat,
  theme,
  brandMark,
}) => {
  const L = theme.light;
  const regions = beat.regions ?? [];
  const panel = useEntrance(6, { rise: 28, scaleFrom: 0.98, motion: theme.motion });
  const count = useEntrance(10, { rise: 20, motion: theme.motion });
  const fl = useIdleFloat(6, { amp: 4, ampX: 2, period: 210, phase: 1.4, motion: theme.motion });
  const eyebrow =
    beat.eyebrow && beat.eyebrow.toLowerCase() !== (brandMark ?? '').toLowerCase()
      ? beat.eyebrow
      : undefined;

  const orient = useOrientation();
  const { width: frameW } = useVideoConfig();

  if (orient !== 'landscape') {
    const margin = theme.spacing.margin;
    const contentW = frameW - margin * 2;
    const cols = orient === 'square' ? 2 : 1;
    return (
      <ContentStage theme={theme} brandMark={brandMark} eyebrow={eyebrow} title={beat.headline} headAlign="right">
        <div
          style={{
            position: 'absolute',
            left: margin,
            right: margin,
            top: beat.headline || eyebrow ? 300 : 170,
            bottom: 70,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: contentW,
              opacity: panel.opacity,
              transform: `translateY(${panel.translateY + fl.y}px)`,
              background: L.card,
              borderRadius: 22,
              border: `1px solid ${L.hairline}`,
              boxShadow: theme.shadow.lift,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 40,
              padding: '56px 48px',
              backgroundImage: `radial-gradient(${rgba(L.ink, 0.05)} 1.4px, transparent 1.4px)`,
              backgroundSize: '32px 32px',
            }}
          >
            {}
            <div
              style={{
                opacity: count.opacity,
                transform: `translateY(${count.translateY}px)`,
                textAlign: 'center',
                paddingBottom: 36,
                borderBottom: `1px solid ${L.hairline}`,
                width: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
              }}
            >
              <div
                style={{
                  fontFamily: theme.fonts.display,
                  fontWeight: 700,
                  fontSize: 150,
                  lineHeight: 0.9,
                  letterSpacing: '-0.01em',
                  color: L.ink,
                  fontVariantNumeric: 'tabular-nums',
                  fontFeatureSettings: '"tnum" 1, "kern" 0',
                  whiteSpace: 'nowrap',
                }}
              >
                {regions.length}
              </div>
              <div style={{ marginTop: 16, height: 3, width: 76, borderRadius: 2, background: L.accentText }} />
              <div style={{ ...theme.type.bodyLg, color: L.sub, marginTop: 20 }}>live markets</div>
            </div>

            {}
            <div
              style={{
                display: 'flex',
                flexDirection: cols === 2 ? 'row' : 'column',
                flexWrap: cols === 2 ? 'wrap' : 'nowrap',
                gap: 20,
                alignItems: cols === 2 ? 'flex-start' : 'stretch',
                justifyContent: 'center',
                width: '100%',
              }}
            >
              {regions.map((r, i) => (
                <RegionTile
                  key={i}
                  label={r}
                  theme={theme}
                  appear={12 + i * 6}
                  accent={theme.cardAccents[i % theme.cardAccents.length]}
                />
              ))}
            </div>
          </div>
        </div>
      </ContentStage>
    );
  }

  return (
    <ContentStage theme={theme} brandMark={brandMark} eyebrow={eyebrow} title={beat.headline} headAlign="right">
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '55%',
          transform: `translate(calc(-50% + ${fl.x}px), -50%) translateY(${panel.translateY + fl.y}px)`,
          width: 1360,
          opacity: panel.opacity,
          background: L.card,
          borderRadius: 22,
          border: `1px solid ${L.hairline}`,
          boxShadow: theme.shadow.lift,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          gap: 56,
          padding: '64px 64px',
          backgroundImage: `radial-gradient(${rgba(L.ink, 0.05)} 1.4px, transparent 1.4px)`,
          backgroundSize: '32px 32px',
        }}
      >
        {}
        <div
          style={{
            flex: '0 0 auto',
            opacity: count.opacity,
            transform: `translateY(${count.translateY}px)`,
            paddingRight: 60,
            borderRight: `1px solid ${L.hairline}`,
          }}
        >
          <div
            style={{
              fontFamily: theme.fonts.display,
              fontWeight: 700,
              fontSize: 150,
              lineHeight: 0.9,
              letterSpacing: '-0.01em',
              color: L.ink,
              fontVariantNumeric: 'tabular-nums',
              fontFeatureSettings: '"tnum" 1, "kern" 0',
              whiteSpace: 'nowrap',
            }}
          >
            {regions.length}
          </div>
          <div style={{ marginTop: 16, height: 3, width: 76, borderRadius: 2, background: L.accentText }} />
          <div style={{ ...theme.type.bodyLg, color: L.sub, marginTop: 20, maxWidth: 240 }}>
            live markets
          </div>
        </div>

        {}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 20,
            alignContent: 'center',
            justifyContent: 'center',
            flex: 1,
          }}
        >
          {regions.map((r, i) => (
            <RegionTile
              key={i}
              label={r}
              theme={theme}
              appear={12 + i * 6}
              accent={theme.cardAccents[i % theme.cardAccents.length]}
            />
          ))}
        </div>
      </div>
    </ContentStage>
  );
};
