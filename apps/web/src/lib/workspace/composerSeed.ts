
export function composerSeedKey(agentSlug: string): string {
  return `praxis:refine-seed:${agentSlug}`;
}

export function stageComposerSeed(agentSlug: string, text: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(composerSeedKey(agentSlug), text);
    return true;
  } catch {
    return false;
  }
}
