import type { VideoBrief, Tone, ThemeName } from './brief';
import { DEFAULT_THEME } from './brief';
import { serifFamily, groteskFamily, monoFamily } from './fonts';

export interface TypeStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: string;
  textTransform?: 'uppercase' | 'none';
}

export interface TypeScale {
  eyebrow: TypeStyle;
  h1: TypeStyle;
  section: TypeStyle;
  cardTitle: TypeStyle;
  body: TypeStyle;
  bodyLg: TypeStyle;
  meta: TypeStyle;
}

export interface LightSurface {
  wash: string;
  warm: string;
  cool: string;
  paper: string;
  card: string;
  cardSoft: string;
  ink: string;
  sub: string;
  faint: string;
  hairline: string;
  accentText: string;
  accentSoft: string;
  good: string;
  goodSoft: string;
}

export interface DarkSurface {
  bg: string;
  card: string;
  ink: string;
  sub: string;
  hairline: string;
  warmGlow: string;
  coolGlow: string;
}

export interface ShadowTokens {
  card: string;
  lift: string;
}

export interface Theme {
  fonts: { headline: string; body: string; mono: string; display: string; sans: string };
  type: TypeScale;
  light: LightSurface;
  dark: DarkSurface;
  shadow: ShadowTokens;
  brand: { accent: string; secondary: string };
  accentGradient: string;
  cardAccents: string[];
  spacing: {
    margin: number;
    gutter: number;
    maxWidth: number;
    col: number;
  };
  energy: number;
  tone: Tone;
  theme: ThemeName;
  motion: MotionProfile;
  stage: StageKind;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function mix(hex: string, t: number): string {
  const { r, g, b } = hexToRgb(hex);
  const target = t >= 0 ? 255 : 0;
  const f = Math.abs(t);
  const ch = (v: number) => Math.round(v + (target - v) * f);
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(ch(r))}${toHex(ch(g))}${toHex(ch(b))}`;
}

function blend(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t);
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(ch(A.r, B.r))}${toHex(ch(A.g, B.g))}${toHex(ch(A.b, B.b))}`;
}

export interface MotionProfile {
  snap: boolean;
  snapFrames: number;
  damping: number;
  stiffness: number;
  riseScale: number;
  idle: boolean;
}

const MOTION_BY_THEME: Record<ThemeName, MotionProfile> = {
  swiss: { snap: true, snapFrames: 5, damping: 200, stiffness: 300, riseScale: 0.55, idle: false },
  editorial: { snap: false, snapFrames: 0, damping: 200, stiffness: 90, riseScale: 1, idle: true },
  neon: { snap: false, snapFrames: 0, damping: 30, stiffness: 90, riseScale: 1.25, idle: true },
};

export type StageKind = 'light' | 'grid' | 'dark';

const STAGE_BY_THEME: Record<ThemeName, StageKind> = {
  swiss: 'grid',
  editorial: 'light',
  neon: 'dark',
};

const ENERGY_BY_TONE: Record<Tone, number> = {
  clean: 0.9,
  bold: 1.15,
  playful: 1.35,
  enterprise: 0.8,
};

function inkAccent(accent: string): string {
  let c = accent;
  for (let i = 0; i < 6 && luminance(c) > 0.52; i++) c = mix(c, -0.16);
  return c;
}

export function readableSurface(theme: Theme): LightSurface {
  if (theme.stage !== 'dark') return theme.light;
  return { ...theme.light, ink: theme.dark.ink, sub: theme.dark.sub, hairline: theme.dark.hairline };
}

export function makeTheme(brief: VideoBrief): Theme {
  const themeName: ThemeName = brief.theme ?? DEFAULT_THEME;
  const accent = brief.brand.primaryColor;
  const secondary = brief.brand.accentColor;
  const accentText = inkAccent(accent);

  const accentPale = mix(accent, 0.9);
  const warm = blend('#FBEDE4', accentPale, 0.16);
  const cool = blend('#E9F0FB', accentPale, 0.5);

  const light: LightSurface = {
    wash: `linear-gradient(126deg, ${warm} 0%, #FCFCFB 48%, ${cool} 100%)`,
    warm,
    cool,
    paper: '#F6F5F2',
    card: '#FFFFFF',
    cardSoft: '#FAFAF8',
    ink: '#101216',
    sub: '#6D7480',
    faint: '#9AA0A8',
    hairline: 'rgba(16,18,22,0.10)',
    accentText,
    accentSoft: mix(accent, 0.86),
    good: '#1F8F5F',
    goodSoft: '#E9F4EE',
  };

  const dark: DarkSurface = {
    bg: '#0E1014',
    card: '#15181E',
    ink: '#F4F5F7',
    sub: '#9BA1AC',
    hairline: 'rgba(255,255,255,0.10)',
    warmGlow: rgba('#F0A66A', 0.1),
    coolGlow: rgba(blend(accent, '#3C7DD6', 0.4), 0.16),
  };

  const shadow: ShadowTokens = {
    card: '0 18px 40px rgba(22,28,36,0.10), 0 2px 8px rgba(22,28,36,0.06)',
    lift: '0 26px 56px rgba(22,28,36,0.12), 0 3px 10px rgba(22,28,36,0.07)',
  };

  const cardAccents = [accentText, '#2FB573', '#E0991F', '#E2574C', '#7C6CE0', '#3C7DD6'];

  const margin = 130;
  const maxWidth = 1680;
  const gutter = 28;
  const col = Math.round((maxWidth - gutter * 11) / 12);

  const type: TypeScale = {
    eyebrow: {
      fontFamily: monoFamily,
      fontSize: 13,
      fontWeight: 700,
      lineHeight: 1,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
    },
    h1: {
      fontFamily: serifFamily,
      fontSize: 100,
      fontWeight: 700,
      lineHeight: 0.98,
      letterSpacing: '-0.01em',
    },
    section: {
      fontFamily: serifFamily,
      fontSize: 62,
      fontWeight: 600,
      lineHeight: 1.02,
      letterSpacing: '-0.005em',
    },
    cardTitle: {
      fontFamily: groteskFamily,
      fontSize: 29,
      fontWeight: 600,
      lineHeight: 1.08,
      letterSpacing: '-0.01em',
    },
    body: {
      fontFamily: groteskFamily,
      fontSize: 21,
      fontWeight: 400,
      lineHeight: 1.45,
      letterSpacing: '0',
    },
    bodyLg: {
      fontFamily: groteskFamily,
      fontSize: 26,
      fontWeight: 400,
      lineHeight: 1.45,
      letterSpacing: '0',
    },
    meta: {
      fontFamily: monoFamily,
      fontSize: 13,
      fontWeight: 500,
      lineHeight: 1.2,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
    },
  };

  return {
    fonts: {
      headline: serifFamily,
      body: groteskFamily,
      mono: monoFamily,
      display: groteskFamily,
      sans: groteskFamily,
    },
    type,
    light,
    dark,
    shadow,
    brand: { accent, secondary },
    accentGradient: `linear-gradient(120deg, ${accent} 0%, ${secondary} 100%)`,
    cardAccents,
    spacing: { margin, gutter, maxWidth, col },
    energy: ENERGY_BY_TONE[brief.tone],
    tone: brief.tone,
    theme: themeName,
    motion: MOTION_BY_THEME[themeName],
    stage: STAGE_BY_THEME[themeName],
  };
}

export { rgba, mix, blend, luminance, inkAccent };
