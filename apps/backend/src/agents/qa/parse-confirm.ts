
const RE_ADD = /^(?:add|insert)\s+(?:all|\d+(?:\s*,\s*\d+)*)\s*$/i;
const RE_ADD_ALL = /^(?:add|insert)\s+all\s*$/i;
const RE_SKIP = /^(?:skip|none|cancel|no)\s*$/i;

export type ConfirmIntent =
  | { kind: "add_all" }
  | { kind: "add_indices"; indices: number[] }
  | { kind: "skip" }
  | { kind: "unparsable" };

export function parseConfirmTurn(message: string): ConfirmIntent {
  const trimmed = message.trim();
  if (RE_SKIP.test(trimmed)) return { kind: "skip" };
  if (!RE_ADD.test(trimmed)) return { kind: "unparsable" };
  if (RE_ADD_ALL.test(trimmed)) return { kind: "add_all" };
  const nums = trimmed.match(/\d+/g);
  if (!nums) return { kind: "unparsable" };
  const raw = nums.map((n) => parseInt(n, 10)).filter((n) => n > 0);
  if (raw.length === 0) return { kind: "unparsable" };
  const seen = new Set<number>();
  const indices = raw.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
  return { kind: "add_indices", indices };
}
