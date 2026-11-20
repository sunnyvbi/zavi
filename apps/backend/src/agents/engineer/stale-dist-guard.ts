export type StaleDistVerdict =
  | { stale: false }
  | { stale: true; source_paths: string[]; expected_dist_paths: string[] };

const SOURCE_EXT_RE = /\.(?:ts|tsx|js|jsx)$/;

function expectedDistPath(sourcePath: string): string | null {
  const marker = "/src/";
  const index = sourcePath.indexOf(marker);
  if (index < 0 || !SOURCE_EXT_RE.test(sourcePath)) return null;
  return `${sourcePath.slice(0, index)}/dist/${sourcePath
    .slice(index + marker.length)
    .replace(/\.(?:ts|tsx|jsx)$/, ".js")}`;
}

export function detectStaleDeployedDist(args: {
  changed_paths: readonly string[];
  tracked_paths: readonly string[];
  deployment_evidence: string;
}): StaleDistVerdict {
  const deploymentUsesDist =
    /(?:node|pm2|cmd|entrypoint)[^\n]{0,160}\bdist[\\/]/i.test(
      args.deployment_evidence,
    ) ||
    /\bdist[\\/][^\n]{0,160}\b(?:deploy|committed|tracked)\b/i.test(
      args.deployment_evidence,
    );
  if (!deploymentUsesDist) return { stale: false };

  const deploymentBuildsDist =
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|\b(?:turbo|nx)\s+(?:run\s+)?build\b|\btsc\b|\b(?:next|vite|tsup|rollup|esbuild|webpack|nest)\s+build\b/i.test(
      args.deployment_evidence,
    );
  if (deploymentBuildsDist) return { stale: false };

  const tracked = new Set(args.tracked_paths);
  const changed = new Set(args.changed_paths);
  const stalePairs = args.changed_paths
    .map((source) => ({ source, dist: expectedDistPath(source) }))
    .filter(
      (pair): pair is { source: string; dist: string } =>
        Boolean(pair.dist) &&
        tracked.has(pair.dist as string) &&
        !changed.has(pair.dist as string),
    );
  if (stalePairs.length === 0) return { stale: false };
  return {
    stale: true,
    source_paths: stalePairs.map((pair) => pair.source),
    expected_dist_paths: stalePairs.map((pair) => pair.dist),
  };
}
