
export const GROWTH_PAGE_ONLY_CLASSES = ["cgo.dispatch-specialist"] as const;

export function isGrowthPageOnlyClass(decisionClass: string): boolean {
  return (GROWTH_PAGE_ONLY_CLASSES as readonly string[]).includes(decisionClass);
}

export const GROWTH_PAGE_ONLY_NOT_IN = `(${GROWTH_PAGE_ONLY_CLASSES.map((c) => `"${c}"`).join(",")})`;
