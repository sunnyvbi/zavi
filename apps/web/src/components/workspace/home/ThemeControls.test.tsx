import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ThemeControls,
  composeThemeRefineMessage,
  isHexColor,
  THEME_SLOTS,
} from './ThemeControls';

describe('composeThemeRefineMessage', () => {
  it('returns null when nothing is selected, so Apply stays disabled', () => {
    expect(composeThemeRefineMessage({})).toBeNull();
  });

  it('returns null when the selection is not a valid hex colour', () => {
    expect(composeThemeRefineMessage({ primary: 'rebeccapurple' })).toBeNull();
    expect(composeThemeRefineMessage({ primary: '#fff' })).toBeNull();
  });

  it('names only the slots the user actually touched', () => {
    const msg = composeThemeRefineMessage({ primary: '#ff0000' })!;
    expect(msg).toContain('the primary color to #ff0000');
    expect(msg).not.toContain('accent');
    expect(msg).not.toContain('background');
  });

  it('lists multiple chosen colours in one instruction', () => {
    const msg = composeThemeRefineMessage({
      primary: '#FF0000',
      accent: '#00FF00',
      background: '#0000FF',
    })!;
    expect(msg).toContain('the primary color to #ff0000');
    expect(msg).toContain('the accent color to #00ff00');
    expect(msg).toContain('and the background color to #0000ff');
  });

  it('scopes the refine to theme tokens and forbids behavior changes', () => {
    const msg = composeThemeRefineMessage({ primary: '#123456' })!;
    expect(msg).toContain('Update the visual theme only');
    expect(msg).toContain('Change only theme/color tokens');
    expect(msg).toContain(
      'Do not change routes, page structure, copy, data models, dependencies, or any application behavior.',
    );
  });
});

describe('isHexColor', () => {
  it('accepts the 6-digit hex that <input type="color"> emits', () => {
    expect(isHexColor('#a1b2c3')).toBe(true);
    expect(isHexColor('#A1B2C3')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isHexColor('#fff')).toBe(false);
    expect(isHexColor('red')).toBe(false);
    expect(isHexColor('')).toBe(false);
    expect(isHexColor('#12345g')).toBe(false);
  });
});

describe('ThemeControls', () => {
  it('exposes primary, accent and background', () => {
    expect(THEME_SLOTS.map((s) => s.id)).toEqual(['primary', 'accent', 'background']);
  });

  it('renders collapsed by default (inert until the user opens it)', () => {
    const html = renderToStaticMarkup(<ThemeControls onApply={() => {}} />);
    expect(html).toContain('Colors');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('type="color"');
    expect(html).not.toContain('Apply colors');
  });
});
