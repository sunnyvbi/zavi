import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from 'remotion';
import type { Theme } from '../theme';
import { readableSurface } from '../theme';

export const Stage: React.FC<{
  theme: Theme;
  brandMark?: string;
  children: React.ReactNode;
}> = ({ theme, brandMark, children }) => {
  const frame = useCurrentFrame();
  const L = readableSurface(theme);

  const fade = interpolate(frame, [0, 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.22, 1, 0.36, 1),
  });

  return (
    <AbsoluteFill style={{ background: L.wash, fontFamily: theme.fonts.sans }}>
      <AbsoluteFill style={{ opacity: fade }}>
        <AbsoluteFill
          style={{
            paddingLeft: theme.spacing.margin,
            paddingRight: theme.spacing.margin,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          {children}
        </AbsoluteFill>

        {brandMark ? (
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
            <span style={{ ...theme.type.meta, fontWeight: 700, color: L.faint }}>{brandMark}</span>
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
