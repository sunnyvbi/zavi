
const fired = new WeakSet<object>();

export function claimComposerSeed(seed: object): boolean {
  if (fired.has(seed)) return false;
  fired.add(seed);
  return true;
}

export function isComposerSeedClaimed(seed: object): boolean {
  return fired.has(seed);
}
