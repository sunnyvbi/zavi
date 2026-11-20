import {
  detectCarriedConstants,
  type CarriedConstantDetection,
  type FileDiffInput,
  type SandboxRunner,
} from "./helper-detection";
import { detectStaleCommittedDist, type StaleDistHit } from "./stale-committed-dist";

export type SandboxDetections = {
  carried: PromiseSettledResult<CarriedConstantDetection>;
  stale: PromiseSettledResult<StaleDistHit[]>;
};

export async function runSandboxDetections(opts: {
  files: FileDiffInput[];
  run: SandboxRunner;
  repo_root?: string;
}): Promise<SandboxDetections> {
  const shared = {
    files: opts.files,
    run: opts.run,
    ...(opts.repo_root ? { repo_root: opts.repo_root } : {}),
  };
  const [carried, stale] = await Promise.allSettled([
    detectCarriedConstants(shared),
    detectStaleCommittedDist(shared),
  ]);
  return { carried, stale };
}
