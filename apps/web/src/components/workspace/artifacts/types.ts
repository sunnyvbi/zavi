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
export type ArtifactView = "grid" | "list";

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
  source: {
    kind: "chat" | "task";
    id: string;
    title: string;
    href: string | null;
  };
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
  thumbnail_url?: string | null;
};

export type ArtifactsResponse = {
  artifacts: Artifact[];
  sites?: SiteArtifact[];
  expires_in?: number;
};

export function isArtifactFilter(value: string | null): value is ArtifactFilter {
  return value === "all" || ARTIFACT_TYPES.some((type) => type === value);
}

export function artifactTypeLabel(type: ArtifactType): string {
  if (type === "presentation") return "Slides";
  return type.charAt(0).toUpperCase() + type.slice(1);
}
