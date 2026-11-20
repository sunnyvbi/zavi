import { describe, it, expect } from 'vitest';
import { orientationFor } from '../orientation';
import { ASPECT_DIMENSIONS } from '../brief';

describe('orientationFor', () => {
  it("returns 'landscape' when width > height (the untouched 16:9 path)", () => {
    expect(orientationFor(1920, 1080)).toBe('landscape');
    expect(orientationFor(1000, 999)).toBe('landscape');
  });

  it("returns 'portrait' when height > width (9:16)", () => {
    expect(orientationFor(1080, 1920)).toBe('portrait');
    expect(orientationFor(999, 1000)).toBe('portrait');
  });

  it("returns 'square' when width === height (1:1)", () => {
    expect(orientationFor(1080, 1080)).toBe('square');
    expect(orientationFor(1, 1)).toBe('square');
  });

  it('classifies each engine ASPECT_DIMENSIONS entry to the expected orientation', () => {
    expect(orientationFor(ASPECT_DIMENSIONS['16:9'].width, ASPECT_DIMENSIONS['16:9'].height)).toBe('landscape');
    expect(orientationFor(ASPECT_DIMENSIONS['9:16'].width, ASPECT_DIMENSIONS['9:16'].height)).toBe('portrait');
    expect(orientationFor(ASPECT_DIMENSIONS['1:1'].width, ASPECT_DIMENSIONS['1:1'].height)).toBe('square');
  });
});
