export const PLATFORM_SOURCE_REPO = "rravi149/zavi" as const;

const PLATFORM_SOURCE_REPO_NAMES: readonly string[] = [PLATFORM_SOURCE_REPO, "rravi149/praxis"];

export function isPlatformSourceRepo(owner: string, repo: string): boolean {
  const norm = (s: string): string =>
    s
      .trim()
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  const target = `${norm(owner)}/${norm(repo)}`;
  return PLATFORM_SOURCE_REPO_NAMES.some((name) => name.toLowerCase() === target);
}
