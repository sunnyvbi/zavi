export const ARTIFACT_TYPES = [
  "document",
  "spreadsheet",
  "image",
  "presentation",
  "website",
  "dashboard",
  "video",
  "file",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type ArtifactFilter = "all" | ArtifactType;

export type ArtifactSource = {
  kind: "chat" | "task";
  id: string;
  title: string;
  href: string | null;
};

export type Artifact = {
  id: string;
  run_id: string;
  title: string;
  filename: string;
  mime: string;
  type: ArtifactType;
  bytes: number;
  created_at: string;
  updated_at: string;
  preview_url: string | null;
  source: ArtifactSource;
};

export type SiteArtifact = {
  id: string;
  title: string;
  hostname: string;
  status: string;
  live_url: string | null;
  build_session_id: string | null;
  created_at: string;
  updated_at: string;
  built?: boolean;
  old_pipeline?: boolean;
};

export type ArtifactsResponse = {
  artifacts: Artifact[];
  sites?: SiteArtifact[];
  expires_in?: number;
};

export type ArtifactResponse = {
  artifact: Artifact;
};

export type SignedArtifactUrlResponse = {
  signed_url: string;
  expires_in?: number;
};
