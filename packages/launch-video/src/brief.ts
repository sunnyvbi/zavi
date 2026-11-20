
export type Tone = 'clean' | 'bold' | 'playful' | 'enterprise';

export type ThemeName = 'swiss' | 'editorial' | 'neon';

export const DEFAULT_THEME: ThemeName = 'editorial';

export type Aspect = '16:9' | '1:1' | '9:16';

export type BeatKind =
  | 'hook'
  | 'problem'
  | 'feature'
  | 'proof'
  | 'cta'
  | 'chat'
  | 'cardwall'
  | 'metric'
  | 'productui'
  | 'coverage'
  | 'broll';

export interface BeatVO {
  audioFile?: string;
  srtText?: string;
}

interface BeatBase {
  headline?: string;
  sub?: string;
  durationFrames?: number;
  vo?: BeatVO;
}

export interface HookBeat extends BeatBase {
  kind: 'hook';
  image?: string;
}

export interface ProblemBeat extends BeatBase {
  kind: 'problem';
}

export interface FeatureBeat extends BeatBase {
  kind: 'feature';
  icon?: string;
  glyph?: string;
}

export interface ProofBeat extends BeatBase {
  kind: 'proof';
  stat?: string;
  statLabel?: string;
}

export interface CtaBeat extends BeatBase {
  kind: 'cta';
  chips?: string[];
}

export type StatusDot = 'green' | 'amber' | 'red' | 'blue';

export interface ChatMessage {
  speaker: string;
  monogram?: string;
  accent?: string;
  mention?: string;
  body?: string;
  reply?: {
    badge?: string;
    role?: string;
    statusDot?: StatusDot;
    body: string;
  };
}

export interface ChatBeat extends BeatBase {
  kind: 'chat';
  eyebrow?: string;
  messages: ChatMessage[];
}

export interface WallCard {
  label: string;
  accent: string;
  headline: string;
  body?: string;
  footer?: string;
  pill?: string;
}

export interface CardWallBeat extends BeatBase {
  kind: 'cardwall';
  eyebrow?: string;
  cards: WallCard[];
}

export interface MetricItem {
  stat: string;
  label: string;
  series?: number[];
  delta?: { dir: 'up' | 'down' | 'flat'; text: string };
}

export interface MetricBeat extends BeatBase {
  kind: 'metric';
  eyebrow?: string;
  metrics?: MetricItem[];
  stat?: string;
  label?: string;
  series?: number[];
}

export interface ProductUIItem {
  glyph?: string;
  image?: string;
  title: string;
  chips: string[];
}

export interface ProductUIBeat extends BeatBase {
  kind: 'productui';
  eyebrow?: string;
  header?: {
    title: string;
    searchPlaceholder?: string;
  };
  domain?: string;
  items: ProductUIItem[];
}

export interface CoverageBeat extends BeatBase {
  kind: 'coverage';
  eyebrow?: string;
  regions: string[];
}

export interface BrollBeat extends BeatBase {
  kind: 'broll';
  eyebrow?: string;
  video: string;
}

export type Beat =
  | HookBeat
  | ProblemBeat
  | FeatureBeat
  | ProofBeat
  | CtaBeat
  | ChatBeat
  | CardWallBeat
  | MetricBeat
  | ProductUIBeat
  | CoverageBeat
  | BrollBeat;

export interface Brand {
  primaryColor: string;
  accentColor: string;
  bgColor?: string;
  logoUrl?: string;
}

export interface Product {
  name: string;
  oneLiner: string;
  url: string;
}

export interface Cta {
  text: string;
  url: string;
}

export interface Music {
  file?: string;
}

export interface VideoBrief {
  product: Product;
  brand: Brand;
  audience: string;
  tone: Tone;
  theme?: ThemeName;
  cta: Cta;
  aspect?: Aspect;
  beats: Beat[];
  music?: Music;
  authored?: boolean;
  authoredFrames?: number;
}

export const ASPECT_DIMENSIONS: Record<Aspect, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
};

export const FPS = 30;

export const DEFAULT_BEAT_FRAMES: Record<BeatKind, number> = {
  hook: 120,
  problem: 132,
  feature: 132,
  proof: 132,
  cta: 120,
  chat: 162,
  cardwall: 132,
  metric: 156,
  productui: 162,
  coverage: 132,
  broll: 180,
};

const BEAT_KINDS: BeatKind[] = [
  'hook',
  'problem',
  'feature',
  'proof',
  'cta',
  'chat',
  'cardwall',
  'metric',
  'productui',
  'coverage',
  'broll',
];
const TONES: Tone[] = ['clean', 'bold', 'playful', 'enterprise'];
const THEMES: ThemeName[] = ['swiss', 'editorial', 'neon'];
const ASPECTS: Aspect[] = ['16:9', '1:1', '9:16'];

export function beatDuration(beat: Beat): number {
  return beat.durationFrames && beat.durationFrames > 0
    ? Math.round(beat.durationFrames)
    : DEFAULT_BEAT_FRAMES[beat.kind];
}

export function totalDuration(brief: VideoBrief): number {
  return Math.max(1, brief.beats.reduce((sum, b) => sum + beatDuration(b), 0));
}

function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}

export function stripDashes(s: string): string {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\s*[—―]\s*/g, ', ')
    .replace(/,\s*,/g, ', ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*([.!?;:])/g, '$1')
    .trim();
}

export function sanitizeBrief<T>(x: T): T {
  if (typeof x === 'string') return stripDashes(x) as unknown as T;
  if (Array.isArray(x)) return x.map((v) => sanitizeBrief(v)) as unknown as T;
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>)) {
      out[k] = sanitizeBrief((x as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return x;
}

export function validateBrief(x: unknown): VideoBrief {
  if (!x || typeof x !== 'object') throw new Error('VideoBrief: must be an object');
  const b = x as Record<string, any>;

  if (!b.product || typeof b.product !== 'object') throw new Error('VideoBrief.product is required');
  if (!b.product.name) throw new Error('VideoBrief.product.name is required');
  if (!b.product.oneLiner) throw new Error('VideoBrief.product.oneLiner is required');
  if (!b.product.url) throw new Error('VideoBrief.product.url is required');

  if (!b.brand || typeof b.brand !== 'object') throw new Error('VideoBrief.brand is required');
  if (!isHex(b.brand.primaryColor)) throw new Error('VideoBrief.brand.primaryColor must be a hex color');
  if (!isHex(b.brand.accentColor)) throw new Error('VideoBrief.brand.accentColor must be a hex color');
  if (b.brand.bgColor !== undefined && !isHex(b.brand.bgColor)) {
    throw new Error('VideoBrief.brand.bgColor must be a hex color if provided');
  }

  if (!b.audience || typeof b.audience !== 'string') throw new Error('VideoBrief.audience is required');
  if (!TONES.includes(b.tone)) throw new Error(`VideoBrief.tone must be one of ${TONES.join('|')}`);
  if (b.theme !== undefined && !THEMES.includes(b.theme as ThemeName)) {
    throw new Error(`VideoBrief.theme must be one of ${THEMES.join('|')}`);
  }

  if (!b.cta || typeof b.cta !== 'object') throw new Error('VideoBrief.cta is required');
  if (!b.cta.text) throw new Error('VideoBrief.cta.text is required');
  if (!b.cta.url) throw new Error('VideoBrief.cta.url is required');

  if (b.aspect !== undefined && !ASPECTS.includes(b.aspect)) {
    throw new Error(`VideoBrief.aspect must be one of ${ASPECTS.join('|')}`);
  }

  if (!Array.isArray(b.beats) || b.beats.length === 0) {
    throw new Error('VideoBrief.beats must be a non-empty array');
  }
  b.beats.forEach((beat: any, i: number) => {
    if (!beat || typeof beat !== 'object') throw new Error(`beats[${i}] must be an object`);
    if (!BEAT_KINDS.includes(beat.kind)) {
      throw new Error(`beats[${i}].kind must be one of ${BEAT_KINDS.join('|')}`);
    }
    if (beat.durationFrames !== undefined && (typeof beat.durationFrames !== 'number' || beat.durationFrames <= 0)) {
      throw new Error(`beats[${i}].durationFrames must be a positive number if provided`);
    }
    if (beat.kind === 'chat' && !Array.isArray(beat.messages)) {
      throw new Error(`beats[${i}] (chat) requires a messages[] array`);
    }
    if (beat.kind === 'cardwall' && !Array.isArray(beat.cards)) {
      throw new Error(`beats[${i}] (cardwall) requires a cards[] array`);
    }
    if (beat.kind === 'metric' && !Array.isArray(beat.metrics) && !beat.stat) {
      throw new Error(`beats[${i}] (metric) requires either metrics[] or a stat`);
    }
    if (beat.kind === 'productui' && (!Array.isArray(beat.items) || beat.items.length === 0)) {
      throw new Error(`beats[${i}] (productui) requires a non-empty items[] array`);
    }
    if (beat.kind === 'coverage' && (!Array.isArray(beat.regions) || beat.regions.length === 0)) {
      throw new Error(`beats[${i}] (coverage) requires a non-empty regions[] array`);
    }
    if (beat.kind === 'broll' && (typeof beat.video !== 'string' || !beat.video)) {
      throw new Error(`beats[${i}] (broll) requires a video filename`);
    }
  });

  return x as VideoBrief;
}
