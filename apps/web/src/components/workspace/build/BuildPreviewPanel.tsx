import type { BuildFailure, BuildPreviewKind, BuildStageRow } from "@/lib/workspace/useBuildPreview";
import type { BuildStatus } from "@/lib/workspace/useBuildProduct";

export type BuildPreviewProgress = {
  stages: BuildStageRow[];
  failure: BuildFailure | null;
  failed: boolean;
};

export type BuildPreviewTarget = {
  url: string;
  appName: string;
  kind: BuildPreviewKind;
  status: BuildStatus;
  objective: string | null;
  repoUrl?: string | null;
  revision?: string;
};
