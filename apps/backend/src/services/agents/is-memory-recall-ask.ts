
export type MemoryRecallCategory =
  | "recall"
  | "priorities"
  | "prior-decisions"
  | "active-work";

interface PatternEntry {
  pattern: RegExp;
  category: MemoryRecallCategory;
}

const PATTERN_ENTRIES: readonly PatternEntry[] = [
  { pattern: /based on (what you know|previous conversations|our context|history)/i, category: "recall" },
  { pattern: /given (everything you know|context|history)/i, category: "recall" },
  { pattern: /what (do|have) you remember/i, category: "recall" },
  { pattern: /recap (our|the) (last|prior)/i, category: "recall" },
  { pattern: /where did we leave off/i, category: "recall" },
  { pattern: /(my|our) (top )?priorit/i, category: "priorities" },
  { pattern: /what('s| is) on my plate/i, category: "priorities" },
  { pattern: /what should I (work on|focus on|prioritize)/i, category: "priorities" },
  { pattern: /what did we decide/i, category: "prior-decisions" },
  { pattern: /remind me (about|of) (the|our)/i, category: "prior-decisions" },
  { pattern: /what('?s| is) (active|in flight|in progress)/i, category: "active-work" },
  { pattern: /where (are|were) we on/i, category: "active-work" },
];

export const MEMORY_RECALL_PATTERNS: readonly RegExp[] = PATTERN_ENTRIES.map(
  (e) => e.pattern,
);

export interface MemoryRecallMatch {
  matched: boolean;
  category?: MemoryRecallCategory;
}

export function isMemoryRecallAsk(text: string): MemoryRecallMatch {
  if (!text || typeof text !== "string") return { matched: false };
  for (const entry of PATTERN_ENTRIES) {
    if (entry.pattern.test(text)) {
      return { matched: true, category: entry.category };
    }
  }
  return { matched: false };
}
