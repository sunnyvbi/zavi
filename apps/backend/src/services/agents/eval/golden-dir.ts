
const RUNTIME_TO_GOLDEN_DIR: Readonly<Record<string, string>> = {
  engineer: "cto-engineer",
  "performance-marketer": "ads-manager",
  pm: "product-pm",
  qa: "qa-engineer",
  "growth-lead": "growth-orchestrator",
};

export const GOLDEN_DIRS: readonly string[] = [
  "ads-manager",
  "advisor",
  "chief-of-staff",
  "cto-engineer",
  "growth-orchestrator",
  "operator",
  "product-pm",
  "qa-engineer",
];

export function goldenDirForSlug(runtimeSlug: string): string {
  return RUNTIME_TO_GOLDEN_DIR[runtimeSlug] ?? runtimeSlug;
}

export function runtimeSlugForGoldenDir(dir: string): string {
  const hit = Object.entries(RUNTIME_TO_GOLDEN_DIR).find(([, d]) => d === dir);
  return hit ? hit[0] : dir;
}
