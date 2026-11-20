import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';

export const AUTHORED_FRAMES = 150;

export const AuthoredFilm: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background: '#1a1416',
        color: '#f4d4c8',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 30,
        alignItems: 'center',
        justifyContent: 'center',
        letterSpacing: '0.04em',
      }}
    >
      <div>no authored film was provided</div>
      <div style={{ marginTop: 18, fontSize: 19, opacity: 0.6 }}>frame {frame}</div>
    </AbsoluteFill>
  );
};
