import React from 'react';
import { Img, staticFile, useVideoConfig } from 'remotion';
import type { ProductUIBeat, ProductUIItem } from '../brief';
import type { Theme } from '../theme';
import { rgba, mix } from '../theme';
import { Glyph, Monogram, monogramOf, asGlyph } from '../glyphs';
import { ContentStage, useEntrance, useIdleFloat, useKenBurns, useOrientation } from './kit';

const TrafficDots: React.FC = () => (
  <div style={{ display: 'flex', gap: 9 }}>
    {['#EC6A5E', '#F4BF50', '#61C454'].map((c) => (
      <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c, opacity: 0.9 }} />
    ))}
  </div>
);

const ItemCard: React.FC<{
  item: ProductUIItem;
  theme: Theme;
  appear: number;
  accent: string;
  index: number;
  basis?: string;
}> = ({ item, theme, appear, accent, index, basis }) => {
  const L = theme.light;
  const e = useEntrance(appear, { rise: 26, scaleFrom: 0.965, motion: theme.motion });
  const kb = useKenBurns({ zoom: 0.07, panXPx: index % 2 === 0 ? 10 : -10, panYPx: -6 });
  if (e.s < 0.001) return null;
  const glyph = asGlyph(item.glyph, item.title, index);

  return (
    <div
      style={{
        ...(basis ? { flexGrow: 0, flexShrink: 0, flexBasis: basis } : { flex: 1 }),
        minWidth: 0,
        opacity: e.opacity,
        transform: `translateY(${e.translateY}px) scale(${e.scale})`,
        background: L.card,
        borderRadius: 16,
        border: `1px solid ${L.hairline}`,
        boxShadow: theme.shadow.card,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {}
      <div
        style={{
          height: 164,
          position: 'relative',
          background: `linear-gradient(150deg, ${rgba(accent, 0.18)} 0%, ${rgba(accent, 0.05)} 100%)`,
          borderBottom: `1px solid ${L.hairline}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {item.image ? (
          <Img
            src={staticFile(item.image)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: kb.transform }}
          />
        ) : (
          <Glyph name={glyph} size={76} color={rgba(mix(accent, -0.1), 0.92)} weight={1.9} />
        )}
        {}
        <div
          style={{
            position: 'absolute',
            top: 14,
            right: 14,
            width: 30,
            height: 30,
            borderRadius: 9,
            background: L.card,
            border: `1px solid ${L.hairline}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: L.sub,
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          ›
        </div>
      </div>

      {}
      <div style={{ padding: '18px 20px 20px', display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <Monogram label={monogramOf(item.title)} size={30} bg={mix(accent, -0.1)} radius={8} fontFamily={theme.fonts.sans} />
          <div
            style={{
              ...theme.type.cardTitle,
              fontSize: 24,
              color: L.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.title}
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {item.chips.slice(0, 3).map((chip, i) => {
            const lead = i === 0;
            return (
              <span
                key={i}
                style={{
                  ...theme.type.meta,
                  fontSize: 14,
                  textTransform: 'none',
                  letterSpacing: '0.01em',
                  fontFamily: theme.fonts.sans,
                  fontWeight: lead ? 600 : 500,
                  color: lead ? mix(accent, -0.18) : L.sub,
                  background: lead ? rgba(accent, 0.12) : L.cardSoft,
                  border: `1px solid ${lead ? rgba(accent, 0.22) : L.hairline}`,
                  borderRadius: 8,
                  padding: '6px 12px',
                  whiteSpace: 'nowrap',
                }}
              >
                {chip}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const ProductUI: React.FC<{ beat: ProductUIBeat; theme: Theme; brandMark?: string }> = ({
  beat,
  theme,
  brandMark,
}) => {
  const L = theme.light;
  const items = (beat.items ?? []).slice(0, 4);
  const frame = useEntrance(6, { rise: 30, scaleFrom: 0.985, motion: theme.motion });
  const fl = useIdleFloat(6, { amp: 4, ampX: 2, period: 200, phase: 0.5, motion: theme.motion });
  const headerTitle = beat.header?.title ?? 'Results';
  const placeholder = beat.header?.searchPlaceholder ?? headerTitle;
  const domain = beat.domain ?? '';
  const orient = useOrientation();
  const { width: vpW } = useVideoConfig();
  const landscape = orient === 'landscape';
  const frameW = landscape ? 1500 : vpW - theme.spacing.margin * 2;
  const gridDirection: 'row' | 'column' = landscape || orient === 'square' ? 'row' : 'column';
  const gridWrap: 'nowrap' | 'wrap' = landscape ? 'nowrap' : 'wrap';
  const gridItemBasis = orient === 'square' ? 'calc(50% - 11px)' : undefined;
  const eyebrow =
    beat.eyebrow && beat.eyebrow.toLowerCase() !== (brandMark ?? '').toLowerCase()
      ? beat.eyebrow
      : undefined;

  return (
    <ContentStage theme={theme} brandMark={brandMark} eyebrow={eyebrow} title={beat.headline} headAlign="right">
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: beat.headline || beat.eyebrow ? 318 : 200,
          transform: `translateX(calc(-50% + ${fl.x}px)) translateY(${frame.translateY + fl.y}px)`,
          width: frameW,
          opacity: frame.opacity,
          background: L.card,
          borderRadius: 20,
          border: `1px solid ${L.hairline}`,
          boxShadow: theme.shadow.lift,
          overflow: 'hidden',
        }}
      >
        {}
        <div
          style={{
            height: 56,
            background: L.paper,
            borderBottom: `1px solid ${L.hairline}`,
            display: 'flex',
            alignItems: 'center',
            padding: '0 22px',
            gap: 20,
          }}
        >
          <TrafficDots />
          {domain ? (
            <div
              style={{
                flex: 1,
                maxWidth: 520,
                margin: '0 auto',
                height: 32,
                borderRadius: 8,
                background: L.card,
                border: `1px solid ${L.hairline}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                ...theme.type.meta,
                fontSize: 13,
                textTransform: 'none',
                color: L.faint,
              }}
            >
              {domain}
            </div>
          ) : (
            <div style={{ flex: 1 }} />
          )}
          <div style={{ width: 54 }} />
        </div>

        {}
        <div
          style={{
            padding: '26px 32px 8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 24,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flex: 1,
              maxWidth: 560,
              height: 50,
              padding: '0 18px',
              borderRadius: 12,
              background: L.cardSoft,
              border: `1px solid ${L.hairline}`,
              color: L.faint,
            }}
          >
            <Glyph name="search" size={20} color={L.faint} weight={2.2} />
            <span style={{ ...theme.type.body, fontSize: 19, color: L.sub }}>{placeholder}</span>
          </div>
          <div style={{ ...theme.type.meta, color: L.faint }}>{items.length} results</div>
        </div>

        {}
        <div style={{ padding: '6px 32px 0' }}>
          <div style={{ ...theme.type.cardTitle, fontSize: 22, color: L.ink }}>{headerTitle}</div>
        </div>

        {}
        <div
          style={{
            display: 'flex',
            flexDirection: gridDirection,
            flexWrap: gridWrap,
            gap: 22,
            padding: '20px 32px 34px',
            alignItems: 'stretch',
          }}
        >
          {items.map((item, i) => (
            <ItemCard
              key={i}
              item={item}
              theme={theme}
              appear={16 + i * 7}
              accent={theme.cardAccents[i % theme.cardAccents.length]}
              index={i}
              basis={gridItemBasis}
            />
          ))}
        </div>
      </div>
    </ContentStage>
  );
};
