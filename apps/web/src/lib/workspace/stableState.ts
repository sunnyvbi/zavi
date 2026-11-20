
export function sameShallow<T extends object>(a: T | null | undefined, b: T | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  const bRecord = b as Record<string, unknown>;
  const aRecord = a as Record<string, unknown>;
  return aKeys.every((k) => Object.hasOwn(bRecord, k) && Object.is(aRecord[k], bRecord[k]));
}
