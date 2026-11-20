export type Orientation = 'landscape' | 'portrait' | 'square';

export function orientationFor(width: number, height: number): Orientation {
  if (width > height) return 'landscape';
  if (height > width) return 'portrait';
  return 'square';
}
