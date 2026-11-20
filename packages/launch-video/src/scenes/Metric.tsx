import React from 'react';
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import type { MetricBeat, MetricItem } from '../brief';
import type { Theme } from '../theme';
import { rgba } from '../theme';
import { Glyph, glyphFor } from '../glyphs';
import { ContentStage, useEntrance, useIdleFloat, useOrientation } from './kit';

function parseStat(stat: string): { prefix: string; value: number; decimals: number; suffix: string } {
  const m = /^(\D*)([\d,.]+)(.*)$/.exec(stat.trim());
  if (!m) return { prefix: '', value: NaN, decimals: 0, suffix: stat };
  const numStr = m[2].replace(/,/g, '');
  const dot = numStr.indexOf('.');
  const decimals = dot >= 0 ? numStr.length - dot - 1 : 0;
  return { prefix: m[1] ?? '', value: parseFloat(numStr), decimals, suffix: m[3] ?? '' };
}

function fmt(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  const [int, frac] = fixed.split('.');
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${withCommas}.${frac}` : withCommas;
}

const Sparkline: React.FC<{ series: number[]; color: string; reveal: number; w?: number; h?: number }> = ({
  series,
  color,
  reveal,
  w = 360,
  h = 96,
}) => {
  if (series.length < 2) return null;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const padY = 10;
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * w;
    const y = padY + (1 - (v - min) / span) * (h - padY * 2);
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `0,${h} ${line} ${w},${h}`;
  const clipId = `spark-${Math.round(reveal * 1e6)}-${series.length}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`${clipId}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={rgba(color, 0.18)} />
          <stop offset="100%" stopColor={rgba(color, 0)} />
        </linearGradient>
        <clipPath id={clipId}>
          <rect x="0" y="0" width={w * reveal} height={h} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <polygon points={area} fill={`url(#${clipId}-fill)`} />
        <polyline points={line} fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {reveal > 0.02 && (
        <circle
          cx={pts[Math.min(pts.length - 1, Math.floor(reveal * (pts.length - 1)))][0]}
          cy={pts[Math.min(pts.length - 1, Math.floor(reveal * (pts.length - 1)))][1]}
          r={4}
          fill={color}
        />
      )}
    </svg>
  );
};

function useCountUp(item: MetricItem, appear: number) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const parsed = parseStat(item.stat);
  const countS = spring({ frame: frame - (appear + 4), fps, config: { damping: 26, stiffness: 80 } });
  const shown = Number.isNaN(parsed.value)
    ? item.stat
    : `${parsed.prefix}${fmt(parsed.value * countS, parsed.decimals)}${parsed.suffix}`;
  const reveal = interpolate(frame, [appear + 8, appear + 40], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return { shown, reveal };
}

const HeroMetric: React.FC<{ item: MetricItem; theme: Theme; appear: number; glyphHint?: string }> = ({
  item,
  theme,
  appear,
  glyphHint,
}) => {
  const L = theme.light;
  const e = useEntrance(appear, { rise: 24, scaleFrom: 0.98, motion: theme.motion });
  const wm = useEntrance(appear + 6, { rise: 30, scaleFrom: 0.92, motion: theme.motion });
  const { shown, reveal } = useCountUp(item, appear);
  const hasSeries = !!(item.series && item.series.length >= 2);
  if (e.s < 0.001) return null;

  const StatBig = (
    <div
      style={{
        fontFamily: theme.fonts.display,
        fontWeight: 700,
        fontSize: 96,
        lineHeight: 0.95,
        letterSpacing: '-0.01em',
        color: L.ink,
        fontVariantNumeric: 'tabular-nums',
        fontFeatureSettings: '"tnum" 1, "kern" 0',
        whiteSpace: 'nowrap',
      }}
    >
      {shown}
    </div>
  );

  if (hasSeries) {
    return (
      <div
        style={{
          width: Math.min(theme.spacing.maxWidth, 1240),
          opacity: e.opacity,
          transform: `translateY(${e.translateY}px)`,
          background: L.card,
          borderRadius: 14,
          boxShadow: theme.shadow.lift,
          display: 'flex',
          alignItems: 'stretch',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: 4, background: L.accentText }} />
        <div style={{ display: 'flex', alignItems: 'stretch', flex: 1, padding: '52px 60px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingRight: 56 }}>
            {StatBig}
            <div style={{ marginTop: 18, height: 3, width: 72, borderRadius: 2, background: L.accentText }} />
          </div>
          <div style={{ width: 1, background: L.hairline }} />
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: 56, flex: 1 }}>
            <div style={{ ...theme.type.bodyLg, color: L.sub, maxWidth: 540 }}>{item.label}</div>
            <div style={{ marginTop: 26 }}>
              <Sparkline series={item.series!} color={L.accentText} reveal={reveal} w={560} h={96} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'relative',
        width: theme.spacing.maxWidth,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <div
        style={{
          width: 620,
          opacity: e.opacity,
          transform: `translateY(${e.translateY}px)`,
          background: L.card,
          borderRadius: 16,
          boxShadow: theme.shadow.lift,
          overflow: 'hidden',
        }}
      >
        <div style={{ height: 4, background: L.accentText }} />
        <div style={{ padding: '50px 56px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            {StatBig}
            {item.delta && <DeltaChip delta={item.delta} theme={theme} reveal={reveal} />}
          </div>
          <div style={{ marginTop: 22, height: 3, width: 84, borderRadius: 2, background: L.accentText }} />
          <div style={{ marginTop: 24 }}>
            <BaselineBars theme={theme} accent={L.accentText} reveal={reveal} w={460} />
          </div>
          <div style={{ ...theme.type.bodyLg, color: L.sub, marginTop: 24, maxWidth: 480 }}>{item.label}</div>
        </div>
      </div>
      <div style={{ opacity: wm.opacity * 0.9, transform: `scale(${wm.scale})`, marginRight: 60 }}>
        <Glyph name={glyphFor(item.label || glyphHint)} size={320} color={rgba(L.accentText, 0.12)} weight={2} />
      </div>
    </div>
  );
};

const DeltaChip: React.FC<{ delta: NonNullable<MetricItem['delta']>; theme: Theme; reveal: number }> = ({
  delta,
  theme,
  reveal,
}) => {
  const L = theme.light;
  const tone = delta.dir === 'up' ? L.good : delta.dir === 'down' ? '#D1495B' : L.faint;
  const arrow = delta.dir === 'up' ? '▲' : delta.dir === 'down' ? '▼' : '■';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        opacity: reveal,
        ...theme.type.meta,
        fontSize: 13,
        fontWeight: 700,
        color: tone,
        background: rgba(tone, 0.1),
        border: `1px solid ${rgba(tone, 0.24)}`,
        borderRadius: 7,
        padding: '4px 9px',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: 10 }}>{arrow}</span>
      {delta.text}
    </span>
  );
};

const ARCH = [0.42, 0.58, 0.72, 0.84, 0.94, 1, 0.94, 0.84, 0.72, 0.58, 0.42];
const BaselineBars: React.FC<{ theme: Theme; accent: string; reveal: number; w?: number }> = ({
  theme,
  accent,
  reveal,
  w = 360,
}) => {
  const L = theme.light;
  const n = ARCH.length;
  const gap = 7;
  const bw = (w - gap * (n - 1)) / n;
  const maxH = 26;
  return (
    <svg width={w} height={42} viewBox={`0 0 ${w} 42`} style={{ display: 'block' }}>
      {ARCH.map((hf, i) => {
        const grow = interpolate(reveal, [i * 0.03, i * 0.03 + 0.25], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const h = maxH * hf * grow;
        return <rect key={i} x={i * (bw + gap)} y={34 - h} width={bw} height={h} rx={2.5} fill={rgba(accent, 0.2)} />;
      })}
      <line x1={0} y1={36} x2={w} y2={36} stroke={L.hairline} strokeWidth={1.5} />
    </svg>
  );
};

const MetricCard: React.FC<{
  item: MetricItem;
  theme: Theme;
  appear: number;
  accent: string;
  index: number;
  phase: number;
  width?: number | string;
}> = ({ item, theme, appear, accent, index, phase, width = 432 }) => {
  const L = theme.light;
  const e = useEntrance(appear, { rise: 30, scaleFrom: 0.96, motion: theme.motion });
  const fl = useIdleFloat(appear, { amp: 4, ampX: 1.2, period: 168 + index * 16, phase, motion: theme.motion });
  const { shown, reveal } = useCountUp(item, appear);
  const hasSeries = !!(item.series && item.series.length >= 2);
  if (e.s < 0.001) return null;
  const kicker = String(index + 1).padStart(2, '0');
  const vizW = 372;

  return (
    <div
      style={{
        width,
        opacity: e.opacity,
        transform: `translate(${fl.x}px, ${e.translateY + fl.y}px) scale(${e.scale})`,
        background: L.card,
        borderRadius: 16,
        border: `1px solid ${L.hairline}`,
        boxShadow: theme.shadow.lift,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ height: 4, background: accent }} />
      <div style={{ padding: '30px 40px 30px', display: 'flex', flexDirection: 'column' }}>
        {}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: accent }} />
            <span style={{ ...theme.type.meta, color: accent, fontWeight: 700 }}>{kicker}</span>
          </div>
          {item.delta && <DeltaChip delta={item.delta} theme={theme} reveal={reveal} />}
        </div>
        <div
          style={{
            fontFamily: theme.fonts.display,
            fontWeight: 700,
            fontSize: 76,
            lineHeight: 0.95,
            letterSpacing: '-0.01em',
            color: L.ink,
            fontVariantNumeric: 'tabular-nums',
            fontFeatureSettings: '"tnum" 1, "kern" 0',
            whiteSpace: 'nowrap',
          }}
        >
          {shown}
        </div>
        <div style={{ marginTop: 16, height: 3, width: 60, borderRadius: 2, background: accent }} />
        {}
        <div style={{ marginTop: 18 }}>
          {hasSeries ? (
            <Sparkline series={item.series!} color={accent} reveal={reveal} w={vizW} h={56} />
          ) : (
            <BaselineBars theme={theme} accent={accent} reveal={reveal} w={vizW} />
          )}
        </div>
        <div style={{ ...theme.type.body, fontSize: 19, color: L.sub, marginTop: 16, minHeight: 50 }}>{item.label}</div>
      </div>
    </div>
  );
};

export const Metric: React.FC<{ beat: MetricBeat; theme: Theme; brandMark?: string }> = ({
  beat,
  theme,
  brandMark,
}) => {
  const items: MetricItem[] =
    beat.metrics && beat.metrics.length > 0
      ? beat.metrics
      : beat.stat
        ? [{ stat: beat.stat, label: beat.label ?? '', series: beat.series }]
        : [];
  const single = items.length === 1;
  const orient = useOrientation();
  const { width: frameW } = useVideoConfig();

  if (orient !== 'landscape' && items.length > 0) {
    const margin = theme.spacing.margin;
    const contentW = frameW - margin * 2;
    const cols = orient === 'square' && items.length > 1 ? 2 : 1;
    const gap = 28;
    const cardW = cols === 2 ? Math.floor((contentW - gap) / 2) : contentW;
    return (
      <ContentStage theme={theme} brandMark={brandMark} eyebrow={beat.eyebrow} title={beat.headline}>
        <div
          style={{
            position: 'absolute',
            left: margin,
            right: margin,
            top: beat.headline || beat.eyebrow ? 300 : 170,
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
            {items.map((m, i) => (
              <MetricCard
                key={i}
                item={m}
                theme={theme}
                appear={10 + i * 9}
                index={i}
                phase={i * 1.2}
                width={cardW}
                accent={theme.cardAccents[i % theme.cardAccents.length]}
              />
            ))}
          </div>
        </div>
      </ContentStage>
    );
  }

  return (
    <ContentStage theme={theme} brandMark={brandMark} eyebrow={beat.eyebrow} title={beat.headline}>
      {single ? (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            top: '52%',
            width: theme.spacing.maxWidth,
            display: 'flex',
            justifyContent: 'flex-start',
          }}
        >
          <HeroMetric item={items[0]} theme={theme} appear={10} glyphHint={brandMark} />
        </div>
      ) : (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            top: 388,
            width: theme.spacing.maxWidth,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
            gap: 32,
          }}
        >
          {items.map((m, i) => (
            <MetricCard
              key={i}
              item={m}
              theme={theme}
              appear={10 + i * 9}
              index={i}
              phase={i * 1.2}
              accent={theme.cardAccents[i % theme.cardAccents.length]}
            />
          ))}
        </div>
      )}
    </ContentStage>
  );
};
