import React from 'react';
import { useVideoConfig } from 'remotion';
import type { CardWallBeat, WallCard } from '../brief';
import type { Theme } from '../theme';
import { rgba } from '../theme';
import { ContentStage, useEntrance, useIdleFloat, useOrientation } from './kit';

type CardSize = 'lead' | 'std' | 'wall';

const DEPTH_OPACITY = [1, 0.9, 0.82, 0.78];
const DEPTH_SCALE = [1, 0.98, 0.965, 0.955];

const Card: React.FC<{
  card: WallCard;
  theme: Theme;
  appear: number;
  width: number;
  size: CardSize;
  rot: number;
  accent: string;
  depth: number;
  phase: number;
  minHeight?: number;
}> = ({ card, theme, appear, width, size, rot, accent, depth, phase, minHeight }) => {
  const L = theme.light;
  const e = useEntrance(appear, { rise: 26, scaleFrom: 0.965, motion: theme.motion });
  const fl = useIdleFloat(appear, { amp: 5 - depth, ampX: 1.5, period: 150 + depth * 16, phase, motion: theme.motion });
  if (e.s < 0.001) return null;

  const lead = size === 'lead';
  const titleStyle = lead
    ? { ...theme.type.cardTitle, fontSize: 40, lineHeight: 1.04 }
    : theme.type.cardTitle;
  const bodyStyle = lead ? theme.type.bodyLg : theme.type.body;
  const pad = lead ? '30px 38px 26px' : size === 'wall' ? '20px 24px 18px' : '24px 30px 22px';
  const depthO = DEPTH_OPACITY[Math.min(depth, DEPTH_OPACITY.length - 1)];
  const depthS = DEPTH_SCALE[Math.min(depth, DEPTH_SCALE.length - 1)];

  return (
    <div
      style={{
        width,
        minHeight,
        opacity: e.opacity * depthO,
        transform: `translate(${fl.x}px, ${e.translateY + fl.y}px) rotate(${rot * (1 - e.s)}deg) scale(${depthS})`,
        transformOrigin: '50% 0%',
        background: L.card,
        borderRadius: 12,
        boxShadow: depth === 0 ? theme.shadow.lift : theme.shadow.card,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {}
      <div style={{ height: lead ? 4 : 3, background: accent }} />
      {}
      <div style={{ padding: pad, display: 'flex', flexDirection: 'column', flex: 1, position: 'relative' }}>
        {}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: lead ? 16 : 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: accent }} />
            {card.label && (
              <span style={{ ...theme.type.meta, color: accent, fontWeight: 700 }}>{card.label}</span>
            )}
          </div>
          {card.pill && (
            <span
              style={{
                ...theme.type.meta,
                fontSize: 11,
                fontWeight: 700,
                color: accent,
                border: `1px solid ${rgba(accent, 0.32)}`,
                background: rgba(accent, 0.08),
                borderRadius: 6,
                padding: '4px 9px',
              }}
            >
              {card.pill}
            </span>
          )}
        </div>
        <div style={{ ...titleStyle, color: L.ink }}>{card.headline}</div>
        {card.body && (
          <div style={{ ...bodyStyle, color: L.sub, marginTop: lead ? 14 : 10 }}>{card.body}</div>
        )}
        {}
        <div style={{ flex: 1, minHeight: lead ? 20 : 14 }} />
        <div style={{ paddingTop: 12, borderTop: `1px solid ${L.hairline}` }}>
          {card.footer && (
            <span style={{ ...theme.type.meta, fontWeight: 500, color: L.faint }}>{card.footer}</span>
          )}
        </div>
      </div>
    </div>
  );
};

interface Placed {
  x: number;
  y: number;
  w: number;
  rot: number;
  size: CardSize;
  depth: number;
  minHeight?: number;
}

const RichLayout: React.FC<{ cards: WallCard[]; theme: Theme; bandW: number }> = ({
  cards,
  theme,
  bandW,
}) => {
  const accentOf = (c: WallCard, i: number) => c.accent || theme.cardAccents[i % theme.cardAccents.length];

  const layouts: Record<number, Placed[]> = {
    3: [
      { x: 0, y: 36, w: 560, rot: -1.5, size: 'lead', depth: 0, minHeight: 364 },
      { x: 700, y: 188, w: 470, rot: 1.5, size: 'std', depth: 1 },
      { x: 1210, y: 64, w: 470, rot: -1.0, size: 'std', depth: 1 },
    ],
    4: [
      { x: 0, y: 24, w: 540, rot: -1.5, size: 'lead', depth: 0, minHeight: 396 },
      { x: 640, y: 8, w: 470, rot: 1.2, size: 'std', depth: 1 },
      { x: 640, y: 252, w: 470, rot: -1.0, size: 'std', depth: 2 },
      { x: 1180, y: 150, w: 500, rot: 1.5, size: 'std', depth: 1 },
    ],
  };
  const placed = layouts[cards.length] ?? layouts[3];

  return (
    <div style={{ position: 'relative', width: bandW, height: 540 }}>
      {cards.map((c, i) => {
        const p = placed[i % placed.length];
        return (
          <div key={i} style={{ position: 'absolute', left: p.x, top: p.y, width: p.w }}>
            <Card
              card={c}
              theme={theme}
              appear={8 + i * 10}
              width={p.w}
              size={p.size}
              rot={p.rot}
              depth={p.depth}
              phase={i * 1.3}
              minHeight={p.minHeight}
              accent={accentOf(c, i)}
            />
          </div>
        );
      })}
    </div>
  );
};

const WallLayout: React.FC<{ cards: WallCard[]; theme: Theme; bandW: number }> = ({
  cards,
  theme,
  bandW,
}) => {
  const widths = [364, 388, 332, 372, 344, 380, 356, 392, 336, 368];
  const rots = [-2.4, 1.6, -1.2, 2.2, -1.8, 1.0, -2.0, 1.4, -1.0, 2.0];
  const dys = [0, 34, 12, 40, 6, 28, 18, 44, 8, 30];
  const accentOf = (c: WallCard, i: number) => c.accent || theme.cardAccents[i % theme.cardAccents.length];

  return (
    <div
      style={{
        width: bandW,
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'flex-start',
        columnGap: 26,
        rowGap: 26,
      }}
    >
      {cards.map((c, i) => (
        <div key={i} style={{ marginTop: dys[i % dys.length] }}>
          <Card
            card={c}
            theme={theme}
            appear={8 + i * 7}
            width={widths[i % widths.length]}
            size="wall"
            rot={rots[i % rots.length]}
            depth={i % 3}
            phase={i * 0.9}
            accent={accentOf(c, i)}
          />
        </div>
      ))}
    </div>
  );
};

export const CardWall: React.FC<{ beat: CardWallBeat; theme: Theme; brandMark?: string }> = ({
  beat,
  theme,
  brandMark,
}) => {
  const cards = beat.cards ?? [];
  const bandW = theme.spacing.maxWidth;
  const rich = cards.length <= 4;
  const hasHead = !!(beat.headline || beat.eyebrow);
  const orient = useOrientation();
  const { width: frameW } = useVideoConfig();

  if (orient !== 'landscape') {
    const margin = theme.spacing.margin;
    const contentW = frameW - margin * 2;
    const cols = orient === 'square' ? 2 : 1;
    const gap = 24;
    const cardW = cols === 2 ? Math.floor((contentW - gap) / 2) : contentW;
    const accentOf = (c: WallCard, i: number) => c.accent || theme.cardAccents[i % theme.cardAccents.length];
    return (
      <ContentStage theme={theme} brandMark={brandMark} eyebrow={beat.eyebrow} title={beat.headline}>
        <div
          style={{
            position: 'absolute',
            left: margin,
            right: margin,
            top: hasHead ? 300 : 170,
            bottom: 70,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: cols === 2 ? 'row' : 'column',
              flexWrap: cols === 2 ? 'wrap' : 'nowrap',
              justifyContent: 'center',
              alignItems: cols === 2 ? 'flex-start' : 'stretch',
              gap,
              width: contentW,
            }}
          >
            {cards.map((c, i) => (
              <Card
                key={i}
                card={c}
                theme={theme}
                appear={8 + i * 8}
                width={cardW}
                size="std"
                rot={0}
                depth={0}
                phase={i * 1.1}
                accent={accentOf(c, i)}
              />
            ))}
          </div>
        </div>
      </ContentStage>
    );
  }

  return (
    <ContentStage theme={theme} brandMark={brandMark} eyebrow={beat.eyebrow} title={beat.headline}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          width: bandW,
          top: hasHead ? 296 : 188,
        }}
      >
        {rich ? (
          <RichLayout cards={cards} theme={theme} bandW={bandW} />
        ) : (
          <WallLayout cards={cards} theme={theme} bandW={bandW} />
        )}
      </div>
    </ContentStage>
  );
};
