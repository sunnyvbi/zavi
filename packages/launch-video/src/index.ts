import { registerRoot } from 'remotion';
import { RemotionRoot } from './LaunchVideo';

registerRoot(RemotionRoot);

export { RemotionRoot, LaunchVideoSequence } from './LaunchVideo';
export type { LaunchVideoProps } from './LaunchVideo';
export * from './brief';
export { Glyph, Monogram, glyphFor, monogramOf, type GlyphName } from './glyphs';
export { ChatThread, CardWall, Metric, ProductUI, Coverage, LightStage } from './scenes';
