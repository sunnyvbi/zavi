import React from 'react';
import { AbsoluteFill, OffthreadVideo, staticFile, interpolate, useCurrentFrame } from 'remotion';
import type { BrollBeat } from '../brief';
import type { Theme } from '../theme';
import { SOFT_EASE } from './kit';

export const Broll: React.FC<{ beat: BrollBeat; theme: Theme; brandMark?: string }> = ({ beat, theme }) => {
  const frame = useCurrentFrame();
  const D = theme.dark;
  const titleIn = interpolate(frame, [10, 32], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: SOFT_EASE,
  });

  return (
    <AbsoluteFill style={{ background: D.bg, fontFamily: theme.fonts.body, overflow: 'hidden' }}>
      <OffthreadVideo
        src={staticFile(beat.video)}
        muted
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />
      {}
      <AbsoluteFill
        style={{
          background: 'linear-gradient(0deg, rgba(8,10,14,0.86) 0%, rgba(8,10,14,0.18) 42%, rgba(8,10,14,0) 70%)',
        }}
      />
      {(beat.eyebrow || beat.headline) && (
        <div
          style={{
            position: 'absolute',
            left: theme.spacing.margin,
            right: theme.spacing.margin,
            bottom: 96,
            opacity: titleIn,
            transform: `translateY(${(1 - titleIn) * 14}px)`,
          }}
        >
          {beat.eyebrow && (
            <div style={{ ...theme.type.eyebrow, color: theme.brand.accent, marginBottom: 14 }}>{beat.eyebrow}</div>
          )}
          {beat.headline && (
            <h2 style={{ ...theme.type.section, margin: 0, color: '#FFFFFF', maxWidth: 1320 }}>{beat.headline}</h2>
          )}
        </div>
      )}
    </AbsoluteFill>
  );
};
