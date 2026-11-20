import { describe, expect, it } from 'vitest';
import { makeTheme, readableSurface } from '../theme';
import { DEFAULT_THEME, validateBrief, type VideoBrief } from '../brief';

const base = {
  product: { name: 'Northbound', oneLiner: 'small-batch coffee', url: 'https://example.com' },
  brand: { primaryColor: '#1677ff', accentColor: '#12855a' },
  audience: 'founders',
  tone: 'clean',
  cta: { text: 'Start free', url: 'https://example.com' },
  beats: [{ kind: 'hook', title: 'hi' }],
} as unknown as VideoBrief;

describe('theme', () => {
  it('falls back to the default when a brief names no theme', () => {
    expect(makeTheme(base).theme).toBe(DEFAULT_THEME);
    expect(makeTheme(base).theme).toBe('editorial');
    expect(makeTheme(base).stage).toBe('light');
    expect(makeTheme(base).motion.snap).toBe(false);
  });

  it('gives each theme a genuinely different stage and motion, not just colours', () => {
    const swiss = makeTheme({ ...base, theme: 'swiss' });
    const editorial = makeTheme({ ...base, theme: 'editorial' });
    const neon = makeTheme({ ...base, theme: 'neon' });

    expect(new Set([swiss.stage, editorial.stage, neon.stage]).size).toBe(3);
    expect(swiss.motion.snap).toBe(true);
    expect(editorial.motion.snap).toBe(false);
    expect(neon.motion.snap).toBe(false);
    expect(swiss.motion.idle).toBe(false);
    expect(editorial.motion.idle).toBe(true);
    expect(neon.motion.riseScale).toBeGreaterThan(editorial.motion.riseScale);
  });

  it('keeps `editorial` byte-identical to the pre-theme spring', () => {
    const m = makeTheme({ ...base, theme: 'editorial' }).motion;
    expect(m.snap).toBe(false);
    expect(m.damping).toBe(200);
    expect(m.stiffness).toBe(90);
    expect(m.riseScale).toBe(1);
    expect(m.idle).toBe(true);
  });

  it('swaps stage text for dark themes without touching the white card fill', () => {
    const neon = makeTheme({ ...base, theme: 'neon' });
    const s = readableSurface(neon);
    expect(s.ink).toBe(neon.dark.ink);
    expect(s.sub).toBe(neon.dark.sub);
    expect(s.hairline).toBe(neon.dark.hairline);
    expect(s.card).toBe(neon.light.card);

    for (const t of ['editorial', 'swiss'] as const) {
      const th = makeTheme({ ...base, theme: t });
      expect(readableSurface(th)).toBe(th.light);
    }
  });

  it('accepts a brief with no theme and rejects only a present-but-wrong one', () => {
    expect(() => validateBrief({ ...base })).not.toThrow();
    expect(() => validateBrief({ ...base, theme: 'swiss' })).not.toThrow();
    expect(() => validateBrief({ ...base, theme: 'vaporwave' })).toThrow(/theme must be one of/);
  });
});
