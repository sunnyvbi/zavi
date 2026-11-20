import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from 'remotion';
import type { Theme, TypeStyle, MotionProfile } from '../theme';
import { rgba } from '../theme';
import { orientationFor, type Orientation } from '../orientation';

export type { Orientation };

export const SOFT_EASE = Easing.bezier(0.22, 1, 0.36, 1);
export const SNAP_EASE = Easing.bezier(0.86, 0, 0.12, 1);

export function useOrientation(): Orientation {
  const { width, height } = useVideoConfig();
  return orientationFor(width, height);
}

export function useEntrance(
  appear: number,
  opts: {
    rise?: number;
    scaleFrom?: number;
    damping?: number;
    stiffness?: number;
    motion?: MotionProfile;
  } = {},
) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { rise = 20, scaleFrom = 0.985, damping = 200, stiffness = 90, motion } = opts;

  if (motion?.snap) {
    const s = interpolate(frame - appear, [0, Math.max(1, motion.snapFrames)], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: SNAP_EASE,
    });
    return {
      s,
      opacity: s,
      translateY: interpolate(s, [0, 1], [rise * motion.riseScale, 0]),
      scale: interpolate(s, [0, 1], [scaleFrom, 1]),
    };
  }

  const s = spring({
    frame: frame - appear,
    fps,
    config: {
      damping: motion?.damping ?? damping,
      mass: 0.9,
      stiffness: motion?.stiffness ?? stiffness,
    },
  });
  return {
    s,
    opacity: s,
    translateY: interpolate(s, [0, 1], [rise * (motion?.riseScale ?? 1), 0]),
    scale: interpolate(s, [0, 1], [scaleFrom, 1]),
  };
}

export function useIdleFloat(
  appear: number,
  opts: { amp?: number; ampX?: number; period?: number; phase?: number; motion?: MotionProfile } = {},
) {
  const frame = useCurrentFrame();
  const { amp = 5, ampX = 0, period = 150, phase = 0, motion } = opts;
  const live = motion?.idle !== false;
  const ramp = interpolate(frame - (appear + 14), [0, 18], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const w = (2 * Math.PI) / period;
  const tx = frame * w;
  if (!live) return { x: 0, y: 0 };
  return {
    x: Math.cos(tx * 0.8 + phase) * ampX * ramp,
    y: Math.sin(tx + phase) * amp * ramp,
  };
}

export function useKenBurns(opts: { zoom?: number; panXPx?: number; panYPx?: number } = {}) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const { zoom = 0.08, panXPx = 0, panYPx = 0 } = opts;
  const p = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.quad),
  });
  const scale = 1 + zoom * p;
  const x = panXPx * p;
  const y = panYPx * p;
  return { scale, x, y, transform: `translate(${x}px, ${y}px) scale(${scale})` };
}

export function useBeatExit(opts: { frames?: number } = {}) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const { frames = 8 } = opts;
  const start = Math.max(0, durationInFrames - frames);
  const opacity = interpolate(frame, [start, durationInFrames - 1], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: SOFT_EASE,
  });
  const scale = interpolate(frame, [start, durationInFrames - 1], [1, 0.99], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: SOFT_EASE,
  });
  return { opacity, scale, transform: `scale(${scale})` };
}

export const t = (style: TypeStyle): React.CSSProperties => ({ ...style });

function accentWordIndex(words: string[]): number {
  for (let i = words.length - 1; i >= 0; i--) {
    const alpha = words[i].replace(/[^A-Za-z0-9]/g, '');
    if (alpha.length >= 4) return i;
  }
  return Math.max(0, words.length - 1);
}

export const AccentTitle: React.FC<{ text: string; theme: Theme; style: React.CSSProperties }> = ({
  text,
  theme,
  style,
}) => {
  const words = text.split(' ');
  const hi = accentWordIndex(words);
  return (
    <div style={style}>
      {words.map((w, i) => (
        <span key={i} style={{ color: i === hi ? theme.light.accentText : 'inherit' }}>
          {w}
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </div>
  );
};

const BrandMark: React.FC<{ theme: Theme; label: string; onDark?: boolean }> = ({
  theme,
  label,
  onDark,
}) => (
  <div
    style={{
      position: 'absolute',
      top: 58,
      right: theme.spacing.margin,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
    }}
  >
    <div style={{ width: 9, height: 9, borderRadius: 2, background: theme.brand.accent }} />
    <span
      style={{
        ...theme.type.meta,
        fontWeight: 700,
        color: onDark ? theme.dark.sub : theme.light.faint,
      }}
    >
      {label}
    </span>
  </div>
);

const Atmosphere: React.FC<{ theme: Theme }> = ({ theme }) => {
  const frame = useCurrentFrame();
  const L = theme.light;
  const p = (frame / 720) * 2 * Math.PI;
  const dx = Math.sin(p) * 34;
  const dy = Math.cos(p * 0.85) * 26;
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          inset: '-12%',
          transform: `translate(${dx}px, ${dy}px)`,
          background: `radial-gradient(48% 52% at 14% 10%, ${rgba(L.warm, 0.55)} 0%, transparent 60%),
            radial-gradient(52% 56% at 88% 92%, ${rgba(L.cool, 0.6)} 0%, transparent 62%)`,
        }}
      />
    </AbsoluteFill>
  );
};

export const LightStage: React.FC<{
  theme: Theme;
  brandMark?: string;
  eyebrow?: string;
  title?: string;
  headAppear?: number;
  headTop?: number;
  headAlign?: 'left' | 'right';
  children: React.ReactNode;
}> = ({ theme, brandMark, eyebrow, title, headAppear = 2, headTop = 88, headAlign = 'left', children }) => {
  const frame = useCurrentFrame();
  const L = theme.light;

  const fade = interpolate(frame, [0, 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: SOFT_EASE,
  });
  const head = useEntrance(headAppear, { rise: 14, motion: theme.motion });
  const right = headAlign === 'right';

  return (
    <AbsoluteFill style={{ background: L.wash, fontFamily: theme.fonts.body }}>
      <Atmosphere theme={theme} />
      <AbsoluteFill style={{ opacity: fade }}>
        {(eyebrow || title) && (
          <div
            style={{
              position: 'absolute',
              top: headTop,
              left: theme.spacing.margin,
              right: theme.spacing.margin,
              textAlign: right ? 'right' : 'left',
              opacity: head.opacity,
              transform: `translateY(${head.translateY}px)`,
            }}
          >
            {eyebrow && (
              <div style={{ ...theme.type.eyebrow, color: L.accentText }}>{eyebrow}</div>
            )}
            {title && (
              <AccentTitle
                text={title}
                theme={theme}
                style={{
                  ...theme.type.section,
                  marginTop: eyebrow ? 16 : 0,
                  color: L.ink,
                  maxWidth: 1180,
                  marginLeft: right ? 'auto' : 0,
                }}
              />
            )}
          </div>
        )}

        {children}

        {brandMark && <BrandMark theme={theme} label={brandMark} />}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const GridStage: React.FC<{
  theme: Theme;
  brandMark?: string;
  eyebrow?: string;
  title?: string;
  headAppear?: number;
  headTop?: number;
  headAlign?: 'left' | 'right';
  children: React.ReactNode;
}> = ({ theme, brandMark, eyebrow, title, headAppear = 2, headTop = 88, headAlign = 'left', children }) => {
  const frame = useCurrentFrame();
  const L = theme.light;
  const fade = interpolate(frame, [0, 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: SNAP_EASE,
  });
  const head = useEntrance(headAppear, { rise: 14, motion: theme.motion });
  const right = headAlign === 'right';
  const cols = 12;
  const m = theme.spacing.margin;
  const { width: gw, height: gh } = useVideoConfig();

  return (
    <AbsoluteFill style={{ background: L.paper, fontFamily: theme.fonts.body }}>
      {}
      <AbsoluteFill style={{ opacity: fade * 0.5 }}>
        <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
          {Array.from({ length: cols + 1 }, (_, i) => {
            const x = m + ((gw - m * 2) / cols) * i;
            return <line key={`v${i}`} x1={x} x2={x} y1={0} y2={gh} stroke={L.hairline} strokeWidth={1} />;
          })}
          {[headTop, gh - 120].map((y, i) => (
            <line key={`h${i}`} x1={0} x2={gw} y1={y} y2={y} stroke={L.hairline} strokeWidth={1} />
          ))}
        </svg>
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: fade }}>
        <div
          style={{
            position: 'absolute',
            top: headTop,
            left: right ? undefined : m,
            right: right ? m : undefined,
            textAlign: right ? 'right' : 'left',
            opacity: head.opacity,
            transform: `translateY(${head.translateY}px)`,
          }}
        >
          {eyebrow ? <div style={{ ...t(theme.type.eyebrow), color: L.sub }}>{eyebrow}</div> : null}
          {title ? <div style={{ ...t(theme.type.section), color: L.ink, marginTop: 10 }}>{title}</div> : null}
        </div>
        {children}
        {}
        {brandMark && <BrandMark theme={theme} label={brandMark} />}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const ContentStage: React.FC<{
  theme: Theme;
  brandMark?: string;
  eyebrow?: string;
  title?: string;
  headAppear?: number;
  headTop?: number;
  headAlign?: 'left' | 'right';
  children: React.ReactNode;
}> = (props) => {
  if (props.theme.stage === 'grid') return <GridStage {...props} />;
  if (props.theme.stage === 'dark') return <DarkStage {...props} />;
  return <LightStage {...props} />;
};

export const DarkStage: React.FC<{
  theme: Theme;
  brandMark?: string;
  eyebrow?: string;
  title?: string;
  headAppear?: number;
  headTop?: number;
  headAlign?: 'left' | 'right';
  children: React.ReactNode;
}> = ({ theme, brandMark, eyebrow, title, headAppear = 2, headTop = 88, headAlign = 'left', children }) => {
  const frame = useCurrentFrame();
  const D = theme.dark;
  const darkHead = useEntrance(headAppear, { rise: 14, motion: theme.motion });
  const fade = interpolate(frame, [0, 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: SOFT_EASE,
  });
  const p = (frame / 600) * 2 * Math.PI;
  const dx = Math.sin(p) * 20;
  const dy = Math.cos(p) * 16;
  return (
    <AbsoluteFill style={{ background: D.bg, fontFamily: theme.fonts.body }}>
      <div
        style={{
          position: 'absolute',
          inset: '-10%',
          transform: `translate(${dx}px, ${dy}px)`,
          background: `radial-gradient(46% 50% at 16% 14%, ${D.warmGlow} 0%, transparent 58%),
            radial-gradient(54% 58% at 86% 90%, ${D.coolGlow} 0%, transparent 60%)`,
        }}
      />
      <AbsoluteFill style={{ opacity: fade }}>
        {}
        {(eyebrow || title) && (
          <div
            style={{
              position: 'absolute',
              top: headTop,
              left: headAlign === 'right' ? undefined : theme.spacing.margin,
              right: headAlign === 'right' ? theme.spacing.margin : undefined,
              textAlign: headAlign === 'right' ? 'right' : 'left',
              opacity: darkHead.opacity,
              transform: `translateY(${darkHead.translateY}px)`,
            }}
          >
            {eyebrow ? <div style={{ ...t(theme.type.eyebrow), color: D.sub }}>{eyebrow}</div> : null}
            {title ? <div style={{ ...t(theme.type.section), color: D.ink, marginTop: 10 }}>{title}</div> : null}
          </div>
        )}
        {children}
        {brandMark && <BrandMark theme={theme} label={brandMark} onDark />}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
