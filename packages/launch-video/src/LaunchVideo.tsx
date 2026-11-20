import React from 'react';
import { Composition, Series, type CalculateMetadataFunction } from 'remotion';

import {
  type VideoBrief,
  type Beat,
  ASPECT_DIMENSIONS,
  FPS,
  beatDuration,
  totalDuration,
  validateBrief,
  sanitizeBrief,
} from './brief';
import { makeTheme } from './theme';
import { AuthoredFilm, AUTHORED_FRAMES } from './Authored';
import { Hook, Problem, Feature, Proof, Cta } from './beats';
import { ChatThread, CardWall, Metric, ProductUI, Coverage, Broll } from './scenes';

const BeatTransition: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return <>{children}</>;
};

const FALLBACK_BRIEF: VideoBrief = {
  product: { name: 'Zavi', oneLiner: 'AI cofounder team for your company', url: 'https://zaviagent.com' },
  brand: { primaryColor: '#5B6CFF', accentColor: '#22D3EE', bgColor: '#0B0E14' },
  audience: 'founders',
  tone: 'bold',
  cta: { text: 'Start free', url: 'https://zaviagent.com' },
  aspect: '16:9',
  beats: [
    { kind: 'hook', headline: 'Provide a brief to render your launch video.' },
    { kind: 'cta', headline: 'Pass --props=brief.json' },
  ],
};

export type LaunchVideoProps = VideoBrief & { [key: string]: unknown };

const renderBeat = (beat: Beat, brief: VideoBrief, theme: ReturnType<typeof makeTheme>) => {
  const brandMark = brief.product.name;
  switch (beat.kind) {
    case 'hook':
      return <Hook beat={beat} theme={theme} brandMark={brandMark} />;
    case 'problem':
      return <Problem beat={beat} theme={theme} brandMark={brandMark} />;
    case 'feature':
      return <Feature beat={beat} theme={theme} brandMark={brandMark} />;
    case 'proof':
      return <Proof beat={beat} theme={theme} brandMark={brandMark} />;
    case 'cta':
      return (
        <Cta
          beat={beat}
          theme={theme}
          productName={brief.product.name}
          ctaText={brief.cta.text}
          ctaUrl={brief.cta.url}
          logoUrl={brief.brand.logoUrl}
        />
      );
    case 'chat':
      return <ChatThread beat={beat} theme={theme} brandMark={brandMark} />;
    case 'cardwall':
      return <CardWall beat={beat} theme={theme} brandMark={brandMark} />;
    case 'metric':
      return <Metric beat={beat} theme={theme} brandMark={brandMark} />;
    case 'productui':
      return <ProductUI beat={beat} theme={theme} brandMark={brandMark} />;
    case 'coverage':
      return <Coverage beat={beat} theme={theme} brandMark={brandMark} />;
    case 'broll':
      return <Broll beat={beat} theme={theme} brandMark={brandMark} />;
    default: {
      const _never: never = beat;
      return _never;
    }
  }
};

export const LaunchVideoSequence: React.FC<LaunchVideoProps> = (props) => {
  const brief = props as unknown as VideoBrief;
  if (brief.authored) return <AuthoredFilm />;
  const theme = makeTheme(brief);
  return (
    <Series>
      {brief.beats.map((beat, i) => (
        <Series.Sequence key={i} durationInFrames={beatDuration(beat)}>
          <BeatTransition>{renderBeat(beat, brief, theme)}</BeatTransition>
        </Series.Sequence>
      ))}
    </Series>
  );
};

const calcMetadata: CalculateMetadataFunction<LaunchVideoProps> = ({ props }) => {
  const incoming = (props ?? {}) as Partial<VideoBrief>;

  if (incoming.authored) {
    if (incoming.authoredFrames != null && incoming.authoredFrames !== AUTHORED_FRAMES) {
      throw new Error(
        `authored film length mismatch: brief says ${incoming.authoredFrames}, the film exports ${AUTHORED_FRAMES}. ` +
          `The film is the source of truth; the brief must agree with it.`,
      );
    }
    const authoredDims = ASPECT_DIMENSIONS[incoming.aspect ?? '16:9'];
    return {
      width: authoredDims.width,
      height: authoredDims.height,
      fps: FPS,
      durationInFrames: AUTHORED_FRAMES,
      props: props as LaunchVideoProps,
    };
  }

  const brief = props && Array.isArray((props as any).beats) ? sanitizeBrief(validateBrief(props)) : FALLBACK_BRIEF;
  const dims = ASPECT_DIMENSIONS[brief.aspect ?? '16:9'];
  return {
    width: dims.width,
    height: dims.height,
    fps: FPS,
    durationInFrames: totalDuration(brief),
    props: brief as LaunchVideoProps,
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="LaunchVideo"
      component={LaunchVideoSequence}
      durationInFrames={totalDuration(FALLBACK_BRIEF)}
      fps={FPS}
      width={ASPECT_DIMENSIONS['16:9'].width}
      height={ASPECT_DIMENSIONS['16:9'].height}
      defaultProps={FALLBACK_BRIEF as LaunchVideoProps}
      calculateMetadata={calcMetadata}
    />
  );
};
